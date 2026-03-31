#!/usr/bin/env node

function parseArgs(argv) {
  const args = {
    baseUrl: 'http://127.0.0.1/fto/api',
    mode: 'lexical',
    dualRatio: 0,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url') args.baseUrl = String(argv[++i] || args.baseUrl).replace(/\/$/, '');
    else if (a === '--mode') args.mode = String(argv[++i] || 'lexical');
    else if (a === '--dual-ratio') args.dualRatio = Number(argv[++i] || '0');
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

async function main() {
  const args = parseArgs(process.argv);
  const before = await getConfig(args.baseUrl);
  const after = await setConfig(args.baseUrl, args.mode, args.dualRatio);

  console.log(`rollback baseUrl=${args.baseUrl}`);
  console.log(`before mode=${before.mode} dual_ratio=${before.dual_ratio}`);
  console.log(`after mode=${after.mode} dual_ratio=${after.dual_ratio}`);
}

try {
  await main();
} catch (e) {
  console.error(`[error] ${e.message}`);
  process.exit(1);
}
