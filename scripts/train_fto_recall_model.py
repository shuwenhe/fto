#!/usr/bin/env python3

import argparse
import json
import math
import random
from datetime import datetime, timezone
from pathlib import Path

import neurx
import neurx.nn as nn
import neurx.optim as optim

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PATENTS = ROOT / "data_sources" / "patents.jsonl"
DEFAULT_QUERIES = ROOT / "data_sources" / "queries.jsonl"
DEFAULT_QRELS = ROOT / "data_sources" / "qrels.jsonl"
DEFAULT_OUT = ROOT / "model_artifacts" / "fto_recall_dual_v1.json"

BASELINE_PARAMS = {
    "titleWeight": 4.0,
    "abstractWeight": 2.0,
    "claimWeight": 3.0,
    "keywordWeight": 2.0,
    "fusionLexicalWeight": 0.65,
    "recallDepthMultiplier": 3,
    "recallDepthMin": 6,
}

FEATURE_NAMES = [
    "title_score",
    "abstract_score",
    "claim_score",
    "keyword_hits",
    "semantic_score",
]


def read_jsonl(path: Path):
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid jsonl at {path}:{line_no}: {exc}") from exc
    return rows


def normalize(text):
    return str(text or "").strip().lower()


def unique_tokens(tokens):
    out = []
    seen = set()
    for token in tokens:
        token = normalize(token)
        if not token or token in seen:
            continue
        seen.add(token)
        out.append(token)
    return out


def split_query(query):
    query = normalize(query)
    if not query:
        return []
    tokens = [query]
    buf = []
    seps = set("，,。；;：:、|/\\()[]{}<>")
    for ch in query:
        if ch.isspace() or ch in seps:
            if len(buf) >= 2:
                tokens.append("".join(buf))
            buf = []
            continue
        buf.append(ch)
    if len(buf) >= 2:
        tokens.append("".join(buf))
    return unique_tokens(tokens)


def contains_any(haystack, tokens):
    haystack = normalize(haystack)
    score = 0
    for token in tokens:
        if token in haystack:
            score += 1
    return score


def split_words(text):
    text = normalize(text)
    if not text:
        return []
    out = []
    buf = []
    seps = set("，,。；;：:、|/\\()[]{}<>_+-=*&#@!?\'\"")
    for ch in text:
        if ch.isspace() or ch in seps:
            if len(buf) >= 2:
                out.append("".join(buf))
            buf = []
            continue
        buf.append(ch)
    if len(buf) >= 2:
        out.append("".join(buf))
    return out


def is_cjk(ch):
    code = ord(ch)
    return 0x4E00 <= code <= 0x9FFF


def cjk_bigrams(text):
    chars = list(normalize(text))
    out = []
    for idx in range(len(chars) - 1):
        if is_cjk(chars[idx]) and is_cjk(chars[idx + 1]):
            out.append(chars[idx] + chars[idx + 1])
    return out


def build_semantic_vector(text):
    vec = {}
    for token in split_words(text):
        vec[token] = vec.get(token, 0.0) + 1.0
    for token in cjk_bigrams(text):
        vec[token] = vec.get(token, 0.0) + 1.0
    return vec


def cosine_sim(a, b):
    if not a or not b:
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for key, value in a.items():
        na += value * value
        dot += value * b.get(key, 0.0)
    for value in b.values():
        nb += value * value
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / math.sqrt(na * nb)


def score_patent(record, tokens, query_vec, params):
    title_score = contains_any(record.get("title", ""), tokens)
    abstract_score = contains_any(record.get("abstract", ""), tokens)
    claim_score = contains_any(record.get("claim", ""), tokens)

    keyword_hits = 0
    for keyword in record.get("keywords", []):
        keyword_norm = normalize(keyword)
        for token in tokens:
            if token in keyword_norm or keyword_norm in token:
                keyword_hits += 1

    lexical = (
        title_score * params["titleWeight"]
        + abstract_score * params["abstractWeight"]
        + claim_score * params["claimWeight"]
        + keyword_hits * params["keywordWeight"]
    )

    text = " ".join(
        [
            record.get("title", ""),
            record.get("abstract", ""),
            record.get("claim", ""),
            " ".join(record.get("keywords", [])),
        ]
    )
    semantic = cosine_sim(query_vec, build_semantic_vector(text))
    return lexical, semantic


