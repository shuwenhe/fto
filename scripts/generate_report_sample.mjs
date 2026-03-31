#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { readJsonl, rankPatentsDualRecall } from './lib/retrieval_ranker.mjs';

const ROOT = '/app/fto';
const DEFAULT_PATENTS = path.join(ROOT, 'data_sources', 'patents.jsonl');
const DEFAULT_PATENTS_JSON = path.join(ROOT, 'data_sources', 'patents.json');
const DEFAULT_QUERIES = path.join(ROOT, 'data_sources', 'queries.jsonl');
const DEFAULT_QRELS = path.join(ROOT, 'data_sources', 'qrels.jsonl');
const DEFAULT_OUT = path.join(ROOT, 'docs', 'report_sample_v1.json');

function parseArgs(argv) {
  const args = {
    k: 5,
    patents: DEFAULT_PATENTS,
    patentsJson: DEFAULT_PATENTS_JSON,
    queries: DEFAULT_QUERIES,
    qrels: DEFAULT_QRELS,
    out: DEFAULT_OUT,
    queryId: 'q1',
    sample: 5,
    seed: 20260331,
    baseUrl: 'http://127.0.0.1/fto/api',
    pollMs: 400,
    timeoutMs: 20000,
    baselineName: 'retrieval-baseline-v1',
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--k') args.k = Number(argv[++i] || '5');
    else if (a === '--patents') args.patents = argv[++i] || DEFAULT_PATENTS;
    else if (a === '--patents-json') args.patentsJson = argv[++i] || DEFAULT_PATENTS_JSON;
    else if (a === '--queries') args.queries = argv[++i] || DEFAULT_QUERIES;
    else if (a === '--qrels') args.qrels = argv[++i] || DEFAULT_QRELS;
    else if (a === '--out') args.out = argv[++i] || DEFAULT_OUT;
    else if (a === '--query-id') args.queryId = argv[++i] || 'q1';
    else if (a === '--sample') args.sample = Number(argv[++i] || '5');
    else if (a === '--seed') args.seed = Number(argv[++i] || '20260331');
    else if (a === '--base-url') args.baseUrl = String(argv[++i] || args.baseUrl).replace(/\/$/, '');
    else if (a === '--poll-ms') args.pollMs = Number(argv[++i] || '400');
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i] || '20000');
    else if (a === '--baseline-name') args.baselineName = argv[++i] || args.baselineName;
  }

  if (!Number.isFinite(args.k) || args.k <= 0) args.k = 5;
  if (!Number.isFinite(args.sample) || args.sample <= 0) args.sample = 5;
  if (!Number.isFinite(args.seed)) args.seed = 20260331;
  if (!Number.isFinite(args.pollMs) || args.pollMs <= 0) args.pollMs = 400;
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) args.timeoutMs = 20000;

  return args;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
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

function evaluate(patents, queries, qrels, k) {
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
    const pred = rankPatentsDualRecall(patents, query, k);
    const relMap = relByQ.get(qid) || new Map();
    const relSet = new Set(Array.from(relMap.entries()).filter((x) => x[1] > 0).map((x) => x[0]));

    rows.push({
      query_id: qid,
      recall: recallAtK(pred, relSet),
      mrr: mrrAtK(pred, relSet),
      ndcg: ndcgAtK(pred, relMap, k),
      topk: pred,
    });
  }

  const avg = (key) => (rows.length ? rows.reduce((s, r) => s + r[key], 0) / rows.length : 0);
  return {
    queries: rows.length,
    recall_at_k: Number(avg('recall').toFixed(4)),
    mrr_at_k: Number(avg('mrr').toFixed(4)),
    ndcg_at_k: Number(avg('ndcg').toFixed(4)),
  };
}

function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function sampleQueries(queries, n, seed) {
  const rng = makeRng(seed);
  const idx = [...queries.keys()];
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = idx[i];
    idx[i] = idx[j];
    idx[j] = t;
  }
  return idx.slice(0, Math.min(n, idx.length)).map((i) => queries[i]);
}

function sameOrder(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createTask(baseUrl, query) {
  const res = await fetch(`${baseUrl}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`POST /tasks failed with status=${res.status}`);
  const body = await res.json();
  if (!body.task_id) throw new Error('POST /tasks missing task_id');
  return String(body.task_id);
}

async function waitTaskDone(baseUrl, taskId, pollMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`);
    if (!res.ok) throw new Error(`GET /tasks/${taskId} failed with status=${res.status}`);
    const body = await res.json();
    const status = String(body.status || '');
    if (status === 'succeeded') return body;
    if (status === 'failed') throw new Error(`task ${taskId} failed`);
    await sleep(pollMs);
  }
  throw new Error(`task ${taskId} timed out after ${timeoutMs}ms`);
}

