#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const ROOT = '/app/fto';
const DEFAULT_LOAD_HISTORY = path.join(ROOT, 'docs', 'load_test_history.jsonl');
const DEFAULT_GRAY_HISTORY = path.join(ROOT, 'docs', 'gray_rollout_history.jsonl');
const DEFAULT_OUT_JSON = path.join(ROOT, 'docs', 'trend_summary_v1.json');
const DEFAULT_OUT_MD = path.join(ROOT, 'docs', 'trend_summary_v1.md');

function parseArgs(argv) {
  const args = {
    loadHistory: DEFAULT_LOAD_HISTORY,
    grayHistory: DEFAULT_GRAY_HISTORY,
    outJson: DEFAULT_OUT_JSON,
    outMd: DEFAULT_OUT_MD,
    lookback: 20,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--load-history') args.loadHistory = argv[++i] || DEFAULT_LOAD_HISTORY;
    else if (a === '--gray-history') args.grayHistory = argv[++i] || DEFAULT_GRAY_HISTORY;
    else if (a === '--out-json') args.outJson = argv[++i] || DEFAULT_OUT_JSON;
    else if (a === '--out-md') args.outMd = argv[++i] || DEFAULT_OUT_MD;
    else if (a === '--lookback') args.lookback = Number(argv[++i] || '20');
  }

  if (!Number.isFinite(args.lookback) || args.lookback <= 0) args.lookback = 20;
  return args;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonlSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
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

function avg(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, n) => s + n, 0) / arr.length;
}

function summarizeLoad(loadEntries) {
  const entries = loadEntries.filter((x) => x.report);
  if (entries.length === 0) {
    return { count: 0 };
  }

  const first = entries[0].report;
  const last = entries[entries.length - 1].report;

  const p95s = entries.map((x) => Number(x.report.latency_ms?.p95 || 0));
  const p99s = entries.map((x) => Number(x.report.latency_ms?.p99 || 0));
  const errRates = entries.map((x) => Number(x.report.error_rate || 0));
  const rps = entries.map((x) => Number(x.report.throughput_rps || 0));

  return {
    count: entries.length,
    avg_p95_ms: Number(avg(p95s).toFixed(2)),
    avg_p99_ms: Number(avg(p99s).toFixed(2)),
    avg_error_rate: Number(avg(errRates).toFixed(6)),
    avg_throughput_rps: Number(avg(rps).toFixed(3)),
    latest: {
      ts: entries[entries.length - 1].ts,
      p95_ms: last.latency_ms?.p95 || 0,
      p99_ms: last.latency_ms?.p99 || 0,
      error_rate: last.error_rate || 0,
      throughput_rps: last.throughput_rps || 0,
    },
    delta_latest_vs_first: {
      p95_ms: Number(((last.latency_ms?.p95 || 0) - (first.latency_ms?.p95 || 0)).toFixed(2)),
      p99_ms: Number(((last.latency_ms?.p99 || 0) - (first.latency_ms?.p99 || 0)).toFixed(2)),
      error_rate: Number(((last.error_rate || 0) - (first.error_rate || 0)).toFixed(6)),
      throughput_rps: Number(((last.throughput_rps || 0) - (first.throughput_rps || 0)).toFixed(3)),
    },
  };
}