def extract_raw_features(record, tokens, query_vec):
    title_score = float(contains_any(record.get("title", ""), tokens))
    abstract_score = float(contains_any(record.get("abstract", ""), tokens))
    claim_score = float(contains_any(record.get("claim", ""), tokens))

    keyword_hits = 0.0
    for keyword in record.get("keywords", []):
        keyword_norm = normalize(keyword)
        for token in tokens:
            if token in keyword_norm or keyword_norm in token:
                keyword_hits += 1.0

    text = " ".join(
        [
            record.get("title", ""),
            record.get("abstract", ""),
            record.get("claim", ""),
            " ".join(record.get("keywords", [])),
        ]
    )
    semantic_score = float(cosine_sim(query_vec, build_semantic_vector(text)))
    return {
        "title_score": title_score,
        "abstract_score": abstract_score,
        "claim_score": claim_score,
        "keyword_hits": keyword_hits,
        "semantic_score": semantic_score,
    }


def rank_patents(patents, query_text, k, params):
    tokens = split_query(query_text)
    if not tokens:
        return []
    query_vec = build_semantic_vector(query_text)

    rows = []
    max_lexical = 0.0
    max_semantic = 0.0

    for patent in patents:
        lexical, semantic = score_patent(patent, tokens, query_vec, params)
        if lexical <= 0.0 and semantic <= 0.0:
            continue
        rows.append(
            {
                "patent_id": str(patent.get("patent_id", "")),
                "lexical": lexical,
                "semantic": semantic,
                "fusion": 0.0,
            }
        )
        max_lexical = max(max_lexical, lexical)
        max_semantic = max(max_semantic, semantic)

    if not rows:
        return []

    alpha = params["fusionLexicalWeight"]
    for row in rows:
        lexical_norm = row["lexical"] / max_lexical if max_lexical > 0 else 0.0
        semantic_norm = row["semantic"] / max_semantic if max_semantic > 0 else 0.0
        row["fusion"] = lexical_norm * alpha + semantic_norm * (1.0 - alpha)

    idx_lex = sorted(range(len(rows)), key=lambda i: rows[i]["lexical"], reverse=True)
    idx_sem = sorted(range(len(rows)), key=lambda i: rows[i]["semantic"], reverse=True)

    recall_depth = k * int(params["recallDepthMultiplier"])
    recall_depth = max(recall_depth, int(params["recallDepthMin"]))
    recall_depth = min(recall_depth, len(rows))

    candidate_idx = set()
    for i in range(recall_depth):
        if rows[idx_lex[i]]["lexical"] > 0:
            candidate_idx.add(idx_lex[i])
        if rows[idx_sem[i]]["semantic"] > 0:
            candidate_idx.add(idx_sem[i])

    fused = [rows[i] for i in candidate_idx] if candidate_idx else list(rows)
    fused.sort(key=lambda r: (r["fusion"], r["lexical"]), reverse=True)
    return [row["patent_id"] for row in fused[:k]]


def recall_at_k(pred, rel_set):
    if not rel_set:
        return 0.0
    hit = sum(1 for patent_id in pred if patent_id in rel_set)
    return hit / len(rel_set)


def mrr_at_k(pred, rel_set):
    for idx, patent_id in enumerate(pred, start=1):
        if patent_id in rel_set:
            return 1.0 / idx
    return 0.0


def dcg_at_k(pred, rel_map):
    total = 0.0
    for idx, patent_id in enumerate(pred, start=1):
        rel = rel_map.get(patent_id, 0.0)
        gain = (2**rel) - 1
        discount = math.log2(idx + 1)
        total += gain / discount
    return total


def ndcg_at_k(pred, rel_map, k):
    if not rel_map:
        return 0.0
    ideal = [patent_id for patent_id, _ in sorted(rel_map.items(), key=lambda item: item[1], reverse=True)[:k]]
    ideal_dcg = dcg_at_k(ideal, rel_map)
    if ideal_dcg == 0.0:
        return 0.0
    return dcg_at_k(pred, rel_map) / ideal_dcg


def build_rel_by_query(qrels):
    rel_by_query = {}
    for row in qrels:
        query_id = str(row["query_id"])
        patent_id = str(row["patent_id"])
        rel_by_query.setdefault(query_id, {})[patent_id] = float(row.get("relevance", 0))
    return rel_by_query