function topkIdsFromTask(task, k) {
  const result = Array.isArray(task.result) ? task.result : [];
  return result.slice(0, k).map((x) => String(x.patent_id || ''));
}

async function runConsistencyCheck(patents, queries, args) {
  const sampled = sampleQueries(queries, args.sample, args.seed);
  let passed = 0;
  let failed = 0;

  for (const q of sampled) {
    const query = String(q.query || '');
    const offlineTopk = rankPatentsDualRecall(patents, query, args.k);

    try {
      const taskId = await createTask(args.baseUrl, query);
      const task = await waitTaskDone(args.baseUrl, taskId, args.pollMs, args.timeoutMs);
      const onlineTopk = topkIdsFromTask(task, args.k);
      if (sameOrder(offlineTopk, onlineTopk)) passed += 1;
      else failed += 1;
    } catch (_) {
      failed += 1;
    }
  }

  return {
    sample: sampled.length,
    seed: args.seed,
    passed,
    failed,
    command: `node scripts/compare_online_offline.mjs --k ${args.k} --sample ${sampled.length} --seed ${args.seed} --base-url ${args.baseUrl}`,
  };
}

function queryById(queries, queryId) {
  return queries.find((q) => String(q.query_id) === String(queryId));
}

async function fetchQueryReport(query, args) {
  const taskId = await createTask(args.baseUrl, query.query);
  const task = await waitTaskDone(args.baseUrl, taskId, args.pollMs, args.timeoutMs);

  const topk = (Array.isArray(task.result) ? task.result : []).slice(0, args.k).map((item, i) => ({
    rank: i + 1,
    patent_id: String(item.patent_id || ''),
    patent_url: String(item.patent_url || ''),
    title: String(item.title || ''),
    risk_level: String(item.risk_level || ''),
    reason: String(item.reason || ''),
  }));

  return {
    query_id: String(query.query_id),
    query: String(query.query),
    task_id: String(task.task_id || taskId),
    status: String(task.status || ''),
    created_at: String(task.created_at || ''),
    updated_at: String(task.updated_at || ''),
    topk,
  };
}

async function main() {
  const args = parseArgs(process.argv);

  const patents = readJsonl(args.patents);
  const queries = readJsonl(args.queries);
  const qrels = readJsonl(args.qrels);

  const targetQuery = queryById(queries, args.queryId);
  if (!targetQuery) {
    throw new Error(`query_id not found: ${args.queryId}`);
  }

  const evaluation = evaluate(patents, queries, qrels, args.k);
  const consistencyCheck = await runConsistencyCheck(patents, queries, args);
  const queryReport = await fetchQueryReport(targetQuery, args);

  const report = {
    report_version: 'v1',
    generated_at: new Date().toISOString(),
    environment: {
      service: 'fto-backend-gin',
      base_url: args.baseUrl,
      notes: 'auto-generated by scripts/generate_report_sample.mjs',
    },
    baseline: {
      name: args.baselineName,
      k: args.k,
      weights: {
        title: 4,
        abstract: 2,
        claim: 3,
        keyword: 2,
        fusion_lexical: 0.65,
        fusion_semantic: 0.35,
      },
      recall_depth_rule: 'max(6, k*3)',
      data_snapshot: {
        patents_jsonl: sha256File(args.patents),
        patents_json: fs.existsSync(args.patentsJson) ? sha256File(args.patentsJson) : '',
        queries_jsonl: sha256File(args.queries),
        qrels_jsonl: sha256File(args.qrels),
      },
    },
    evaluation,
    consistency_check: consistencyCheck,
    query_report: queryReport,
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');

  console.log(`report_generated=${args.out}`);
  console.log(`query_id=${queryReport.query_id} task_id=${queryReport.task_id} status=${queryReport.status}`);
  console.log(`eval: Recall@${args.k}=${evaluation.recall_at_k.toFixed(4)} MRR@${args.k}=${evaluation.mrr_at_k.toFixed(4)} NDCG@${args.k}=${evaluation.ndcg_at_k.toFixed(4)}`);
  console.log(`consistency: sample=${consistencyCheck.sample} passed=${consistencyCheck.passed} failed=${consistencyCheck.failed}`);
}

try {
  await main();
} catch (e) {
  console.error(`[error] ${e.message}`);
  process.exit(1);
}
