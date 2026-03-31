#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const ROOT = '/app/fto';

function parseArgs(argv) {
  const args = {
    baseUrl: 'http://127.0.0.1/fto/api',
    loadReport: path.join(ROOT, 'docs', 'load_test_report_v1.json'),
    grayReport: path.join(ROOT, 'docs', 'gray_rollout_report_latest.json'),
    maxLoadErrorRate: 0.01,
    maxLoadP95Ms: 2000,
    maxGrayErrorRate: 0.01,
    maxGrayP95Ms: 2000,
    maxLivePostTasksP95Ms: 200,
    maxHttpErrorsTotal: 0,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url') args.baseUrl = String(argv[++i] || args.baseUrl).replace(/\/$/, '');
    else if (a === '--load-report') args.loadReport = argv[++i] || args.loadReport;
    else if (a === '--gray-report') args.grayReport = argv[++i] || args.grayReport;
    else if (a === '--max-load-error-rate') args.maxLoadErrorRate = Number(argv[++i] || '0.01');
    else if (a === '--max-load-p95-ms') args.maxLoadP95Ms = Number(argv[++i] || '2000');
    else if (a === '--max-gray-error-rate') args.maxGrayErrorRate = Number(argv[++i] || '0.01');
    else if (a === '--max-gray-p95-ms') args.maxGrayP95Ms = Number(argv[++i] || '2000');
    else if (a === '--max-live-post-tasks-p95-ms') args.maxLivePostTasksP95Ms = Number(argv[++i] || '200');
    else if (a === '--max-http-errors-total') args.maxHttpErrorsTotal = Number(argv[++i] || '0');
  }

  return args;
}

function readJsonSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_) {
    return null;
  }
}

function parseMetricValue(metricsText, metricName, labels = {}) {
  const lines = metricsText.split('\n').map((x) => x.trim()).filter(Boolean);
  const withLabels = Object.keys(labels).length > 0;
  for (const line of lines) {
    if (!line.startsWith(metricName)) continue;
    if (!withLabels && !line.startsWith(`${metricName}{`) && !line.startsWith(`${metricName} `)) continue;

    if (withLabels) {
      if (!line.startsWith(`${metricName}{`)) continue;
      const labelEnd = line.indexOf('}');
      if (labelEnd < 0) continue;
      const labelPart = line.slice(metricName.length + 1, labelEnd);
      const pairs = labelPart.split(',').map((s) => s.trim()).filter(Boolean);
      const parsed = {};
      for (const p of pairs) {
        const idx = p.indexOf('=');
        if (idx <= 0) continue;
        const k = p.slice(0, idx);
        let v = p.slice(idx + 1);
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        parsed[k] = v;
      }
      let matched = true;
      for (const [k, v] of Object.entries(labels)) {
        if (String(parsed[k]) !== String(v)) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      const n = Number(line.slice(labelEnd + 1).trim());
      return Number.isFinite(n) ? n : null;
    }

    const n = Number(line.slice(metricName.length).trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function failIf(checks, condition, message) {
  if (condition) checks.push(message);
}

async function main() {
  const args = parseArgs(process.argv);
  const failures = [];

  const loadReportWrap = readJsonSafe(args.loadReport);
  const loadReport = loadReportWrap?.report || null;
  if (loadReport) {
    failIf(failures, (loadReport.error_rate || 0) > args.maxLoadErrorRate,
      `[load] error_rate=${loadReport.error_rate} > ${args.maxLoadErrorRate}`);
    failIf(failures, (loadReport.latency_ms?.p95 || 0) > args.maxLoadP95Ms,
      `[load] p95=${loadReport.latency_ms?.p95}ms > ${args.maxLoadP95Ms}ms`);
  } else {
    failures.push(`[load] report missing or invalid: ${args.loadReport}`);
  }

  const grayReport = readJsonSafe(args.grayReport);
  const graySteps = Array.isArray(grayReport?.reports) ? grayReport.reports : [];
  if (graySteps.length > 0) {
    const last = graySteps[graySteps.length - 1]?.report || {};
    failIf(failures, (last.error_rate || 0) > args.maxGrayErrorRate,
      `[gray] error_rate=${last.error_rate} > ${args.maxGrayErrorRate}`);
    failIf(failures, (last.latency_ms?.p95 || 0) > args.maxGrayP95Ms,
      `[gray] p95=${last.latency_ms?.p95}ms > ${args.maxGrayP95Ms}ms`);
  } else {
    failures.push(`[gray] report missing or invalid: ${args.grayReport}`);
  }

  let metricsText = '';
  try {
    const res = await fetch(`${args.baseUrl}/metrics`);
    if (!res.ok) {
      failures.push(`[live] GET /metrics status=${res.status}`);
    } else {
      metricsText = await res.text();
    }
  } catch (e) {
    failures.push(`[live] GET /metrics failed: ${e.message}`);
  }

  if (metricsText) {
    const postTaskP95 = parseMetricValue(metricsText, 'fto_http_latency_ms_p95', { method: 'POST', path: '/tasks' });
    const httpErrorsTotal = parseMetricValue(metricsText, 'fto_http_errors_total');

    if (postTaskP95 == null) failures.push('[live] missing metric fto_http_latency_ms_p95{method="POST",path="/tasks"}');
    if (httpErrorsTotal == null) failures.push('[live] missing metric fto_http_errors_total');

    if (postTaskP95 != null) {
      failIf(failures, postTaskP95 > args.maxLivePostTasksP95Ms,
        `[live] POST /tasks p95=${postTaskP95}ms > ${args.maxLivePostTasksP95Ms}ms`);
    }
    if (httpErrorsTotal != null) {
      failIf(failures, httpErrorsTotal > args.maxHttpErrorsTotal,
        `[live] http_errors_total=${httpErrorsTotal} > ${args.maxHttpErrorsTotal}`);
    }

    console.log(`[alert-check] live_post_tasks_p95=${postTaskP95} live_http_errors_total=${httpErrorsTotal}`);
  }

  if (loadReport) {
    console.log(`[alert-check] load_error_rate=${loadReport.error_rate} load_p95=${loadReport.latency_ms?.p95}`);
  }
  if (graySteps.length > 0) {
    const last = graySteps[graySteps.length - 1];
    console.log(`[alert-check] gray_last_ratio=${last.ratio} gray_error_rate=${last.report?.error_rate} gray_p95=${last.report?.latency_ms?.p95}`);
  }

  if (failures.length > 0) {
    console.error('[alert-check] FAIL');
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }

  console.log('[alert-check] PASS');
}

try {
  await main();
} catch (e) {
  console.error(`[error] ${e.message}`);
  process.exit(1);
}