def evaluate(patents, queries, rel_by_query, params, k):
    rows = []
    for query in queries:
        query_id = str(query["query_id"])
        query_text = str(query["query"])
        pred = rank_patents(patents, query_text, k, params)
        rel_map = rel_by_query.get(query_id, {})
        rel_set = {patent_id for patent_id, rel in rel_map.items() if rel > 0}
        rows.append(
            {
                "query_id": query_id,
                "topk": pred,
                "recall": recall_at_k(pred, rel_set),
                "mrr": mrr_at_k(pred, rel_set),
                "ndcg": ndcg_at_k(pred, rel_map, k),
            }
        )

    avg = lambda key: sum(row[key] for row in rows) / len(rows) if rows else 0.0
    metrics = {
        "queries": len(rows),
        "recall_at_k": avg("recall"),
        "mrr_at_k": avg("mrr"),
        "ndcg_at_k": avg("ndcg"),
        "rows": rows,
    }
    score = metrics["recall_at_k"] * 0.5 + metrics["mrr_at_k"] * 0.3 + metrics["ndcg_at_k"] * 0.2
    return metrics, score


def build_training_samples(patents, queries, rel_by_query, negative_per_query, seed):
    rng = random.Random(seed)
    rows = []

    for query in queries:
        query_id = str(query["query_id"])
        query_text = str(query["query"])
        tokens = split_query(query_text)
        if not tokens:
            continue

        query_vec = build_semantic_vector(query_text)
        features_by_patent = {}
        for patent in patents:
            patent_id = str(patent.get("patent_id", ""))
            feat = extract_raw_features(patent, tokens, query_vec)
            if sum(feat.values()) <= 0.0:
                continue
            features_by_patent[patent_id] = feat

        if not features_by_patent:
            continue

        rel_map = rel_by_query.get(query_id, {})
        positives = [pid for pid, rel in rel_map.items() if rel > 0 and pid in features_by_patent]
        if not positives:
            continue

        negatives_all = [pid for pid in features_by_patent.keys() if pid not in rel_map or rel_map.get(pid, 0.0) <= 0.0]
        if not negatives_all:
            continue

        for patent_id in positives:
            rel = float(rel_map.get(patent_id, 1.0))
            rows.append(
                {
                    "features": [features_by_patent[patent_id][name] for name in FEATURE_NAMES],
                    "label": 1.0,
                    "weight": 1.0 + rel,
                }
            )

        neg_count = max(len(positives), int(negative_per_query))
        sampled_negatives = rng.sample(negatives_all, min(neg_count, len(negatives_all)))
        for patent_id in sampled_negatives:
            rows.append(
                {
                    "features": [features_by_patent[patent_id][name] for name in FEATURE_NAMES],
                    "label": 0.0,
                    "weight": 1.0,
                }
            )

    if not rows:
        raise ValueError("no training samples built from patents/queries/qrels")
    return rows


def train_neurx_recall(samples, epochs, lr):
    features = neurx.Tensor([row["features"] for row in samples], requires_grad=False)
    labels = neurx.Tensor([[row["label"]] for row in samples], requires_grad=False)
    weights = neurx.Tensor([[row["weight"]] for row in samples], requires_grad=False)

    model = nn.Linear(len(FEATURE_NAMES), 1)
    optimizer = optim.Adam(model.parameters(), lr=lr)

    loss_value = 0.0
    for _ in range(epochs):
        model.zero_grad()
        preds = model(features).sigmoid()
        diff = preds - labels
        loss = ((diff * diff) * weights).mean()
        loss.backward()
        optimizer.step()
        loss_value = float(loss.item())

    coeffs = model.weight.data.reshape(-1).tolist()
    return [float(value) for value in coeffs], loss_value


def softplus(value):
    if value > 20:
        return value
    if value < -20:
        return math.exp(value)
    return math.log1p(math.exp(value))


def derive_params_from_coeffs(coeffs):
    raw = [softplus(value) for value in coeffs]
    lexical = [max(0.01, value) for value in raw[:4]]
    semantic = max(0.01, raw[4])

    lexical_mean = sum(lexical) / max(1, len(lexical))
    scale = 3.0 / lexical_mean if lexical_mean > 0 else 1.0
    lexical = [value * scale for value in lexical]

    lexical_total = sum(lexical)
    alpha = lexical_total / (lexical_total + semantic)
    alpha = min(0.95, max(0.05, alpha))

    return {
        "titleWeight": round(lexical[0], 4),
        "abstractWeight": round(lexical[1], 4),
        "claimWeight": round(lexical[2], 4),
        "keywordWeight": round(lexical[3], 4),
        "fusionLexicalWeight": round(alpha, 4),
        "recallDepthMultiplier": BASELINE_PARAMS["recallDepthMultiplier"],
        "recallDepthMin": BASELINE_PARAMS["recallDepthMin"],
    }


