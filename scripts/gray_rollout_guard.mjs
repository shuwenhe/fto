#!/usr/bin/env node

import fs from 'fs';
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
    out: path.join(ROOT, 'docs', 'gray_rollout_report_latest.json'),
    historyFile: path.join(ROOT, 'docs', 'gray_rollout_history.jsonl'),
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
    else if (a === '--out') args.out = argv[++i] || args.out;
    else if (a === '--history-file') args.historyFile = argv[++i] || args.historyFile;
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

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendJsonl(filePath, obj) {
  ensureParentDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, 'utf-8');
}

function readJsonlSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch (_) {
      // Ignore malformed legacy lines.
    }
  }
  return out;
}

function compareStep(current, previous) {
  if (!previous || !previous.report) return null;
  const prev = previous.report;
  return {
    against_ts: previous.ts || '',
    delta_error_rate: Number((current.error_rate - (prev.error_rate || 0)).toFixed(6)),
    delta_p95_ms: Number((current.latency_ms.p95 - (prev.latency_ms?.p95 || 0)).toFixed(2)),
    delta_p99_ms: Number((current.latency_ms.p99 - (prev.latency_ms?.p99 || 0)).toFixed(2)),
    delta_throughput_rps: Number((current.throughput_rps - (prev.throughput_rps || 0)).toFixed(3)),
  };
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

  const history = readJsonlSafe(args.historyFile);
  const reports = [];
  const runID = `rollout-${Date.now()}`;
  const runStartedAt = new Date().toISOString();

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

    const previousSameRatio = [...history].reverse().find((h) => Number(h.ratio) === Number(ratio));
    const comparison = compareStep(report, previousSameRatio);

    const step = {
      run_id: runID,
      ts: new Date().toISOString(),
      ratio,
      mode: 'gray',
      report,
      previous_comparison: comparison,
    };

    appendJsonl(args.historyFile, step);
    history.push(step);
    reports.push(step);

    console.log(`step ratio=${ratio} total=${report.total_requests} err=${report.error_rate} p95=${report.latency_ms.p95}`);
    if (comparison) {
      console.log(`step ratio=${ratio} vs_last delta_err=${comparison.delta_error_rate} delta_p95_ms=${comparison.delta_p95_ms} delta_rps=${comparison.delta_throughput_rps}`);
    }

    const overError = report.error_rate > args.maxErrorRate;
    const overP95 = report.latency_ms.p95 > args.maxP95Ms;
    if (overError || overP95) {
      const rb = await setRankingConfig(args.baseUrl, args.rollbackMode, args.rollbackDualRatio);
      console.log(`rollback_triggered mode=${rb.mode} dual_ratio=${rb.dual_ratio}`);
      console.error(`rollback_reason error_rate=${report.error_rate} (>${args.maxErrorRate}) or p95=${report.latency_ms.p95} (>${args.maxP95Ms})`);

      const failResult = {
        run_id: runID,
        started_at: runStartedAt,
        ended_at: new Date().toISOString(),
        base_url: args.baseUrl,
        thresholds: { max_error_rate: args.maxErrorRate, max_p95_ms: args.maxP95Ms },
        before,
        reports,
        rollback: rb,
        status: 'failed_rollback',
      };
      ensureParentDir(args.out);
      fs.writeFileSync(args.out, `${JSON.stringify(failResult, null, 2)}\n`, 'utf-8');
      console.log(`report_written=${args.out}`);
      console.log(JSON.stringify(failResult, null, 2));
      process.exit(1);
    }
  }

  const after = await getRankingConfig(args.baseUrl);
  console.log(`rollout_completed mode=${after.mode} dual_ratio=${after.dual_ratio}`);

  const okResult = {
    run_id: runID,
    started_at: runStartedAt,
    ended_at: new Date().toISOString(),
    base_url: args.baseUrl,
    thresholds: { max_error_rate: args.maxErrorRate, max_p95_ms: args.maxP95Ms },
    before,
    reports,
    after,
    status: 'completed',
  };

  ensureParentDir(args.out);
  fs.writeFileSync(args.out, `${JSON.stringify(okResult, null, 2)}\n`, 'utf-8');
  console.log(`report_written=${args.out}`);
  console.log(JSON.stringify(okResult, null, 2));
}

try {
  await main();
} catch (e) {
  console.error(`[error] ${e.message}`);
  process.exit(1);
}
