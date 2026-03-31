#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { loadDualRecallModel, rankPatentsDualRecall, readJsonl } from './lib/retrieval_ranker.mjs';

const ROOT = '/app/fto';
const DEFAULT_PATENTS = path.join(ROOT, 'data_sources', 'patents.jsonl');
const DEFAULT_QUERIES = path.join(ROOT, 'data_sources', 'queries.jsonl');
const DEFAULT_QRELS = path.join(ROOT, 'data_sources', 'qrels.jsonl');
const DEFAULT_RECALL_MODEL = path.join(ROOT, 'model_artifacts', 'fto_recall_dual_v1.json');
const DEFAULT_RERANKER_MODEL = path.join(ROOT, 'model_artifacts', 'fto_reranker_neurx_v1.json');

const FEATURE_NAMES = [
  'title_score',
  'abstract_score',
  'claim_score',
  'keyword_hits',
  'matched_count',
  'token_count',
  'lexical_score',
  'semantic_score',
  'lexical_norm',
  'semantic_norm',
];

function parseArgs(argv) {
  const args = {
    k: 5,
    candidateK: 24,
    patents: DEFAULT_PATENTS,
    queries: DEFAULT_QUERIES,
    qrels: DEFAULT_QRELS,
    recallModel: DEFAULT_RECALL_MODEL,
    model: DEFAULT_RERANKER_MODEL,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--k') args.k = Number(argv[++i] || '5');
    else if (arg === '--candidate-k') args.candidateK = Number(argv[++i] || '24');
    else if (arg === '--patents') args.patents = argv[++i] || DEFAULT_PATENTS;
    else if (arg === '--queries') args.queries = argv[++i] || DEFAULT_QUERIES;
    else if (arg === '--qrels') args.qrels = argv[++i] || DEFAULT_QRELS;
    else if (arg === '--recall-model') args.recallModel = argv[++i] || DEFAULT_RECALL_MODEL;
    else if (arg === '--model') args.model = argv[++i] || DEFAULT_RERANKER_MODEL;
    else if (arg === '--verbose') args.verbose = true;
  }
  if (!Number.isFinite(args.k) || args.k <= 0) args.k = 5;
  if (!Number.isFinite(args.candidateK) || args.candidateK <= 0) args.candidateK = 24;
  return args;
}

function normalize(s) {
  return String(s || '').toLowerCase().trim();
}

