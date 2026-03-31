#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const ROOT = '/app/fto';
const DEFAULT_PATENTS = path.join(ROOT, 'data_sources', 'patents.jsonl');
const DEFAULT_QUERIES = path.join(ROOT, 'data_sources', 'queries.jsonl');
const DEFAULT_QRELS = path.join(ROOT, 'data_sources', 'qrels.jsonl');

function parseArgs(argv) {
  const args = { k: 5, patents: DEFAULT_PATENTS, queries: DEFAULT_QUERIES, qrels: DEFAULT_QRELS, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--k') args.k = Number(argv[++i] || '5');
    else if (a === '--patents') args.patents = argv[++i] || DEFAULT_PATENTS;
    else if (a === '--queries') args.queries = argv[++i] || DEFAULT_QUERIES;
    else if (a === '--qrels') args.qrels = argv[++i] || DEFAULT_QRELS;
    else if (a === '--verbose') args.verbose = true;
  }
  if (!Number.isFinite(args.k) || args.k <= 0) args.k = 5;
  return args;
}

function readJsonl(filePath) {
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
    .split(/[\s,，。；;：:、|/\\()\[\]{}<>_+\-=*&#@!?'\"]+/)
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

function rankPatents(patents, query, k) {
  const tokens = splitQuery(query);
  if (tokens.length === 0) return [];
  const queryVec = buildSemanticVector(query);

  const ranked = [];
  let maxLex = 0;
  let maxSem = 0;

  for (const p of patents) {
    const { lexical, semantic } = scorePatent(p, tokens, queryVec);
    if (lexical === 0 && semantic === 0) continue;
    ranked.push({ p, lexical, semantic, fusion: 0 });
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

function recallAtK(pred, relSet) {
  if (relSet.size === 0) return 0;
  let hit = 0;
  for (const id of pred) if (relSet.has(id)) hit += 1;
  return hit / relSet.size;
}

function mrrAtK(pred, relSet) {
  for (let i = 0; i < pred.length; i++) {
    if (relSet.has(pred[i])) return 1 / (i + 1);
  }
  return 0;
}

function dcgAtK(pred, relMap) {
  let sum = 0;
  for (let i = 0; i < pred.length; i++) {
    const rel = relMap.get(pred[i]) || 0;
    const gain = Math.pow(2, rel) - 1;
    const discount = Math.log2(i + 2);
    sum += gain / discount;
  }
  return sum;
}

function ndcgAtK(pred, relMap, k) {
  const dcg = dcgAtK(pred, relMap);
  const ideal = Array.from(relMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map((x) => x[0]);
  const idcg = dcgAtK(ideal, relMap);
  if (idcg === 0) return 0;
  return dcg / idcg;
}

function main() {
  const args = parseArgs(process.argv);
  const patents = readJsonl(args.patents);
  const queries = readJsonl(args.queries);
  const qrels = readJsonl(args.qrels);

  const relByQ = new Map();
  for (const r of qrels) {
    const qid = String(r.query_id);
    const pid = String(r.patent_id);
    const rel = Number(r.relevance || 0);
    if (!relByQ.has(qid)) relByQ.set(qid, new Map());
    relByQ.get(qid).set(pid, rel);
  }

  const rows = [];
  for (const q of queries) {
    const qid = String(q.query_id);
    const query = String(q.query || '');
    const pred = rankPatents(patents, query, args.k);
    const relMap = relByQ.get(qid) || new Map();
    const relSet = new Set(Array.from(relMap.entries()).filter((x) => x[1] > 0).map((x) => x[0]));

    const r = {
      query_id: qid,
      recall: recallAtK(pred, relSet),
      mrr: mrrAtK(pred, relSet),
      ndcg: ndcgAtK(pred, relMap, args.k),
      topk: pred,
    };
    rows.push(r);
  }

  const avg = (key) => (rows.length ? rows.reduce((s, r) => s + r[key], 0) / rows.length : 0);

  console.log(`Eval@${args.k}`);
  console.log(`queries=${rows.length}`);
  console.log(`Recall@${args.k}=${avg('recall').toFixed(4)}`);
  console.log(`MRR@${args.k}=${avg('mrr').toFixed(4)}`);
  console.log(`NDCG@${args.k}=${avg('ndcg').toFixed(4)}`);

  if (args.verbose) {
    console.log('--- per-query ---');
    for (const r of rows) {
      console.log(`${r.query_id}: recall=${r.recall.toFixed(4)} mrr=${r.mrr.toFixed(4)} ndcg=${r.ndcg.toFixed(4)} topk=${r.topk.join(',')}`);
    }
  }
}

try {
  main();
} catch (e) {
  console.error(`[error] ${e.message}`);
  process.exit(1);
}
