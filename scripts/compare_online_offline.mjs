#!/usr/bin/env node

import path from 'path';
import { readJsonl, rankPatentsDualRecall } from './lib/retrieval_ranker.mjs';

const ROOT = '/app/fto';
const DEFAULT_PATENTS = path.join(ROOT, 'data_sources', 'patents.jsonl');
const DEFAULT_QUERIES = path.join(ROOT, 'data_sources', 'queries.jsonl');

function parseArgs(argv) {
  const args = {
    k: 5,
    patents: DEFAULT_PATENTS,
    queries: DEFAULT_QUERIES,
    sample: 5,
    seed: Date.now(),
    baseUrl: 'http://127.0.0.1/fto/api',
    pollMs: 400,
    timeoutMs: 20000,
    verbose: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--k') args.k = Number(argv[++i] || '5');
    else if (a === '--patents') args.patents = argv[++i] || DEFAULT_PATENTS;
    else if (a === '--queries') args.queries = argv[++i] || DEFAULT_QUERIES;
    else if (a === '--sample') args.sample = Number(argv[++i] || '5');
    else if (a === '--seed') args.seed = Number(argv[++i] || `${Date.now()}`);
    else if (a === '--base-url') args.baseUrl = String(argv[++i] || args.baseUrl).replace(/\/$/, '');
    else if (a === '--poll-ms') args.pollMs = Number(argv[++i] || '400');
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i] || '20000');
    else if (a === '--verbose') args.verbose = true;
  }

  if (!Number.isFinite(args.k) || args.k <= 0) args.k = 5;
  if (!Number.isFinite(args.sample) || args.sample <= 0) args.sample = 5;
  if (!Number.isFinite(args.seed)) args.seed = Date.now();
  if (!Number.isFinite(args.pollMs) || args.pollMs <= 0) args.pollMs = 400;
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) args.timeoutMs = 20000;

  return args;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTopkFromTask(task, k) {
  const result = Array.isArray(task.result) ? task.result : [];
  return result.slice(0, k).map((x) => String(x.patent_id || ''));
}

function sameOrder(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function createTask(baseUrl, query) {
  const res = await fetch(`${baseUrl}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(`POST /tasks failed with status=${res.status}`);
  }
  const body = await res.json();
  if (!body.task_id) {
    throw new Error('POST /tasks missing task_id');
  }
  return String(body.task_id);
}

async function waitTaskDone(baseUrl, taskId, pollMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`);
    if (!res.ok) {
      throw new Error(`GET /tasks/${taskId} failed with status=${res.status}`);
    }
    const body = await res.json();
    const status = String(body.status || '');
    if (status === 'succeeded') return body;
    if (status === 'failed') {
      throw new Error(`task ${taskId} failed`);
    }
    await sleep(pollMs);
  }
  throw new Error(`task ${taskId} timed out after ${timeoutMs}ms`);
}

async function fetchOnlineTopk(baseUrl, query, k, pollMs, timeoutMs) {
  const taskId = await createTask(baseUrl, query);
  const task = await waitTaskDone(baseUrl, taskId, pollMs, timeoutMs);
  return normalizeTopkFromTask(task, k);
}

async function main() {
  const args = parseArgs(process.argv);
  const patents = readJsonl(args.patents);
  const queries = readJsonl(args.queries);
  const sampled = sampleQueries(queries, args.sample, args.seed);

  if (sampled.length === 0) {
    throw new Error('No queries found to sample');
  }

  console.log(`ConsistencyCheck@${args.k}`);
  console.log(`sample=${sampled.length} seed=${args.seed} baseUrl=${args.baseUrl}`);

  const mismatches = [];
  let passed = 0;

  for (const q of sampled) {
    const qid = String(q.query_id || '');
    const query = String(q.query || '');
    const offlineTopk = rankPatentsDualRecall(patents, query, args.k);

    let onlineTopk = [];
    let err = '';
    try {
      onlineTopk = await fetchOnlineTopk(args.baseUrl, query, args.k, args.pollMs, args.timeoutMs);
    } catch (e) {
      err = e.message;
    }

    const ok = !err && sameOrder(offlineTopk, onlineTopk);
    if (ok) {
      passed += 1;
      if (args.verbose) {
        console.log(`[PASS] ${qid} topk=${onlineTopk.join(',')}`);
      }
      continue;
    }

    const row = {
      query_id: qid,
      query,
      error: err,
      offline_topk: offlineTopk,
      online_topk: onlineTopk,
    };
    mismatches.push(row);

    console.log(`[FAIL] ${qid}${err ? ` error=${err}` : ''}`);
    if (!err) {
      console.log(`  offline=${offlineTopk.join(',')}`);
      console.log(`  online =${onlineTopk.join(',')}`);
    }
  }

  console.log(`passed=${passed} failed=${mismatches.length}`);

  if (mismatches.length > 0) {
    console.log('--- mismatches ---');
    for (const m of mismatches) {
      console.log(JSON.stringify(m));
    }
    process.exit(1);
  }
}

try {
  await main();
} catch (e) {
  console.error(`[error] ${e.message}`);
  process.exit(1);
}
