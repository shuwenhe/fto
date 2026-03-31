#!/usr/bin/env node

import path from 'path';
import fs from 'fs';
import { readJsonl } from './lib/retrieval_ranker.mjs';

const ROOT = '/app/fto';
const DEFAULT_PATENTS = path.join(ROOT, 'data_sources', 'patents.jsonl');
const DEFAULT_QUERIES = path.join(ROOT, 'data_sources', 'queries.jsonl');
const DEFAULT_QRELS = path.join(ROOT, 'data_sources', 'qrels.jsonl');
const DEFAULT_MODEL = path.join(ROOT, 'model_artifacts', 'fto_ranker_neurx_v1.json');

const FEATURE_NAMES = [
  'title_score',
  'abstract_score',
  'claim_score',
  'keyword_hits',
  'matched_count',
  'token_count',
  'lexical_score',
  'semantic_score',
  'lexical_norm',
  'semantic_norm',
];

function parseArgs(argv) {
  const args = {
    k: 5,
    deepTopN: 8,
    deepMixAlpha: 0.35,
    patents: DEFAULT_PATENTS,
    queries: DEFAULT_QUERIES,
    qrels: DEFAULT_QRELS,
    model: DEFAULT_MODEL,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--k') args.k = Number(argv[++i] || '5');
    else if (a === '--deep-top-n') args.deepTopN = Number(argv[++i] || '8');
    else if (a === '--deep-mix-alpha') args.deepMixAlpha = Number(argv[++i] || '0.35');
    else if (a === '--patents') args.patents = argv[++i] || DEFAULT_PATENTS;
    else if (a === '--queries') args.queries = argv[++i] || DEFAULT_QUERIES;
    else if (a === '--qrels') args.qrels = argv[++i] || DEFAULT_QRELS;
    else if (a === '--model') args.model = argv[++i] || DEFAULT_MODEL;
    else if (a === '--verbose') args.verbose = true;
  }
  if (!Number.isFinite(args.k) || args.k <= 0) args.k = 5;
  if (!Number.isFinite(args.deepTopN) || args.deepTopN <= 0) args.deepTopN = 8;
  if (!Number.isFinite(args.deepMixAlpha)) args.deepMixAlpha = 0.35;
  if (args.deepMixAlpha < 0) args.deepMixAlpha = 0;
  if (args.deepMixAlpha > 1) args.deepMixAlpha = 1;
  return args;
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
  for (const token of splitWords(text)) vec.set(token, (vec.get(token) || 0) + 1);
  for (const bg of cjkBigrams(text)) vec.set(bg, (vec.get(bg) || 0) + 1);
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

function sigmoid(v) {
  if (v >= 0) {
    const z = Math.exp(-v);
    return 1 / (1 + z);
  }
  const z = Math.exp(v);
  return z / (1 + z);
}

function buildCandidates(patents, query) {
  const tokens = splitQuery(query);
  if (tokens.length === 0) return [];
  const queryVec = buildSemanticVector(query);

  const rows = [];
  let maxLex = 0;
  let maxSem = 0;
  for (const rec of patents) {
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
    const text = `${rec.title || ''} ${rec.abstract || ''} ${rec.claim || ''} ${kws.join(' ')}`;
    const semantic = cosineSim(queryVec, buildSemanticVector(text));
    if (lexical <= 0 && semantic <= 0) continue;

    const matched = Array.from(new Set([...titleRes.matched, ...absRes.matched, ...claimRes.matched, ...keywordMatched]));
    rows.push({
      patent_id: String(rec.patent_id),
      lexical,
      semantic,
      title_score: titleRes.score,
      abstract_score: absRes.score,
      claim_score: claimRes.score,
      keyword_hits: keywordHits,
      matched_count: matched.length,
      token_count: tokens.length,
    });
    if (lexical > maxLex) maxLex = lexical;
    if (semantic > maxSem) maxSem = semantic;
  }

  for (const row of rows) {
    row.lexical_norm = maxLex > 0 ? row.lexical / maxLex : 0;
    row.semantic_norm = maxSem > 0 ? row.semantic / maxSem : 0;
    row.features = [
      row.title_score,
      row.abstract_score,
      row.claim_score,
      row.keyword_hits,
      row.matched_count,
      row.token_count,
      row.lexical,
      row.semantic,
      row.lexical_norm,
      row.semantic_norm,
    ];
  }
  return rows;
}

function loadModel(modelPath) {
  const model = JSON.parse(fs.readFileSync(modelPath, 'utf-8'));
  if (!Array.isArray(model.feature_names) || model.feature_names.length !== FEATURE_NAMES.length) {
    throw new Error('invalid model: feature_names mismatch');
  }
  if (!Array.isArray(model.weights) || model.weights.length !== FEATURE_NAMES.length) {
    throw new Error('invalid model: weights mismatch');
  }
  return model;
}

function linearScore(model, features) {
  let sum = Number(model.bias || 0);
  for (let i = 0; i < features.length; i++) {
    let std = Number(model.feature_stds[i] || 1);
    if (Math.abs(std) < 1e-9) std = 1;
    const mean = Number(model.feature_means[i] || 0);
    sum += ((features[i] - mean) / std) * Number(model.weights[i] || 0);
  }
  const act = String(model.activation || 'sigmoid').toLowerCase();
  return act === 'sigmoid' ? sigmoid(sum) : sum;
}

function deepScore(row) {
  const lex = row.lexical_norm;
  const sem = row.semantic_norm;
  const matchedDensity = row.token_count > 0 ? Math.min(1, row.matched_count / row.token_count) : 0;
  const kwNorm = Math.min(1, row.keyword_hits / 4);
  const claimNorm = Math.min(1, row.claim_score / 3);
  const lenPenalty = Math.min(1, row.token_count / 12);

  const h1 = Math.tanh(1.2 * sem + 0.8 * lex + 0.6 * matchedDensity - 0.2 * lenPenalty);
  const h2 = Math.tanh(1.4 * sem * matchedDensity + 0.5 * kwNorm + 0.3 * claimNorm);
  return sigmoid(1.1 * h1 + 0.9 * h2 + 0.7 * sem + 0.3 * lex - 0.2);
}

function rankLinear(model, patents, query, k) {
  const rows = buildCandidates(patents, query);
  for (const row of rows) row.score = linearScore(model, row.features);
  rows.sort((a, b) => b.score - a.score || b.lexical - a.lexical);
  return rows.slice(0, k).map((x) => x.patent_id);
}

function rankLinearPlusDeep(model, patents, query, k, deepTopN, deepMixAlpha) {
  const rows = buildCandidates(patents, query);
  for (const row of rows) row.score = linearScore(model, row.features);
  rows.sort((a, b) => b.score - a.score || b.lexical - a.lexical);

  const topN = Math.min(Math.max(1, deepTopN), rows.length);
  for (let i = 0; i < topN; i++) {
    const ds = deepScore(rows[i]);
    rows[i].score = (1 - deepMixAlpha) * rows[i].score + deepMixAlpha * ds;
  }
  rows.sort((a, b) => b.score - a.score || b.lexical - a.lexical);
  return rows.slice(0, k).map((x) => x.patent_id);
}

function recallAtK(pred, relSet) {
  if (relSet.size === 0) return 0;
  let hit = 0;
  for (const id of pred) if (relSet.has(id)) hit += 1;
  return hit / relSet.size;
}

function mrrAtK(pred, relSet) {
  for (let i = 0; i < pred.length; i++) if (relSet.has(pred[i])) return 1 / (i + 1);
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
  const ideal = Array.from(relMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, k).map((x) => x[0]);
  const idcg = dcgAtK(ideal, relMap);
  if (idcg === 0) return 0;
  return dcg / idcg;
}

function pct(values, p) {
  if (!values.length) return 0;
  const arr = values.slice().sort((a, b) => a - b);
  const idx = Math.min(arr.length - 1, Math.floor((p / 100) * arr.length));
  return arr[idx];
}

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function evalRanker(queries, relByQ, rankFn) {
  const rows = [];
  const latenciesMs = [];
  for (const q of queries) {
    const qid = String(q.query_id);
    const query = String(q.query || '');
    const start = process.hrtime.bigint();
    const pred = rankFn(query);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    latenciesMs.push(elapsedMs);

    const relMap = relByQ.get(qid) || new Map();
    const relSet = new Set(Array.from(relMap.entries()).filter((x) => x[1] > 0).map((x) => x[0]));
    rows.push({
      query_id: qid,
      recall: recallAtK(pred, relSet),
      mrr: mrrAtK(pred, relSet),
      ndcg: ndcgAtK(pred, relMap, pred.length),
      topk: pred,
      latency_ms: elapsedMs,
    });
  }
  const metricAvg = (key) => (rows.length ? rows.reduce((s, r) => s + r[key], 0) / rows.length : 0);
  return {
    queries: rows.length,
    recall: metricAvg('recall'),
    mrr: metricAvg('mrr'),
    ndcg: metricAvg('ndcg'),
    latency_avg_ms: avg(latenciesMs),
    latency_p95_ms: pct(latenciesMs, 95),
    rows,
  };
}

function printReport(name, k, result) {
  console.log(`[${name}]`);
  console.log(`queries=${result.queries}`);
  console.log(`Recall@${k}=${result.recall.toFixed(4)}`);
  console.log(`MRR@${k}=${result.mrr.toFixed(4)}`);
  console.log(`NDCG@${k}=${result.ndcg.toFixed(4)}`);
  console.log(`Latency(avg ms)=${result.latency_avg_ms.toFixed(3)}`);
  console.log(`Latency(p95 ms)=${result.latency_p95_ms.toFixed(3)}`);
}

function main() {
  const args = parseArgs(process.argv);
  const model = loadModel(args.model);
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

  const linear = evalRanker(queries, relByQ, (query) => rankLinear(model, patents, query, args.k));
  const linearDeep = evalRanker(
    queries,
    relByQ,
    (query) => rankLinearPlusDeep(model, patents, query, args.k, args.deepTopN, args.deepMixAlpha),
  );

  printReport('linear', args.k, linear);
  console.log('');
  printReport(`linear+deep(topN=${args.deepTopN},alpha=${args.deepMixAlpha.toFixed(2)})`, args.k, linearDeep);

  console.log('');
  console.log('[delta deep - linear]');
  console.log(`Recall@${args.k}=${(linearDeep.recall - linear.recall).toFixed(4)}`);
  console.log(`MRR@${args.k}=${(linearDeep.mrr - linear.mrr).toFixed(4)}`);
  console.log(`NDCG@${args.k}=${(linearDeep.ndcg - linear.ndcg).toFixed(4)}`);
  console.log(`Latency(avg ms)=${(linearDeep.latency_avg_ms - linear.latency_avg_ms).toFixed(3)}`);
  console.log(`Latency(p95 ms)=${(linearDeep.latency_p95_ms - linear.latency_p95_ms).toFixed(3)}`);

  if (args.verbose) {
    console.log('');
    console.log('--- per-query (linear vs linear+deep) ---');
    for (let i = 0; i < linear.rows.length; i++) {
      const a = linear.rows[i];
      const b = linearDeep.rows[i];
      console.log(
        `${a.query_id}: linear[topk=${a.topk.join(',')}] deep[topk=${b.topk.join(',')}] ` +
          `recall=${a.recall.toFixed(4)}->${b.recall.toFixed(4)} ` +
          `mrr=${a.mrr.toFixed(4)}->${b.mrr.toFixed(4)} ` +
          `ndcg=${a.ndcg.toFixed(4)}->${b.ndcg.toFixed(4)} ` +
          `lat(ms)=${a.latency_ms.toFixed(3)}->${b.latency_ms.toFixed(3)}`,
      );
    }
  }
}

try {
  main();
} catch (e) {
  console.error(`[error] ${e.message}`);
  process.exit(1);
}
