#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { readJsonl, rankPatentsDualRecall, loadDualRecallModel } from './lib/retrieval_ranker.mjs';

const ROOT = '/app/fto';
const DEFAULT_PATENTS = path.join(ROOT, 'data_sources', 'patents.jsonl');
const DEFAULT_QUERIES = path.join(ROOT, 'data_sources', 'queries.jsonl');
const DEFAULT_QRELS = path.join(ROOT, 'data_sources', 'qrels.jsonl');
const DEFAULT_MODEL = path.join(ROOT, 'model_artifacts', 'fto_recall_dual_v1.json');
const DEFAULT_RULES = path.join(ROOT, 'backend', 'config', 'query_rewrite_rules.json');
const DEFAULT_OUT_JSON = path.join(ROOT, 'docs', 'query_rewrite_ab_report_v1.json');
const DEFAULT_OUT_MD = path.join(ROOT, 'docs', 'query_rewrite_ab_report_v1.md');

function parseArgs(argv) {
  const args = {
    k: 5,
    patents: DEFAULT_PATENTS,
    queries: DEFAULT_QUERIES,
    qrels: DEFAULT_QRELS,
    model: DEFAULT_MODEL,
    rules: DEFAULT_RULES,
    outJson: DEFAULT_OUT_JSON,
    outMd: DEFAULT_OUT_MD,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--k') args.k = Number(argv[++i] || '5');
    else if (a === '--patents') args.patents = argv[++i] || DEFAULT_PATENTS;
    else if (a === '--queries') args.queries = argv[++i] || DEFAULT_QUERIES;
    else if (a === '--qrels') args.qrels = argv[++i] || DEFAULT_QRELS;
    else if (a === '--model') args.model = argv[++i] || DEFAULT_MODEL;
    else if (a === '--rules') args.rules = argv[++i] || DEFAULT_RULES;
    else if (a === '--out-json') args.outJson = argv[++i] || DEFAULT_OUT_JSON;
    else if (a === '--out-md') args.outMd = argv[++i] || DEFAULT_OUT_MD;
    else if (a === '--verbose') args.verbose = true;
  }
  if (!Number.isFinite(args.k) || args.k <= 0) args.k = 5;
  return args;
}

function loadRules(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (Array.isArray(parsed.rules)) {
    return parsed.rules
      .map((r) => ({ match: String(r.match || '').trim(), append: Array.isArray(r.append) ? r.append.map((x) => String(x || '').trim()).filter(Boolean) : [] }))
      .filter((r) => r.match && r.append.length > 0);
  }
  return Object.entries(parsed)
    .map(([k, v]) => ({ match: String(k || '').trim(), append: Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean) : [] }))
    .filter((r) => r.match && r.append.length > 0);
}

function rewriteQuery(query, rules) {
  let out = String(query || '').trim();
  if (!out) return { query: out, applied: false };
  let applied = false;
  for (const rule of rules) {
    if (!out.includes(rule.match)) continue;
    for (const ex of rule.append) {
      if (!ex || out.includes(ex)) continue;
      out += ` ${ex}`;
      applied = true;
    }
  }
  return { query: out.trim(), applied };
}

function recallAtK(pred, relSet) {
  if (relSet.size === 0) return 0;
  let hit = 0;
  for (const id of pred) if (relSet.has(id)) hit += 1;
  return hit / relSet.size;
}

function mrrAtK(pred, relSet) {
  for (let i = 0; i < pred.length; i++) {
    if (relSet.has(pred[i])) return 1 / (i + 1);
  }
  return 0;
}

function dcgAtK(pred, relMap) {
  let sum = 0;
  for (let i = 0; i < pred.length; i++) {
    const rel = relMap.get(pred[i]) || 0;
    const gain = Math.pow(2, rel) - 1;
    const discount = Math.log2(i + 2);
    sum += gain / discount;
  }
  return sum;
}

function ndcgAtK(pred, relMap, k) {
  const dcg = dcgAtK(pred, relMap);
  const ideal = Array.from(relMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, k).map((x) => x[0]);
  const idcg = dcgAtK(ideal, relMap);
  return idcg === 0 ? 0 : dcg / idcg;
}

function avg(rows, key) {
  return rows.length ? rows.reduce((s, r) => s + r[key], 0) / rows.length : 0;
}