def tune_recall_depth(patents, queries, rel_by_query, params, k):
    best_params = dict(params)
    best_metrics, best_score = evaluate(patents, queries, rel_by_query, best_params, k)

    for depth_multiplier in [2, 3, 4, 5, 6, 8]:
        for depth_min in [4, 6, 8, 10, 12, 16, 20]:
            candidate = dict(best_params)
            candidate["recallDepthMultiplier"] = int(depth_multiplier)
            candidate["recallDepthMin"] = int(depth_min)
            metrics, score = evaluate(patents, queries, rel_by_query, candidate, k)
            if score > best_score:
                best_score = score
                best_metrics = metrics
                best_params = candidate
    return best_params, best_metrics, best_score


def sample_params(rng):
    return {
        "titleWeight": round(rng.uniform(1.0, 8.0), 4),
        "abstractWeight": round(rng.uniform(0.5, 6.0), 4),
        "claimWeight": round(rng.uniform(1.0, 8.0), 4),
        "keywordWeight": round(rng.uniform(0.5, 6.0), 4),
        "fusionLexicalWeight": round(rng.uniform(0.2, 0.9), 4),
        "recallDepthMultiplier": rng.randint(2, 8),
        "recallDepthMin": rng.randint(4, 20),
    }


def export_artifact(params, metrics, out_path: Path, k, iterations, seed):
    artifact = {
        "model_type": "fto_dual_recall",
        "version": 1,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "k": int(k),
        "search_iterations": int(iterations),
        "seed": int(seed),
        "params": params,
        "metrics": metrics,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_args():
    parser = argparse.ArgumentParser(description="Train weighted dual-recall model for FTO")
    parser.add_argument("--patents", default=str(DEFAULT_PATENTS))
    parser.add_argument("--queries", default=str(DEFAULT_QUERIES))
    parser.add_argument("--qrels", default=str(DEFAULT_QRELS))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--k", type=int, default=5)
    parser.add_argument("--iterations", type=int, default=300)
    parser.add_argument("--lr", type=float, default=0.03)
    parser.add_argument("--negative-per-query", type=int, default=8)
    parser.add_argument("--seed", type=int, default=20260331)
    return parser.parse_args()


def main():
    args = parse_args()
    if args.k <= 0:
        raise ValueError("k must be > 0")
    if args.iterations <= 0:
        raise ValueError("iterations must be > 0")
    if args.lr <= 0:
        raise ValueError("lr must be > 0")
    if args.negative_per_query <= 0:
        raise ValueError("negative-per-query must be > 0")

    patents = read_jsonl(Path(args.patents))
    queries = read_jsonl(Path(args.queries))
    qrels = read_jsonl(Path(args.qrels))
    rel_by_query = build_rel_by_query(qrels)

    samples = build_training_samples(
        patents,
        queries,
        rel_by_query,
        negative_per_query=args.negative_per_query,
        seed=args.seed,
    )

    coeffs, train_loss = train_neurx_recall(samples, epochs=args.iterations, lr=args.lr)
    learned = derive_params_from_coeffs(coeffs)
    best_params, best_metrics, _ = tune_recall_depth(patents, queries, rel_by_query, learned, args.k)

    export_artifact(best_params, best_metrics, Path(args.out), args.k, args.iterations, args.seed)

    print(f"[ok] queries={best_metrics['queries']}")
    print(f"[ok] Recall@{args.k}={best_metrics['recall_at_k']:.4f}")
    print(f"[ok] MRR@{args.k}={best_metrics['mrr_at_k']:.4f}")
    print(f"[ok] NDCG@{args.k}={best_metrics['ndcg_at_k']:.4f}")
    print(f"[ok] train_loss={train_loss:.6f}")
    print(f"[ok] artifact={args.out}")
    print(f"[ok] params={json.dumps(best_params, ensure_ascii=False)}")


if __name__ == "__main__":
    main()
