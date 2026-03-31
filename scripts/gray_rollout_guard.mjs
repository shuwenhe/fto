#!/usr/bin/env node

import { readJsonl } from './lib/retrieval_ranker.mjs';
import { runLoadTest } from './lib/load_test_runner.mjs';
import path from 'path';

const ROOT = '/app/fto';
const DEFAULT_QUERIES = path.join(ROOT, 'data_sources', 'queries.jsonl');

function parseArgs(argv) {
  const args = {
    baseUrl: 'http://127.0.0.1/fto/api',
    queries: DEFAULT_QUERIES,
    ratios: [1, 10, 30, 50, 100],
    concurrency: 5,
    durationSec: 20,
    pollMs: 300,
    timeoutMs: 20000,
    maxErrorRate: 0.01,
    maxP95Ms: 2000,
    rollbackMode: 'lexical',
    rollbackDualRatio: 0,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url') args.baseUrl = String(argv[++i] || args.baseUrl).replace(/\/$/, '');
    else if (a === '--queries') args.queries = argv[++i] || DEFAULT_QUERIES;
    else if (a === '--ratios') args.ratios = String(argv[++i] || '1,10,30,50,100').split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));
    else if (a === '--concurrency') args.concurrency = Number(argv[++i] || '5');
    else if (a === '--duration-sec') args.durationSec = Number(argv[++i] || '20');
    else if (a === '--poll-ms') args.pollMs = Number(argv[++i] || '300');
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i] || '20000');
    else if (a === '--max-error-rate') args.maxErrorRate = Number(argv[++i] || '0.01');
    else if (a === '--max-p95-ms') args.maxP95Ms = Number(argv[++i] || '2000');
    else if (a === '--rollback-mode') args.rollbackMode = String(argv[++i] || 'lexical');
    else if (a === '--rollback-dual-ratio') args.rollbackDualRatio = Number(argv[++i] || '0');
  }

  args.ratios = args.ratios.map((x) => Math.max(0, Math.min(100, Math.round(x))));
  if (args.ratios.length === 0) args.ratios = [1, 10, 30, 50, 100];
  if (!Number.isFinite(args.concurrency) || args.concurrency <= 0) args.concurrency = 5;
  if (!Number.isFinite(args.durationSec) || args.durationSec <= 0) args.durationSec = 20;
  if (!Number.isFinite(args.pollMs) || args.pollMs <= 0) args.pollMs = 300;
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) args.timeoutMs = 20000;
  if (!Number.isFinite(args.maxErrorRate) || args.maxErrorRate < 0) args.maxErrorRate = 0.01;
  if (!Number.isFinite(args.maxP95Ms) || args.maxP95Ms <= 0) args.maxP95Ms = 2000;
  if (!Number.isFinite(args.rollbackDualRatio)) args.rollbackDualRatio = 0;

  return args;
}

async function setRankingConfig(baseUrl, mode, dualRatio) {
  const res = await fetch(`${baseUrl}/ops/ranking-config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, dual_ratio: dualRatio }),
  });
  if (!res.ok) throw new Error(`POST /ops/ranking-config status=${res.status}`);
  return await res.json();
}

async function getRankingConfig(baseUrl) {
  const res = await fetch(`${baseUrl}/ops/ranking-config`);
  if (!res.ok) throw new Error(`GET /ops/ranking-config status=${res.status}`);
  return await res.json();
}

async function main() {
  const args = parseArgs(process.argv);
  const queriesData = readJsonl(args.queries);
  const queries = queriesData.map((q) => String(q.query || '')).filter(Boolean);
  if (queries.length === 0) {
    throw new Error('No queries found for rollout guard');
  }

  console.log(`RolloutGuard baseUrl=${args.baseUrl} ratios=${args.ratios.join(',')}`);
  const before = await getRankingConfig(args.baseUrl);
  console.log(`before mode=${before.mode} dual_ratio=${before.dual_ratio}`);

  const reports = [];
  for (const ratio of args.ratios) {
    const cfg = await setRankingConfig(args.baseUrl, 'gray', ratio);
    console.log(`step set mode=${cfg.mode} dual_ratio=${cfg.dual_ratio}`);

    const report = await runLoadTest({
      baseUrl: args.baseUrl,
      queries,
      concurrency: args.concurrency,
      durationSec: args.durationSec,
      pollMs: args.pollMs,
      timeoutMs: args.timeoutMs,
    });

    reports.push({ ratio, report });
    console.log(`step ratio=${ratio} total=${report.total_requests} err=${report.error_rate} p95=${report.latency_ms.p95}`);

    const overError = report.error_rate > args.maxErrorRate;
    const overP95 = report.latency_ms.p95 > args.maxP95Ms;
    if (overError || overP95) {
      const rb = await setRankingConfig(args.baseUrl, args.rollbackMode, args.rollbackDualRatio);
      console.log(`rollback_triggered mode=${rb.mode} dual_ratio=${rb.dual_ratio}`);
      console.error(`rollback_reason error_rate=${report.error_rate} (>${args.maxErrorRate}) or p95=${report.latency_ms.p95} (>${args.maxP95Ms})`);
      console.log(JSON.stringify({ before, reports, rollback: rb }, null, 2));
      process.exit(1);
    }
  }

  const after = await getRankingConfig(args.baseUrl);
  console.log(`rollout_completed mode=${after.mode} dual_ratio=${after.dual_ratio}`);
  console.log(JSON.stringify({ before, reports, after }, null, 2));
}

try {
  await main();
} catch (e) {
  console.error(`[error] ${e.message}`);
  process.exit(1);
}