function formatPct(delta) {
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toFixed(4)}`;
}

function main() {
  const args = parseArgs(process.argv);
  const patents = readJsonl(args.patents);
  const queries = readJsonl(args.queries);
  const qrels = readJsonl(args.qrels);
  const model = args.model ? loadDualRecallModel(args.model) : undefined;
  const rules = loadRules(args.rules);

  const relByQ = new Map();
  for (const r of qrels) {
    const qid = String(r.query_id);
    const pid = String(r.patent_id);
    const rel = Number(r.relevance || 0);
    if (!relByQ.has(qid)) relByQ.set(qid, new Map());
    relByQ.get(qid).set(pid, rel);
  }

  const rows = [];
  let rewriteAppliedCount = 0;
  for (const q of queries) {
    const qid = String(q.query_id);
    const originalQuery = String(q.query || '');
    const rewritten = rewriteQuery(originalQuery, rules);
    if (rewritten.applied) rewriteAppliedCount += 1;

    const predA = rankPatentsDualRecall(patents, originalQuery, args.k, model);
    const predB = rankPatentsDualRecall(patents, rewritten.query, args.k, model);

    const relMap = relByQ.get(qid) || new Map();
    const relSet = new Set(Array.from(relMap.entries()).filter((x) => x[1] > 0).map((x) => x[0]));

    const a = {
      recall: recallAtK(predA, relSet),
      mrr: mrrAtK(predA, relSet),
      ndcg: ndcgAtK(predA, relMap, args.k),
    };
    const b = {
      recall: recallAtK(predB, relSet),
      mrr: mrrAtK(predB, relSet),
      ndcg: ndcgAtK(predB, relMap, args.k),
    };

    rows.push({
      query_id: qid,
      query: originalQuery,
      rewritten_query: rewritten.query,
      rewrite_applied: rewritten.applied,
      base: a,
      rewrite: b,
      delta: {
        recall: b.recall - a.recall,
        mrr: b.mrr - a.mrr,
        ndcg: b.ndcg - a.ndcg,
      },
      topk_base: predA,
      topk_rewrite: predB,
    });
  }

  const summary = {
    k: args.k,
    queries: rows.length,
    rewrite_rules: args.rules,
    rewrite_applied_queries: rewriteAppliedCount,
    rewrite_applied_ratio: rows.length ? rewriteAppliedCount / rows.length : 0,
    base: {
      recall_at_k: avg(rows.map((r) => r.base), 'recall'),
      mrr_at_k: avg(rows.map((r) => r.base), 'mrr'),
      ndcg_at_k: avg(rows.map((r) => r.base), 'ndcg'),
    },
    rewrite: {
      recall_at_k: avg(rows.map((r) => r.rewrite), 'recall'),
      mrr_at_k: avg(rows.map((r) => r.rewrite), 'mrr'),
      ndcg_at_k: avg(rows.map((r) => r.rewrite), 'ndcg'),
    },
  };
  summary.delta = {
    recall_at_k: summary.rewrite.recall_at_k - summary.base.recall_at_k,
    mrr_at_k: summary.rewrite.mrr_at_k - summary.base.mrr_at_k,
    ndcg_at_k: summary.rewrite.ndcg_at_k - summary.base.ndcg_at_k,
  };

  const report = {
    generated_at: new Date().toISOString(),
    summary,
    rows,
  };

  fs.mkdirSync(path.dirname(args.outJson), { recursive: true });
  fs.mkdirSync(path.dirname(args.outMd), { recursive: true });
  fs.writeFileSync(args.outJson, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');

  const md = [
    '# Query Rewrite A/B Report',
    '',
    `- K: ${summary.k}`,
    `- Queries: ${summary.queries}`,
    `- Rewrite applied: ${summary.rewrite_applied_queries}/${summary.queries} (${(summary.rewrite_applied_ratio * 100).toFixed(2)}%)`,
    `- Rules: ${summary.rewrite_rules}`,
    '',
    '## Summary',
    '',
    '| Metric | Base | Rewrite | Delta |',
    '| --- | ---: | ---: | ---: |',
    `| Recall@${summary.k} | ${summary.base.recall_at_k.toFixed(4)} | ${summary.rewrite.recall_at_k.toFixed(4)} | ${formatPct(summary.delta.recall_at_k)} |`,
    `| MRR@${summary.k} | ${summary.base.mrr_at_k.toFixed(4)} | ${summary.rewrite.mrr_at_k.toFixed(4)} | ${formatPct(summary.delta.mrr_at_k)} |`,
    `| NDCG@${summary.k} | ${summary.base.ndcg_at_k.toFixed(4)} | ${summary.rewrite.ndcg_at_k.toFixed(4)} | ${formatPct(summary.delta.ndcg_at_k)} |`,
    '',
    '## Per Query Delta (Top 10 by NDCG gain)',
    '',
    '| Query ID | Rewrite Applied | Delta Recall | Delta MRR | Delta NDCG |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];

  const top = [...rows]
    .sort((a, b) => b.delta.ndcg - a.delta.ndcg)
    .slice(0, 10);
  for (const row of top) {
    md.push(`| ${row.query_id} | ${row.rewrite_applied ? 'yes' : 'no'} | ${formatPct(row.delta.recall)} | ${formatPct(row.delta.mrr)} | ${formatPct(row.delta.ndcg)} |`);
  }
  md.push('');
  fs.writeFileSync(args.outMd, `${md.join('\n')}\n`, 'utf-8');

  console.log(`[ok] queries=${summary.queries}`);
  console.log(`[ok] rewrite_applied=${summary.rewrite_applied_queries}`);
  console.log(`[ok] Recall@${summary.k} base=${summary.base.recall_at_k.toFixed(4)} rewrite=${summary.rewrite.recall_at_k.toFixed(4)} delta=${formatPct(summary.delta.recall_at_k)}`);
  console.log(`[ok] MRR@${summary.k} base=${summary.base.mrr_at_k.toFixed(4)} rewrite=${summary.rewrite.mrr_at_k.toFixed(4)} delta=${formatPct(summary.delta.mrr_at_k)}`);
  console.log(`[ok] NDCG@${summary.k} base=${summary.base.ndcg_at_k.toFixed(4)} rewrite=${summary.rewrite.ndcg_at_k.toFixed(4)} delta=${formatPct(summary.delta.ndcg_at_k)}`);
  console.log(`[ok] out_json=${args.outJson}`);
  console.log(`[ok] out_md=${args.outMd}`);

  if (args.verbose) {
    console.log('--- per-query ---');
    for (const row of rows) {
      console.log(`${row.query_id}: applied=${row.rewrite_applied} dRecall=${formatPct(row.delta.recall)} dMRR=${formatPct(row.delta.mrr)} dNDCG=${formatPct(row.delta.ndcg)}`);
    }
  }
}

try {
  main();
} catch (e) {
  console.error(`[error] ${e.message}`);
  process.exit(1);
}
