import fs from 'fs';

export function readJsonl(filePath) {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').map((x) => x.trim()).filter(Boolean);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (e) {
      throw new Error(`Invalid JSONL at ${filePath}:${i + 1}: ${e.message}`);
    }
  });
}

function normalize(s) {
  return String(s || '').toLowerCase().trim();
}

function uniqueTokens(tokens) {
  const out = [];
  const seen = new Set();
  for (const tRaw of tokens) {
    const t = normalize(tRaw);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function splitQuery(query) {
  const q = normalize(query);
  if (!q) return [];
  const tokens = [q];
  const parts = q.split(/[\s,，。；;：:、|/\\()\[\]{}<>]+/).filter((x) => [...x].length >= 2);
  tokens.push(...parts);
  return uniqueTokens(tokens);
}

function containsAny(haystack, tokens) {
  const h = normalize(haystack);
  let score = 0;
  const matched = [];
  for (const t of tokens) {
    if (h.includes(t)) {
      score += 1;
      matched.push(t);
    }
  }
  return { score, matched };
}

function splitWords(text) {
  const t = normalize(text);
  if (!t) return [];
  return t
    .split(/[\s,，。；;：:、|/\\()\[\]{}<>_+\-=*&#@!?\'\"]+/)
    .filter((x) => [...x].length >= 2);
}

function isCJK(ch) {
  const cp = ch.codePointAt(0);
  return cp >= 0x4e00 && cp <= 0x9fff;
}

function cjkBigrams(text) {
  const runes = Array.from(normalize(text));
  const out = [];
  for (let i = 0; i < runes.length - 1; i++) {
    if (!isCJK(runes[i]) || !isCJK(runes[i + 1])) continue;
    out.push(runes[i] + runes[i + 1]);
  }
  return out;
}

function buildSemanticVector(text) {
  const vec = new Map();
  for (const token of splitWords(text)) {
    vec.set(token, (vec.get(token) || 0) + 1);
  }
  for (const bg of cjkBigrams(text)) {
    vec.set(bg, (vec.get(bg) || 0) + 1);
  }
  return vec;
}

function cosineSim(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, va] of a.entries()) {
    na += va * va;
    if (b.has(k)) dot += va * b.get(k);
  }
  for (const vb of b.values()) nb += vb * vb;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function uniqSorted(tokens) {
  return Array.from(new Set(tokens)).sort();
}

function scorePatent(rec, tokens, queryVec) {
  const titleRes = containsAny(rec.title, tokens);
  const absRes = containsAny(rec.abstract, tokens);
  const claimRes = containsAny(rec.claim, tokens);

  let keywordHits = 0;
  const keywordMatched = [];
  const kws = Array.isArray(rec.keywords) ? rec.keywords : [];
  for (const kw of kws) {
    const kwN = normalize(kw);
    for (const t of tokens) {
      if (kwN.includes(t) || t.includes(kwN)) {
        keywordHits += 1;
        keywordMatched.push(t);
      }
    }
  }

  const lexical = titleRes.score * 4 + absRes.score * 2 + claimRes.score * 3 + keywordHits * 2;
  const docText = `${rec.title || ''} ${rec.abstract || ''} ${rec.claim || ''} ${kws.join(' ')}`;
  const semantic = cosineSim(queryVec, buildSemanticVector(docText));
  const matched = uniqSorted([...titleRes.matched, ...absRes.matched, ...claimRes.matched, ...keywordMatched]);

  return { lexical, semantic, matched };
}

export function rankPatentsDualRecall(patents, query, k) {
  const tokens = splitQuery(query);
  if (tokens.length === 0) return [];
  const queryVec = buildSemanticVector(query);

  const ranked = [];
  let maxLex = 0;
  let maxSem = 0;

  for (const p of patents) {
    const { lexical, semantic, matched } = scorePatent(p, tokens, queryVec);
    if (lexical === 0 && semantic === 0) continue;
    ranked.push({ p, lexical, semantic, matched, fusion: 0 });
    if (lexical > maxLex) maxLex = lexical;
    if (semantic > maxSem) maxSem = semantic;
  }

  if (ranked.length === 0) return [];

  for (const item of ranked) {
    const lexNorm = maxLex > 0 ? item.lexical / maxLex : 0;
    const semNorm = maxSem > 0 ? item.semantic / maxSem : 0;
    item.fusion = lexNorm * 0.65 + semNorm * 0.35;
  }

  const idxLex = [...ranked.keys()].sort((a, b) => ranked[b].lexical - ranked[a].lexical);
  const idxSem = [...ranked.keys()].sort((a, b) => ranked[b].semantic - ranked[a].semantic);

  let recallDepth = k * 3;
  if (recallDepth < 6) recallDepth = 6;
  if (recallDepth > ranked.length) recallDepth = ranked.length;

  const candidateIdx = new Set();
  for (let i = 0; i < recallDepth; i++) {
    if (ranked[idxLex[i]].lexical > 0) candidateIdx.add(idxLex[i]);
    if (ranked[idxSem[i]].semantic > 0) candidateIdx.add(idxSem[i]);
  }

  let fused = [...candidateIdx].map((i) => ranked[i]);
  if (fused.length === 0) fused = ranked.slice();

  fused.sort((a, b) => {
    if (b.fusion !== a.fusion) return b.fusion - a.fusion;
    return b.lexical - a.lexical;
  });

  return fused.slice(0, k).map((x) => String(x.p.patent_id));
}
