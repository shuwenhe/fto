#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const ROOT = '/app/fto';

function parseArgs(argv) {
  const args = {
    out: path.join(ROOT, 'docs', 'ops_gate_latest.json'),
    baseUrl: 'http://127.0.0.1/fto/api',
    k: 5,
    sample: 5,
    seed: 20260331,
    queryId: 'q1',
    reportOut: 'docs/report_sample_v1.json',
    trendOutJson: 'docs/trend_summary_v1.json',
    trendOutMd: 'docs/trend_summary_v1.md',
    lookback: 20,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i] || args.out;
    else if (a === '--base-url') args.baseUrl = String(argv[++i] || args.baseUrl).replace(/\/$/, '');
    else if (a === '--k') args.k = Number(argv[++i] || '5');
    else if (a === '--sample') args.sample = Number(argv[++i] || '5');
    else if (a === '--seed') args.seed = Number(argv[++i] || '20260331');
    else if (a === '--query-id') args.queryId = argv[++i] || 'q1';
    else if (a === '--report-out') args.reportOut = argv[++i] || args.reportOut;
    else if (a === '--trend-out-json') args.trendOutJson = argv[++i] || args.trendOutJson;
    else if (a === '--trend-out-md') args.trendOutMd = argv[++i] || args.trendOutMd;
    else if (a === '--lookback') args.lookback = Number(argv[++i] || '20');
  }

  return args;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_) {
    return null;
  }
}

function runNode(args) {
  const started = Date.now();
  const res = spawnSync('node', args, { encoding: 'utf-8' });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);

  return {
    command: `node ${args.join(' ')}`,
    exit_code: typeof res.status === 'number' ? res.status : 1,
    duration_ms: Date.now() - started,
    ok: res.status === 0,
  };
}

function writeSummary(filePath, summary) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8');
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();

  const steps = [];

  const ciStep = runNode([
    'scripts/ci_gate.mjs',
    '--k', String(args.k),
    '--sample', String(args.sample),
    '--seed', String(args.seed),
    '--query-id', args.queryId,
    '--base-url', args.baseUrl,
    '--report-out', args.reportOut,
  ]);
  steps.push({ name: 'ci-gate', ...ciStep });

  if (!ciStep.ok) {
    const summary = {
      gate: 'ops-gate',
      generated_at: new Date().toISOString(),
      started_at: startedAt,
      status: 'failed',
      failed_step: 'ci-gate',
      steps,
      artifacts: {
        report_sample: args.reportOut,
        trend_json: args.trendOutJson,
        trend_md: args.trendOutMd,
      },
    };
    writeSummary(args.out, summary);
    console.log(`ops_gate_summary_written=${args.out}`);
    process.exit(1);
  }

  const trendStep = runNode([
    'scripts/trend_report.mjs',
    '--load-history', 'docs/load_test_history.jsonl',
    '--gray-history', 'docs/gray_rollout_history.jsonl',
    '--out-json', args.trendOutJson,
    '--out-md', args.trendOutMd,
    '--lookback', String(args.lookback),
  ]);
  steps.push({ name: 'trend-report', ...trendStep });

  const ok = trendStep.ok;
  const summary = {
    gate: 'ops-gate',
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    status: ok ? 'passed' : 'failed',
    failed_step: ok ? '' : 'trend-report',
    steps,
    artifacts: {
      report_sample: args.reportOut,
      trend_json: args.trendOutJson,
      trend_md: args.trendOutMd,
      report_sample_data: readJsonSafe(args.reportOut),
      trend_summary_data: readJsonSafe(args.trendOutJson),
    },
  };

  writeSummary(args.out, summary);
  console.log(`ops_gate_summary_written=${args.out}`);

  if (!ok) process.exit(1);
}

try {
  await main();
} catch (e) {
  console.error(`[error] ${e.message}`);
  process.exit(1);
}
