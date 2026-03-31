#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const ROOT = '/app/fto';
const JSONL_PATH = path.join(ROOT, 'data_sources', 'patents.jsonl');
const JSON_PATH = path.join(ROOT, 'data_sources', 'patents.json');

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').map((x) => x.trim()).filter(Boolean);
  const records = [];
  for (const line of lines) {
    records.push(JSON.parse(line));
  }
  return records;
}

function writeJsonl(filePath, records) {
  const content = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf-8');
}

function readJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return [];
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error(`${filePath} must be a JSON array`);
  }
  return data;
}

function writeJsonArray(filePath, records) {
  fs.writeFileSync(filePath, JSON.stringify(records, null, 2) + '\n', 'utf-8');
}

function dedupeByPatentID(records) {
  const map = new Map();
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    const id = String(rec.patent_id || '').trim();
    if (!id) continue;
    map.set(id, { ...rec, patent_id: id });
  }
  return Array.from(map.values()).sort((a, b) => a.patent_id.localeCompare(b.patent_id));
}

function chooseSource() {
  const hasJsonl = fs.existsSync(JSONL_PATH);
  const hasJson = fs.existsSync(JSON_PATH);

  if (!hasJsonl && !hasJson) {
    throw new Error('Neither patents.jsonl nor patents.json exists');
  }
  if (hasJsonl && !hasJson) return 'jsonl';
  if (!hasJsonl && hasJson) return 'json';

  const mJsonl = fs.statSync(JSONL_PATH).mtimeMs;
  const mJson = fs.statSync(JSON_PATH).mtimeMs;
  return mJsonl >= mJson ? 'jsonl' : 'json';
}

function main() {
  const source = chooseSource();
  let records;

  if (source === 'jsonl') {
    records = dedupeByPatentID(readJsonl(JSONL_PATH));
  } else {
    records = dedupeByPatentID(readJsonArray(JSON_PATH));
  }

  writeJsonl(JSONL_PATH, records);
  writeJsonArray(JSON_PATH, records);

  console.log(`[ok] source=${source}`);
  console.log(`[ok] records=${records.length}`);
  console.log(`[ok] synced: ${JSONL_PATH}`);
  console.log(`[ok] synced: ${JSON_PATH}`);
}

try {
  main();
} catch (err) {
  console.error(`[error] ${err.message}`);
  process.exit(1);
}
