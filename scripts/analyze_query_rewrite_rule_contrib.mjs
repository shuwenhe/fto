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
const DEFAULT_OUT_JSON = path.join(ROOT, 'docs', 'query_rewrite_rule_contrib_v1.json');
const DEFAULT_OUT_MD = path.join(ROOT, 'docs', 'query_rewrite_rule_contrib_v1.md');

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
    minNdcgContribution: 0,
    writePrunedRules: '',
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
    else if (a === '--min-ndcg-contribution') args.minNdcgContribution = Number(argv[++i] || '0');
    else if (a === '--write-pruned-rules') args.writePrunedRules = argv[++i] || '';
    else if (a === '--verbose') args.verbose = true;
  }

  if (!Number.isFinite(args.k) || args.k <= 0) args.k = 5;
  if (!Number.isFinite(args.minNdcgContribution)) args.minNdcgContribution = 0;
  return args;
}

function loadRules(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (Array.isArray(parsed.rules)) {
    return parsed.rules
      .map((r) => ({
        match: String(r.match || '').trim(),
        append: Array.isArray(r.append) ? r.append.map((x) => String(x || '').trim()).filter(Boolean) : [],
      }))
      .filter((r) => r.match && r.append.length > 0);
  }
  return Object.entries(parsed)
    .map(([k, v]) => ({
      match: String(k || '').trim(),
      append: Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean) : [],
    }))
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

function evalWithRules({ patents, queries, relByQ, k, model, rules }) {
  const rows = [];
  let rewriteAppliedCount = 0;

  for (const q of queries) {
    const qid = String(q.query_id);
    const query = String(q.query || '');
    const rewritten = rewriteQuery(query, rules);
    if (rewritten.applied) rewriteAppliedCount += 1;

    const pred = rankPatentsDualRecall(patents, rewritten.query, k, model);
    const relMap = relByQ.get(qid) || new Map();
    const relSet = new Set(Array.from(relMap.entries()).filter((x) => x[1] > 0).map((x) => x[0]));

    rows.push({
      query_id: qid,
      recall: recallAtK(pred, relSet),
      mrr: mrrAtK(pred, relSet),
      ndcg: ndcgAtK(pred, relMap, k),
      rewrite_applied: rewritten.applied,
      rewritten_query: rewritten.query,
    });
  }

  return {
    queries: rows.length,
    rewrite_applied_queries: rewriteAppliedCount,
    rewrite_applied_ratio: rows.length ? rewriteAppliedCount / rows.length : 0,
    recall_at_k: avg(rows, 'recall'),
    mrr_at_k: avg(rows, 'mrr'),
    ndcg_at_k: avg(rows, 'ndcg'),
    rows,
  };
}

function buildRuleTermVariants(rules) {
  const variants = [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    for (let j = 0; j < rule.append.length; j++) {
      const term = rule.append[j];
      const copied = rules.map((r, idx) => {
        if (idx !== i) return { match: r.match, append: [...r.append] };
        return { match: r.match, append: r.append.filter((_, tidx) => tidx !== j) };
      });
      const normalized = copied.filter((r) => r.append.length > 0);
      variants.push({
        ruleIndex: i,
        termIndex: j,
        match: rule.match,
        term,
        rules: normalized,
      });
    }
  }
  return variants;
}

