#!/usr/bin/env node

import path from 'path';
import { readJsonl, rankPatentsDualRecall, loadDualRecallModel } from './lib/retrieval_ranker.mjs';

const ROOT = '/app/fto';
const DEFAULT_PATENTS = path.join(ROOT, 'data_sources', 'patents.jsonl');
const DEFAULT_QUERIES = path.join(ROOT, 'data_sources', 'queries.jsonl');
const DEFAULT_QRELS = path.join(ROOT, 'data_sources', 'qrels.jsonl');
const DEFAULT_MODEL = path.join(ROOT, 'model_artifacts', 'fto_recall_dual_v1.json');

function parseArgs(argv) {
  const args = { k: 5, patents: DEFAULT_PATENTS, queries: DEFAULT_QUERIES, qrels: DEFAULT_QRELS, model: '', verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--k') args.k = Number(argv[++i] || '5');
    else if (a === '--patents') args.patents = argv[++i] || DEFAULT_PATENTS;
    else if (a === '--queries') args.queries = argv[++i] || DEFAULT_QUERIES;
    else if (a === '--qrels') args.qrels = argv[++i] || DEFAULT_QRELS;
    else if (a === '--model') args.model = argv[++i] || '';
    else if (a === '--use-default-model') args.model = DEFAULT_MODEL;
    else if (a === '--verbose') args.verbose = true;
  }
  if (!Number.isFinite(args.k) || args.k <= 0) args.k = 5;
  return args;
}

function rankPatents(patents, query, k, model) {
  return rankPatentsDualRecall(patents, query, k, model);
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
  const model = args.model ? loadDualRecallModel(args.model) : null;

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
    const pred = rankPatents(patents, query, args.k, model || undefined);
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
  if (args.model) console.log(`model=${args.model}`);
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
