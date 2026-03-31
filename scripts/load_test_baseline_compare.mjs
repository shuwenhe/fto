#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { readJsonl } from './lib/retrieval_ranker.mjs';
import { runLoadTest } from './lib/load_test_runner.mjs';

const ROOT = '/app/fto';
const DEFAULT_QUERIES = path.join(ROOT, 'data_sources', 'queries.jsonl');
const DEFAULT_OUT = path.join(ROOT, 'docs', 'load_test_report_v1.json');
const DEFAULT_HISTORY = path.join(ROOT, 'docs', 'load_test_history.jsonl');

function parseArgs(argv) {
  const args = {
    baseUrl: 'http://127.0.0.1/fto/api',
    queries: DEFAULT_QUERIES,
    concurrency: 10,
    durationSec: 60,
    pollMs: 300,
    timeoutMs: 20000,
    out: DEFAULT_OUT,
    historyFile: DEFAULT_HISTORY,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url') args.baseUrl = String(argv[++i] || args.baseUrl).replace(/\/$/, '');
    else if (a === '--queries') args.queries = argv[++i] || DEFAULT_QUERIES;
    else if (a === '--concurrency') args.concurrency = Number(argv[++i] || '10');
    else if (a === '--duration-sec') args.durationSec = Number(argv[++i] || '60');
    else if (a === '--poll-ms') args.pollMs = Number(argv[++i] || '300');
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i] || '20000');
    else if (a === '--out') args.out = argv[++i] || DEFAULT_OUT;
    else if (a === '--history-file') args.historyFile = argv[++i] || DEFAULT_HISTORY;
  }

  return args;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonlSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function appendJsonl(filePath, obj) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, 'utf-8');
}

function compareReport(curr, prev) {
  if (!prev) return null;
  return {
    prev_ts: prev.ts || '',
    delta_error_rate: Number((curr.error_rate - (prev.report?.error_rate || 0)).toFixed(6)),
    delta_p50_ms: Number((curr.latency_ms.p50 - (prev.report?.latency_ms?.p50 || 0)).toFixed(2)),
    delta_p95_ms: Number((curr.latency_ms.p95 - (prev.report?.latency_ms?.p95 || 0)).toFixed(2)),
    delta_p99_ms: Number((curr.latency_ms.p99 - (prev.report?.latency_ms?.p99 || 0)).toFixed(2)),
    delta_throughput_rps: Number((curr.throughput_rps - (prev.report?.throughput_rps || 0)).toFixed(3)),
  };
}

async function main() {
  const args = parseArgs(process.argv);

  const queriesData = readJsonl(args.queries);
  const queries = queriesData.map((q) => String(q.query || '')).filter(Boolean);
  if (queries.length === 0) {
    throw new Error('No queries found for baseline compare');
  }

  const report = await runLoadTest({
    baseUrl: args.baseUrl,
    queries,
    concurrency: args.concurrency,
    durationSec: args.durationSec,
    pollMs: args.pollMs,
    timeoutMs: args.timeoutMs,
  });

  const history = readJsonlSafe(args.historyFile);
  const prev = history.length > 0 ? history[history.length - 1] : null;
  const diff = compareReport(report, prev);

  const entry = {
    ts: new Date().toISOString(),
    base_url: args.baseUrl,
    config: {
      queries: args.queries,
      concurrency: args.concurrency,
      duration_sec: args.durationSec,
      poll_ms: args.pollMs,
      timeout_ms: args.timeoutMs,
    },
    report,
    compare_with_last: diff,
  };

  ensureDir(args.out);
  fs.writeFileSync(args.out, `${JSON.stringify(entry, null, 2)}\n`, 'utf-8');
  appendJsonl(args.historyFile, entry);

  console.log(`report_written=${args.out}`);
  console.log(`history_appended=${args.historyFile}`);
  console.log(`current total=${report.total_requests} err=${report.error_rate} p95=${report.latency_ms.p95} rps=${report.throughput_rps}`);

  if (diff) {
    console.log(
      `vs_last delta_err=${diff.delta_error_rate} delta_p50=${diff.delta_p50_ms} delta_p95=${diff.delta_p95_ms} delta_p99=${diff.delta_p99_ms} delta_rps=${diff.delta_throughput_rps}`,
    );
  } else {
    console.log('vs_last none (first baseline entry)');
  }
}

try {
  await main();
} catch (e) {
  console.error(`[error] ${e.message}`);
  process.exit(1);
}