function uniqueTokens(tokens) {
  const out = [];
  const seen = new Set();
  for (const tokenRaw of tokens) {
    const token = normalize(tokenRaw);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function splitQuery(query) {
  const text = normalize(query);
  if (!text) return [];
  const tokens = [text];
  const parts = text.split(/[\s,，。；;：:、|/\\()\[\]{}<>]+/).filter((x) => [...x].length >= 2);
  tokens.push(...parts);
  return uniqueTokens(tokens);
}

function containsAny(haystack, tokens) {
  const text = normalize(haystack);
  let score = 0;
  const matched = [];
  for (const token of tokens) {
    if (text.includes(token)) {
      score += 1;
      matched.push(token);
    }
  }
  return { score, matched };
}

function splitWords(text) {
  const normalized = normalize(text);
  if (!normalized) return [];
  return normalized
    .split(/[\s,，。；;：:、|/\\()\[\]{}<>_+\-=*&#@!?\'\"]+/)
    .filter((x) => [...x].length >= 2);
}

function isCJK(ch) {
  const cp = ch.codePointAt(0);
  return cp >= 0x4e00 && cp <= 0x9fff;
}

function cjkBigrams(text) {
  const runes = Array.from(normalize(text));
  const out = [];
  for (let i = 0; i < runes.length - 1; i++) {
    if (!isCJK(runes[i]) || !isCJK(runes[i + 1])) continue;
    out.push(runes[i] + runes[i + 1]);
  }
  return out;
}

function buildSemanticVector(text) {
  const vec = new Map();
  for (const token of splitWords(text)) vec.set(token, (vec.get(token) || 0) + 1);
  for (const bigram of cjkBigrams(text)) vec.set(bigram, (vec.get(bigram) || 0) + 1);
  return vec;
}

function cosineSim(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [key, value] of a.entries()) {
    na += value * value;
    if (b.has(key)) dot += value * b.get(key);
  }
  for (const value of b.values()) nb += value * value;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function sigmoid(value) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function loadRerankerModel(modelPath) {
  const model = JSON.parse(fs.readFileSync(modelPath, 'utf-8'));
  if (!Array.isArray(model.feature_names) || model.feature_names.length !== FEATURE_NAMES.length) {
    throw new Error(`invalid reranker model at ${modelPath}: feature_names mismatch`);
  }
  if (!Array.isArray(model.weights) || model.weights.length !== FEATURE_NAMES.length) {
    throw new Error(`invalid reranker model at ${modelPath}: weights mismatch`);
  }
  return model;
}

function linearScore(model, features) {
  let sum = Number(model.bias || 0);
  for (let i = 0; i < features.length; i++) {
    let std = Number(model.feature_stds[i] || 1);
    if (Math.abs(std) < 1e-9) std = 1;
    const mean = Number(model.feature_means[i] || 0);
    sum += ((features[i] - mean) / std) * Number(model.weights[i] || 0);
  }
  return String(model.activation || 'sigmoid').toLowerCase() === 'sigmoid' ? sigmoid(sum) : sum;
}

function buildCandidateRows(patentById, query, candidateIds) {
  const tokens = splitQuery(query);
  if (tokens.length === 0) return [];
  const queryVec = buildSemanticVector(query);
  const rows = [];
  let maxLex = 0;
  let maxSem = 0;

  for (const patentId of candidateIds) {
    const rec = patentById.get(String(patentId));
    if (!rec) continue;

    const titleRes = containsAny(rec.title, tokens);
    const absRes = containsAny(rec.abstract, tokens);
    const claimRes = containsAny(rec.claim, tokens);

    let keywordHits = 0;
    const keywordMatched = [];
    const kws = Array.isArray(rec.keywords) ? rec.keywords : [];
    for (const kw of kws) {
      const kwNorm = normalize(kw);
      for (const token of tokens) {
        if (kwNorm.includes(token) || token.includes(kwNorm)) {
          keywordHits += 1;
          keywordMatched.push(token);
        }
      }
    }

    const lexical = titleRes.score * 4 + absRes.score * 2 + claimRes.score * 3 + keywordHits * 2;
    const docText = `${rec.title || ''} ${rec.abstract || ''} ${rec.claim || ''} ${kws.join(' ')}`;
    const semantic = cosineSim(queryVec, buildSemanticVector(docText));
    const matched = Array.from(new Set([...titleRes.matched, ...absRes.matched, ...claimRes.matched, ...keywordMatched]));
    rows.push({
      patent_id: String(rec.patent_id),
      title_score: titleRes.score,
      abstract_score: absRes.score,
      claim_score: claimRes.score,
      keyword_hits: keywordHits,
      matched_count: matched.length,
      token_count: tokens.length,
      lexical_score: lexical,
      semantic_score: semantic,
    });
    if (lexical > maxLex) maxLex = lexical;
    if (semantic > maxSem) maxSem = semantic;
  }

  for (const row of rows) {
    row.lexical_norm = maxLex > 0 ? row.lexical_score / maxLex : 0;
    row.semantic_norm = maxSem > 0 ? row.semantic_score / maxSem : 0;
    row.features = FEATURE_NAMES.map((name) => Number(row[name] || 0));
  }

  return rows;
}

function recallAtK(pred, relSet) {
  if (relSet.size === 0) return 0;
  let hit = 0;
  for (const patentId of pred) if (relSet.has(patentId)) hit += 1;
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
  const ideal = Array.from(relMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map((entry) => entry[0]);
  const idcg = dcgAtK(ideal, relMap);
  if (idcg === 0) return 0;
  return dcgAtK(pred, relMap) / idcg;
}

function main() {
  const args = parseArgs(process.argv);
  const patents = readJsonl(args.patents);
  const patentById = new Map(patents.map((row) => [String(row.patent_id), row]));
  const queries = readJsonl(args.queries);
  const qrels = readJsonl(args.qrels);
  const recallModel = loadDualRecallModel(args.recallModel);
  const rerankerModel = loadRerankerModel(args.model);

  const relByQuery = new Map();
  for (const row of qrels) {
    const queryId = String(row.query_id);
    const patentId = String(row.patent_id);
    const rel = Number(row.relevance || 0);
    if (!relByQuery.has(queryId)) relByQuery.set(queryId, new Map());
    relByQuery.get(queryId).set(patentId, rel);
  }

  const rows = [];
  for (const queryRow of queries) {
    const queryId = String(queryRow.query_id);
    const queryText = String(queryRow.query || '');
    const candidateIds = rankPatentsDualRecall(patents, queryText, args.candidateK, recallModel);
    const candidateRows = buildCandidateRows(patentById, queryText, candidateIds);
    for (const row of candidateRows) row.score = linearScore(rerankerModel, row.features);
    candidateRows.sort((a, b) => b.score - a.score || b.lexical_score - a.lexical_score);

    const topk = candidateRows.slice(0, args.k).map((row) => row.patent_id);
    const relMap = relByQuery.get(queryId) || new Map();
    const relSet = new Set(Array.from(relMap.entries()).filter((entry) => entry[1] > 0).map((entry) => entry[0]));

    rows.push({
      query_id: queryId,
      candidates: candidateIds,
      topk,
      recall: recallAtK(topk, relSet),
      mrr: mrrAtK(topk, relSet),
      ndcg: ndcgAtK(topk, relMap, args.k),
    });
  }

  const avg = (key) => (rows.length ? rows.reduce((sum, row) => sum + row[key], 0) / rows.length : 0);

  console.log(`RerankEval@${args.k}`);
  console.log(`candidate_k=${args.candidateK}`);
  console.log(`recall_model=${args.recallModel}`);
  console.log(`model=${args.model}`);
  console.log(`queries=${rows.length}`);
  console.log(`Recall@${args.k}=${avg('recall').toFixed(4)}`);
  console.log(`MRR@${args.k}=${avg('mrr').toFixed(4)}`);
  console.log(`NDCG@${args.k}=${avg('ndcg').toFixed(4)}`);

  if (args.verbose) {
    console.log('--- per-query ---');
    for (const row of rows) {
      console.log(
        `${row.query_id}: recall=${row.recall.toFixed(4)} mrr=${row.mrr.toFixed(4)} ndcg=${row.ndcg.toFixed(4)} ` +
          `topk=${row.topk.join(',')} candidates=${row.candidates.join(',')}`,
      );
    }
  }
}

try {
  main();
} catch (error) {
  console.error(`[error] ${error.message}`);
  process.exit(1);
}