function formatDelta(v) {
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(4)}`;
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

  const baseline = evalWithRules({ patents, queries, relByQ, k: args.k, model, rules: [] });
  const full = evalWithRules({ patents, queries, relByQ, k: args.k, model, rules });

  const variants = buildRuleTermVariants(rules);
  const termContrib = [];

  for (const v of variants) {
    const removed = evalWithRules({ patents, queries, relByQ, k: args.k, model, rules: v.rules });
    // contribution = full - removed; negative means the term hurts quality.
    const contrib = {
      match: v.match,
      term: v.term,
      contribution_recall_at_k: full.recall_at_k - removed.recall_at_k,
      contribution_mrr_at_k: full.mrr_at_k - removed.mrr_at_k,
      contribution_ndcg_at_k: full.ndcg_at_k - removed.ndcg_at_k,
      full_ndcg_at_k: full.ndcg_at_k,
      removed_ndcg_at_k: removed.ndcg_at_k,
    };
    termContrib.push(contrib);
  }

  termContrib.sort((a, b) => a.contribution_ndcg_at_k - b.contribution_ndcg_at_k);

  const harmful = termContrib.filter((x) => x.contribution_ndcg_at_k < args.minNdcgContribution);
  const harmfulKey = new Set(harmful.map((x) => `${x.match}@@${x.term}`));

  const prunedRules = rules
    .map((r) => ({
      match: r.match,
      append: r.append.filter((term) => !harmfulKey.has(`${r.match}@@${term}`)),
    }))
    .filter((r) => r.append.length > 0);

  const prunedEval = evalWithRules({ patents, queries, relByQ, k: args.k, model, rules: prunedRules });

  const report = {
    generated_at: new Date().toISOString(),
    k: args.k,
    min_ndcg_contribution: args.minNdcgContribution,
    baseline_no_rewrite: baseline,
    full_rules: full,
    term_contributions: termContrib,
    harmful_terms: harmful,
    pruned_rules_eval: prunedEval,
    summary: {
      full_vs_baseline: {
        recall_delta: full.recall_at_k - baseline.recall_at_k,
        mrr_delta: full.mrr_at_k - baseline.mrr_at_k,
        ndcg_delta: full.ndcg_at_k - baseline.ndcg_at_k,
      },
      pruned_vs_baseline: {
        recall_delta: prunedEval.recall_at_k - baseline.recall_at_k,
        mrr_delta: prunedEval.mrr_at_k - baseline.mrr_at_k,
        ndcg_delta: prunedEval.ndcg_at_k - baseline.ndcg_at_k,
      },
      pruned_vs_full: {
        recall_delta: prunedEval.recall_at_k - full.recall_at_k,
        mrr_delta: prunedEval.mrr_at_k - full.mrr_at_k,
        ndcg_delta: prunedEval.ndcg_at_k - full.ndcg_at_k,
      },
    },
    pruned_rules,
  };

  fs.mkdirSync(path.dirname(args.outJson), { recursive: true });
  fs.mkdirSync(path.dirname(args.outMd), { recursive: true });
  fs.writeFileSync(args.outJson, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');

  const md = [
    '# Query Rewrite Rule Contribution Report',
    '',
    `- K: ${args.k}`,
    `- Rules file: ${args.rules}`,
    `- Harmful threshold (ndcg contribution): < ${args.minNdcgContribution}`,
    '',
    '## Overall',
    '',
    '| Variant | Recall@K | MRR@K | NDCG@K |',
    '| --- | ---: | ---: | ---: |',
    `| Baseline (no rewrite) | ${baseline.recall_at_k.toFixed(4)} | ${baseline.mrr_at_k.toFixed(4)} | ${baseline.ndcg_at_k.toFixed(4)} |`,
    `| Full rules | ${full.recall_at_k.toFixed(4)} | ${full.mrr_at_k.toFixed(4)} | ${full.ndcg_at_k.toFixed(4)} |`,
    `| Pruned rules | ${prunedEval.recall_at_k.toFixed(4)} | ${prunedEval.mrr_at_k.toFixed(4)} | ${prunedEval.ndcg_at_k.toFixed(4)} |`,
    '',
    '## Term Contribution (full - remove_term)',
    '',
    '| Match | Term | dRecall | dMRR | dNDCG |',
    '| --- | --- | ---: | ---: | ---: |',
  ];

  for (const row of termContrib) {
    md.push(`| ${row.match} | ${row.term} | ${formatDelta(row.contribution_recall_at_k)} | ${formatDelta(row.contribution_mrr_at_k)} | ${formatDelta(row.contribution_ndcg_at_k)} |`);
  }

  md.push('');
  md.push('## Harmful Terms');
  md.push('');
  if (harmful.length === 0) {
    md.push('- none');
  } else {
    for (const row of harmful) {
      md.push(`- ${row.match} -> ${row.term} (dNDCG=${formatDelta(row.contribution_ndcg_at_k)})`);
    }
  }
  md.push('');
  fs.writeFileSync(args.outMd, `${md.join('\n')}\n`, 'utf-8');

  if (args.writePrunedRules) {
    const output = { rules: prunedRules };
    fs.mkdirSync(path.dirname(args.writePrunedRules), { recursive: true });
    fs.writeFileSync(args.writePrunedRules, `${JSON.stringify(output, null, 2)}\n`, 'utf-8');
    console.log(`[ok] pruned_rules_written=${args.writePrunedRules}`);
  }

  console.log(`[ok] baseline_ndcg=${baseline.ndcg_at_k.toFixed(4)}`);
  console.log(`[ok] full_ndcg=${full.ndcg_at_k.toFixed(4)} delta=${formatDelta(full.ndcg_at_k - baseline.ndcg_at_k)}`);
  console.log(`[ok] pruned_ndcg=${prunedEval.ndcg_at_k.toFixed(4)} delta_vs_baseline=${formatDelta(prunedEval.ndcg_at_k - baseline.ndcg_at_k)} delta_vs_full=${formatDelta(prunedEval.ndcg_at_k - full.ndcg_at_k)}`);
  console.log(`[ok] harmful_terms=${harmful.length}`);
  console.log(`[ok] out_json=${args.outJson}`);
  console.log(`[ok] out_md=${args.outMd}`);

  if (args.verbose) {
    console.log('--- harmful terms ---');
    for (const row of harmful) {
      console.log(`${row.match} -> ${row.term}: dNDCG=${formatDelta(row.contribution_ndcg_at_k)}`);
    }
  }
}

try {
  main();
} catch (e) {
  console.error(`[error] ${e.message}`);
  process.exit(1);
}
