#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const patentsPath = process.argv.includes('--input')
  ? process.argv[process.argv.indexOf('--input') + 1]
  : path.join(root, 'data_sources', 'patents.jsonl');
const baseUrl = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://127.0.0.1:9200';
const index = process.argv.includes('--index')
  ? process.argv[process.argv.indexOf('--index') + 1]
  : 'fto_patents';

async function ensureIndex() {
  const res = await fetch(`${baseUrl}/${index}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mappings: {
        properties: {
          patent_id: { type: 'keyword' },
          title: { type: 'text' },
          abstract: { type: 'text' },
          claim: { type: 'text' },
          keywords: { type: 'text' },
          legal_status: { type: 'keyword' },
        },
      },
    }),
  });
  if (res.ok || res.status === 400) {
    return;
  }
  throw new Error(`create index failed: ${res.status} ${await res.text()}`);
}

async function bulkIndex() {
  const stream = fs.createReadStream(patentsPath, 'utf8');
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let batch = [];
  let total = 0;

  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    const row = JSON.parse(text);
    batch.push(JSON.stringify({ index: { _index: index, _id: row.patent_id } }));
    batch.push(JSON.stringify(row));
    if (batch.length >= 400) {
      await flush(batch);
      total += batch.length / 2;
      batch = [];
    }
  }
  if (batch.length > 0) {
    await flush(batch);
    total += batch.length / 2;
  }
  console.log(`[ok] indexed=${total} index=${index}`);
}

async function flush(batch) {
  const res = await fetch(`${baseUrl}/_bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body: `${batch.join('\n')}\n`,
  });
  if (!res.ok) {
    throw new Error(`bulk index failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  if (data.errors) {
    throw new Error(`bulk index response contains errors`);
  }
}

await ensureIndex();
await bulkIndex();
