#!/usr/bin/env node

import { spawnSync } from 'child_process';

function parseArgs(argv) {
  const args = {
    baseUrl: 'http://127.0.0.1/fto/api',
    k: 5,
    sample: 5,
    seed: 20260331,
    queryId: 'q1',
    reportOut: 'docs/report_sample_v1.json',
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url') args.baseUrl = String(argv[++i] || args.baseUrl).replace(/\/$/, '');
    else if (a === '--k') args.k = Number(argv[++i] || '5');
    else if (a === '--sample') args.sample = Number(argv[++i] || '5');
    else if (a === '--seed') args.seed = Number(argv[++i] || '20260331');
    else if (a === '--query-id') args.queryId = argv[++i] || 'q1';
    else if (a === '--report-out') args.reportOut = argv[++i] || 'docs/report_sample_v1.json';
  }

  return args;
}

async function getConfig(baseUrl) {
  const res = await fetch(`${baseUrl}/ops/ranking-config`);
  if (!res.ok) throw new Error(`GET /ops/ranking-config status=${res.status}`);
  return await res.json();
}

async function setConfig(baseUrl, mode, dualRatio) {
  const res = await fetch(`${baseUrl}/ops/ranking-config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, dual_ratio: dualRatio }),
  });
  if (!res.ok) throw new Error(`POST /ops/ranking-config status=${res.status}`);
  return await res.json();
}

function runNode(args) {
  const r = spawnSync('node', args, { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`Command failed: node ${args.join(' ')}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  let originalConfig = null;
  let switched = false;

  try {
    try {
      originalConfig = await getConfig(args.baseUrl);
      await setConfig(args.baseUrl, 'dual', 100);
      switched = true;
      console.log(`[ci-gate] switched ranking config to dual/100 from ${originalConfig.mode}/${originalConfig.dual_ratio}`);
    } catch (e) {
      console.log(`[ci-gate] ranking config API not available, continue without mode switch: ${e.message}`);
    }

    runNode(['scripts/eval_retrieval.mjs', '--k', String(args.k)]);
    runNode([
      'scripts/compare_online_offline.mjs',
      '--k', String(args.k),
      '--sample', String(args.sample),
      '--seed', String(args.seed),
      '--base-url', args.baseUrl,
    ]);
    runNode([
      'scripts/generate_report_sample.mjs',
      '--k', String(args.k),
      '--query-id', args.queryId,
      '--sample', String(args.sample),
      '--seed', String(args.seed),
      '--base-url', args.baseUrl,
      '--out', args.reportOut,
    ]);

    console.log('[ci-gate] all checks passed');
  } finally {
    if (switched && originalConfig) {
      try {
        await setConfig(args.baseUrl, originalConfig.mode, Number(originalConfig.dual_ratio || 0));
        console.log(`[ci-gate] restored ranking config to ${originalConfig.mode}/${originalConfig.dual_ratio}`);
      } catch (e) {
        console.error(`[ci-gate] failed to restore ranking config: ${e.message}`);
      }
    }
  }
}

try {
  await main();
} catch (e) {
  console.error(`[error] ${e.message}`);
  process.exit(1);
}
