#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { readJsonl } from './lib/retrieval_ranker.mjs';
import { runLoadTest } from './lib/load_test_runner.mjs';

const ROOT = '/app/fto';
const DEFAULT_QUERIES = path.join(ROOT, 'data_sources', 'queries.jsonl');

function parseArgs(argv) {
  const args = {
    baseUrl: 'http://127.0.0.1/fto/api',
    queries: DEFAULT_QUERIES,
    concurrency: 10,
    durationSec: 60,
    pollMs: 300,
    timeoutMs: 20000,
    out: '',
    maxErrorRate: 1.0,
    maxP95Ms: 0,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url') args.baseUrl = String(argv[++i] || args.baseUrl).replace(/\/$/, '');
    else if (a === '--queries') args.queries = argv[++i] || DEFAULT_QUERIES;
    else if (a === '--concurrency') args.concurrency = Number(argv[++i] || '10');
    else if (a === '--duration-sec') args.durationSec = Number(argv[++i] || '60');
    else if (a === '--poll-ms') args.pollMs = Number(argv[++i] || '300');
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i] || '20000');
    else if (a === '--out') args.out = argv[++i] || '';
    else if (a === '--max-error-rate') args.maxErrorRate = Number(argv[++i] || '1.0');
    else if (a === '--max-p95-ms') args.maxP95Ms = Number(argv[++i] || '0');
  }

  if (!Number.isFinite(args.concurrency) || args.concurrency <= 0) args.concurrency = 10;
  if (!Number.isFinite(args.durationSec) || args.durationSec <= 0) args.durationSec = 60;
  if (!Number.isFinite(args.pollMs) || args.pollMs <= 0) args.pollMs = 300;
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) args.timeoutMs = 20000;
  if (!Number.isFinite(args.maxErrorRate) || args.maxErrorRate < 0) args.maxErrorRate = 1.0;
  if (!Number.isFinite(args.maxP95Ms) || args.maxP95Ms < 0) args.maxP95Ms = 0;

  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const queriesData = readJsonl(args.queries);
  const queries = queriesData.map((q) => String(q.query || '')).filter(Boolean);
  if (queries.length === 0) {
    throw new Error('No queries found for load test');
  }

  const report = await runLoadTest({
    baseUrl: args.baseUrl,
    queries,
    concurrency: args.concurrency,
    durationSec: args.durationSec,
    pollMs: args.pollMs,
    timeoutMs: args.timeoutMs,
  });

  console.log(`LoadTest baseUrl=${args.baseUrl}`);
  console.log(`duration=${report.duration_sec}s concurrency=${args.concurrency}`);
  console.log(`total=${report.total_requests} succeeded=${report.succeeded} failed=${report.failed} error_rate=${report.error_rate}`);
  console.log(`latency_ms p50=${report.latency_ms.p50} p95=${report.latency_ms.p95} p99=${report.latency_ms.p99} avg=${report.latency_ms.avg}`);
  console.log(`throughput_rps=${report.throughput_rps}`);

  if (Object.keys(report.errors).length > 0) {
    console.log('errors=' + JSON.stringify(report.errors));
  }

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
    console.log(`report_written=${args.out}`);
  }

  let failed = false;
  if (report.error_rate > args.maxErrorRate) {
    console.error(`[threshold] error_rate ${report.error_rate} > ${args.maxErrorRate}`);
    failed = true;
  }
  if (args.maxP95Ms > 0 && report.latency_ms.p95 > args.maxP95Ms) {
    console.error(`[threshold] p95 ${report.latency_ms.p95}ms > ${args.maxP95Ms}ms`);
    failed = true;
  }
  if (failed) process.exit(1);
}

try {
  await main();
} catch (e) {
  console.error(`[error] ${e.message}`);
  process.exit(1);
}