function summarizeGray(grayEntries) {
  const byRatio = new Map();
  for (const e of grayEntries) {
    const ratio = Number(e.ratio);
    if (!Number.isFinite(ratio) || !e.report) continue;
    if (!byRatio.has(ratio)) byRatio.set(ratio, []);
    byRatio.get(ratio).push(e);
  }

  const ratios = [...byRatio.keys()].sort((a, b) => a - b);
  const out = [];
  for (const ratio of ratios) {
    const arr = byRatio.get(ratio);
    const first = arr[0].report;
    const last = arr[arr.length - 1].report;
    out.push({
      ratio,
      count: arr.length,
      latest_ts: arr[arr.length - 1].ts,
      avg_p95_ms: Number(avg(arr.map((x) => Number(x.report.latency_ms?.p95 || 0))).toFixed(2)),
      avg_error_rate: Number(avg(arr.map((x) => Number(x.report.error_rate || 0))).toFixed(6)),
      avg_throughput_rps: Number(avg(arr.map((x) => Number(x.report.throughput_rps || 0))).toFixed(3)),
      latest: {
        p95_ms: last.latency_ms?.p95 || 0,
        error_rate: last.error_rate || 0,
        throughput_rps: last.throughput_rps || 0,
      },
      delta_latest_vs_first: {
        p95_ms: Number(((last.latency_ms?.p95 || 0) - (first.latency_ms?.p95 || 0)).toFixed(2)),
        error_rate: Number(((last.error_rate || 0) - (first.error_rate || 0)).toFixed(6)),
        throughput_rps: Number(((last.throughput_rps || 0) - (first.throughput_rps || 0)).toFixed(3)),
      },
    });
  }
  return out;
}

function renderMarkdown(summary) {
  const lines = [];
  lines.push('# Trend Summary v1');
  lines.push('');
  lines.push(`Generated at: ${summary.generated_at}`);
  lines.push('');

  lines.push('## Load Test');
  lines.push('');
  if (!summary.load || summary.load.count === 0) {
    lines.push('No load history available.');
  } else {
    lines.push(`- Count: ${summary.load.count}`);
    lines.push(`- Avg P95(ms): ${summary.load.avg_p95_ms}`);
    lines.push(`- Avg P99(ms): ${summary.load.avg_p99_ms}`);
    lines.push(`- Avg Error Rate: ${summary.load.avg_error_rate}`);
    lines.push(`- Avg Throughput(RPS): ${summary.load.avg_throughput_rps}`);
    lines.push(`- Latest: p95=${summary.load.latest.p95_ms}, err=${summary.load.latest.error_rate}, rps=${summary.load.latest.throughput_rps}`);
    lines.push(`- Delta(latest vs first): p95=${summary.load.delta_latest_vs_first.p95_ms}, err=${summary.load.delta_latest_vs_first.error_rate}, rps=${summary.load.delta_latest_vs_first.throughput_rps}`);
  }
  lines.push('');

  lines.push('## Gray Rollout By Ratio');
  lines.push('');
  if (!summary.gray_by_ratio || summary.gray_by_ratio.length === 0) {
    lines.push('No gray rollout history available.');
  } else {
    lines.push('| ratio | count | avg_p95_ms | avg_error_rate | avg_rps | latest_p95 | latest_err | latest_rps | delta_p95 | delta_err | delta_rps |');
    lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const r of summary.gray_by_ratio) {
      lines.push(`| ${r.ratio} | ${r.count} | ${r.avg_p95_ms} | ${r.avg_error_rate} | ${r.avg_throughput_rps} | ${r.latest.p95_ms} | ${r.latest.error_rate} | ${r.latest.throughput_rps} | ${r.delta_latest_vs_first.p95_ms} | ${r.delta_latest_vs_first.error_rate} | ${r.delta_latest_vs_first.throughput_rps} |`);
    }
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv);

  const loadHistory = readJsonlSafe(args.loadHistory).slice(-args.lookback);
  const grayHistory = readJsonlSafe(args.grayHistory).slice(-args.lookback * 10);

  const summary = {
    generated_at: new Date().toISOString(),
    lookback: args.lookback,
    load: summarizeLoad(loadHistory),
    gray_by_ratio: summarizeGray(grayHistory),
  };

  ensureDir(args.outJson);
  fs.writeFileSync(args.outJson, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8');
  ensureDir(args.outMd);
  fs.writeFileSync(args.outMd, renderMarkdown(summary), 'utf-8');

  console.log(`trend_json_written=${args.outJson}`);
  console.log(`trend_md_written=${args.outMd}`);
  console.log(`load_count=${summary.load?.count || 0} gray_ratio_count=${summary.gray_by_ratio?.length || 0}`);
}

try {
  await main();
} catch (e) {
  console.error(`[error] ${e.message}`);
  process.exit(1);
}
