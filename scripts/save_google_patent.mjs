#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const ROOT = '/app/fto';
const DATA_FILE = path.join(ROOT, 'data_sources', 'patents.jsonl');

function decodeHtml(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(text) {
  return decodeHtml(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function firstMatch(html, regex, fallback = '') {
  const m = html.match(regex);
  return m && m[1] ? stripTags(m[1]) : fallback;
}

function extractKeywords(title, abs, patentId) {
  const seed = `${title} ${abs} ${patentId}`.toLowerCase();
  const words = seed
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .filter((w) => !['patent', 'google', 'method', 'system', 'device', 'comprising'].includes(w));
  const uniq = [];
  const seen = new Set();
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      uniq.push(w);
    }
    if (uniq.length >= 6) break;
  }
  return uniq;
}

async function fetchPatentRecord(patentId) {
  const url = `https://patents.google.com/patent/${encodeURIComponent(patentId)}/en`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });

  if (!res.ok) {
    throw new Error(`fetch failed for ${patentId}: HTTP ${res.status}`);
  }

  const html = await res.text();

  const title =
    firstMatch(html, /<meta\s+name=["']DC\.title["']\s+content=["']([^"']+)["']/i) ||
    firstMatch(html, /<title>([^<]+)<\/title>/i, patentId);

  const abstract =
    firstMatch(html, /<meta\s+name=["']DC\.description["']\s+content=["']([^"']+)["']/i) ||
    firstMatch(html, /<div[^>]*class=["'][^"']*abstract[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);

  const legalStatus =
    firstMatch(html, /itemprop=["']legalStatus["'][^>]*>([^<]+)/i) ||
    firstMatch(html, /<meta\s+scheme=["']status["']\s+content=["']([^"']+)["']/i, 'unknown');

  const claim = firstMatch(
    html,
    /<section[^>]*itemprop=["']claims["'][^>]*>[\s\S]*?<div[^>]*class=["'][^"']*claim-text[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    ''
  );

  return {
    patent_id: patentId,
    title: title || patentId,
    abstract: abstract || '',
    claim: claim || '',
    keywords: extractKeywords(title || '', abstract || '', patentId),
    legal_status: legalStatus || 'unknown',
  };
}

function loadExisting(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // Skip invalid lines to avoid blocking import.
    }
  }
  return out;
}

function saveJsonl(filePath, records) {
  const content = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf-8');
}

async function main() {
  const args = process.argv.slice(2).map((x) => x.trim()).filter(Boolean);
  if (args.length === 0) {
    console.error('Usage: node scripts/save_google_patent.mjs <PATENT_ID> [PATENT_ID ...]');
    process.exit(1);
  }

  const existing = loadExisting(DATA_FILE);
  const byId = new Map();
  for (const rec of existing) {
    if (rec && rec.patent_id) byId.set(rec.patent_id, rec);
  }

  for (const patentId of args) {
    const rec = await fetchPatentRecord(patentId);
    byId.set(rec.patent_id, rec);
    console.log(`[ok] imported ${patentId}`);
  }

  const merged = Array.from(byId.values()).sort((a, b) => String(a.patent_id).localeCompare(String(b.patent_id)));
  saveJsonl(DATA_FILE, merged);
  console.log(`[ok] saved ${merged.length} records -> ${DATA_FILE}`);
}

main().catch((err) => {
  console.error(`[error] ${err.message}`);
  process.exit(1);
});
