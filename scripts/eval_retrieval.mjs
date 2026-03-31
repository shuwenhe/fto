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

function splitQuery(query) {
  const q = normalize(query);
  if (!q) return [];
  const tokens = [q];
  const parts = q.split(/[\s,，。；;：:、|/\\()\[\]{}<>]+/).filter((x) => x.length >= 2);
  tokens.push(...parts);
  return Array.from(new Set(tokens));
}

function containsAny(haystack, tokens) {
  const h = normalize(haystack);
  let score = 0;
  for (const t of tokens) {
    if (h.includes(t)) score += 1;
  }
  return score;
}

function scorePatent(rec, tokens) {
  const titleScore = containsAny(rec.title, tokens);
  const absScore = containsAny(rec.abstract, tokens);
  const claimScore = containsAny(rec.claim, tokens);

  let keywordHits = 0;
  const kws = Array.isArray(rec.keywords) ? rec.keywords : [];
  for (const kw of kws) {
    const kwN = normalize(kw);
    for (const t of tokens) {
      if (kwN.includes(t) || t.includes(kwN)) keywordHits += 1;
    }
  }

  return titleScore * 4 + absScore * 2 + claimScore * 3 + keywordHits * 2;
}

function rankPatents(patents, query, k) {
  const tokens = splitQuery(query);
  const ranked = patents
    .map((p) => ({ p, score: scorePatent(p, tokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.p.patent_id);
  return ranked;
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
