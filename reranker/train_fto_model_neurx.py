#!/usr/bin/env python3

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RECALL_DIR = ROOT / "recall"
if str(RECALL_DIR) not in sys.path:
    sys.path.insert(0, str(RECALL_DIR))

import neurx
import neurx.nn as nn
import neurx.optim as optim

from train_fto_recall_model import BASELINE_PARAMS, rank_patents

DEFAULT_PATENTS = ROOT / "data_sources" / "patents.jsonl"
DEFAULT_QUERIES = ROOT / "data_sources" / "queries.jsonl"
DEFAULT_QRELS = ROOT / "data_sources" / "qrels.jsonl"
DEFAULT_RECALL_MODEL = ROOT / "model_artifacts" / "fto_recall_dual_v1.json"
DEFAULT_OUT = ROOT / "model_artifacts" / "fto_reranker_neurx_v1.json"

FEATURE_NAMES = [
    "title_score",
    "abstract_score",
    "claim_score",
    "keyword_hits",
    "matched_count",
    "token_count",
    "lexical_score",
    "semantic_score",
    "lexical_norm",
    "semantic_norm",
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
    matched = []
    for token in tokens:
        if token in haystack:
            score += 1
            matched.append(token)
    return score, matched


def split_words(text):
    text = normalize(text)
    if not text:
        return []
    out = []
    buf = []
    seps = set("，,。；;：:、|/\\()[]{}<>_+-=*&#@!?'\"")
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


def compute_raw_features(record, tokens, query_vec):
    title_score, title_matched = contains_any(record.get("title", ""), tokens)
    abstract_score, abstract_matched = contains_any(record.get("abstract", ""), tokens)
    claim_score, claim_matched = contains_any(record.get("claim", ""), tokens)

    keyword_hits = 0
    keyword_matched = []
    for keyword in record.get("keywords", []):
        keyword_norm = normalize(keyword)
        for token in tokens:
            if token in keyword_norm or keyword_norm in token:
                keyword_hits += 1
                keyword_matched.append(token)

    lexical_score = title_score * 4 + abstract_score * 2 + claim_score * 3 + keyword_hits * 2
    text = " ".join(
        [
            record.get("title", ""),
            record.get("abstract", ""),
            record.get("claim", ""),
            " ".join(record.get("keywords", [])),
        ]
    )
    semantic_score = cosine_sim(query_vec, build_semantic_vector(text))
    matched = sorted(set(title_matched + abstract_matched + claim_matched + keyword_matched))

    return {
        "title_score": float(title_score),
        "abstract_score": float(abstract_score),
        "claim_score": float(claim_score),
        "keyword_hits": float(keyword_hits),
        "matched_count": float(len(matched)),
        "token_count": float(len(tokens)),
        "lexical_score": float(lexical_score),
        "semantic_score": float(semantic_score),
        "patent_id": str(record.get("patent_id", "")),
    }


def finalize_feature_vector(raw, max_lexical, max_semantic):
    lexical_norm = raw["lexical_score"] / max_lexical if max_lexical > 0 else 0.0
    semantic_norm = raw["semantic_score"] / max_semantic if max_semantic > 0 else 0.0
    values = {
        **raw,
        "lexical_norm": lexical_norm,
        "semantic_norm": semantic_norm,
    }
    return [float(values[name]) for name in FEATURE_NAMES]


def load_recall_params(path: Path):
    if not path.exists():
        return dict(BASELINE_PARAMS)

    parsed = json.loads(path.read_text(encoding="utf-8"))
    params = parsed.get("params", parsed) if isinstance(parsed, dict) else {}
    if not isinstance(params, dict):
        raise ValueError(f"invalid recall model at {path}: missing params")

    return {
        "titleWeight": float(params.get("titleWeight", BASELINE_PARAMS["titleWeight"])),
        "abstractWeight": float(params.get("abstractWeight", BASELINE_PARAMS["abstractWeight"])),
        "claimWeight": float(params.get("claimWeight", BASELINE_PARAMS["claimWeight"])),
        "keywordWeight": float(params.get("keywordWeight", BASELINE_PARAMS["keywordWeight"])),
        "fusionLexicalWeight": float(
            params.get("fusionLexicalWeight", BASELINE_PARAMS["fusionLexicalWeight"])
        ),
        "recallDepthMultiplier": max(
            1, int(params.get("recallDepthMultiplier", BASELINE_PARAMS["recallDepthMultiplier"]))
        ),
        "recallDepthMin": max(1, int(params.get("recallDepthMin", BASELINE_PARAMS["recallDepthMin"]))),
    }


def build_dataset(patents, queries, qrels, recall_params, candidate_k):
    patent_by_id = {str(row["patent_id"]): row for row in patents}
    rel_by_query = {}
    for row in qrels:
        query_id = str(row["query_id"])
        patent_id = str(row["patent_id"])
        rel_by_query.setdefault(query_id, {})[patent_id] = float(row.get("relevance", 0))

    samples = []
    ranking_rows = {}
    for query in queries:
        query_id = str(query["query_id"])
        query_text = str(query["query"])
        candidate_ids = rank_patents(patents, query_text, candidate_k, recall_params)
        candidate_set = set(candidate_ids)
        tokens = split_query(query_text)
        query_vec = build_semantic_vector(query_text)

        raw_rows = []
        max_lexical = 0.0
        max_semantic = 0.0
        for patent in patents:
            patent_id = str(patent.get("patent_id", ""))
            if patent_id not in candidate_set:
                continue
            raw = compute_raw_features(patent, tokens, query_vec)
            if raw["lexical_score"] <= 0.0 and raw["semantic_score"] <= 0.0:
                continue
            raw_rows.append(raw)
            max_lexical = max(max_lexical, raw["lexical_score"])
            max_semantic = max(max_semantic, raw["semantic_score"])

        query_rows = []
        for raw in raw_rows:
            features = finalize_feature_vector(raw, max_lexical, max_semantic)
            target = rel_by_query.get(query_id, {}).get(raw["patent_id"], 0.0) / 3.0
            weight = 1.0 + rel_by_query.get(query_id, {}).get(raw["patent_id"], 0.0)
            sample = {
                "query_id": query_id,
                "query": query_text,
                "patent_id": raw["patent_id"],
                "features": features,
                "target": float(target),
                "weight": float(weight),
            }
            samples.append(sample)
            query_rows.append(sample)
        ranking_rows[query_id] = query_rows

    if not samples:
        raise ValueError("no training samples built from patents/queries/qrels")
    missing = [pid for pid in {r["patent_id"] for r in qrels} if pid not in patent_by_id]
    if missing:
        raise ValueError(f"qrels references missing patents: {', '.join(sorted(missing))}")
    return samples, ranking_rows, rel_by_query


def standardize_features(samples):
    dims = len(FEATURE_NAMES)
    means = [0.0] * dims
    stds = [0.0] * dims
    count = float(len(samples))

    for sample in samples:
        for idx, value in enumerate(sample["features"]):
            means[idx] += value
    means = [value / count for value in means]

    for sample in samples:
        for idx, value in enumerate(sample["features"]):
            delta = value - means[idx]
            stds[idx] += delta * delta

    stds = [math.sqrt(value / count) if value > 0 else 1.0 for value in stds]
    stds = [value if value > 1e-9 else 1.0 for value in stds]

    for sample in samples:
        sample["scaled_features"] = [
            (value - means[idx]) / stds[idx] for idx, value in enumerate(sample["features"])
        ]
    return means, stds


def train_model(samples, epochs, lr):
    features = neurx.Tensor([sample["scaled_features"] for sample in samples], requires_grad=False)
    targets = neurx.Tensor([[sample["target"]] for sample in samples], requires_grad=False)
    weights = neurx.Tensor([[sample["weight"]] for sample in samples], requires_grad=False)

    model = nn.Linear(len(FEATURE_NAMES), 1)
    optimizer = optim.Adam(model.parameters(), lr=lr)

    for _ in range(epochs):
        model.zero_grad()
        preds = model(features).sigmoid()
        diff = preds - targets
        loss = ((diff * diff) * weights).mean()
        loss.backward()
        optimizer.step()

    preds = model(features).sigmoid().to_numpy().reshape(-1).tolist()
    targets_flat = targets.to_numpy().reshape(-1).tolist()
    mse = sum((preds[i] - targets_flat[i]) ** 2 for i in range(len(preds))) / len(preds)
    return model, mse


def score_sample(model, means, stds, features):
    scaled = [(features[idx] - means[idx]) / stds[idx] for idx in range(len(features))]
    tensor = neurx.Tensor([scaled], requires_grad=False)
    score = model(tensor).sigmoid().to_numpy().reshape(-1)[0]
    return float(score)


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
        gain = (2 ** rel) - 1
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


def evaluate(model, means, stds, ranking_rows, rel_by_query, k):
    rows = []
    for query_id, samples in ranking_rows.items():
        ranked = []
        for sample in samples:
            score = score_sample(model, means, stds, sample["features"])
            ranked.append((score, sample["patent_id"]))
        ranked.sort(key=lambda item: item[0], reverse=True)
        pred = [patent_id for _, patent_id in ranked[:k]]
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
    return {
        "queries": len(rows),
        "recall_at_k": avg("recall"),
        "mrr_at_k": avg("mrr"),
        "ndcg_at_k": avg("ndcg"),
        "rows": rows,
    }


def export_artifact(model, means, stds, metrics, out_path: Path):
    state = model.state_dict()
    weights = [float(row[0]) for row in state["weight"].tolist()]
    bias = float(state["bias"].tolist()[0])

    artifact = {
        "model_type": "neurx_linear_ranker",
        "version": 1,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "feature_names": FEATURE_NAMES,
        "feature_means": [float(value) for value in means],
        "feature_stds": [float(value) for value in stds],
        "weights": weights,
        "bias": bias,
        "activation": "sigmoid",
        "metrics": metrics,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_args():
    parser = argparse.ArgumentParser(description="Train FTO reranker model with neurx")
    parser.add_argument("--patents", default=str(DEFAULT_PATENTS))
    parser.add_argument("--queries", default=str(DEFAULT_QUERIES))
    parser.add_argument("--qrels", default=str(DEFAULT_QRELS))
    parser.add_argument("--recall-model", default=str(DEFAULT_RECALL_MODEL))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--epochs", type=int, default=800)
    parser.add_argument("--lr", type=float, default=0.05)
    parser.add_argument("--k", type=int, default=5)
    parser.add_argument("--candidate-k", type=int, default=24)
    return parser.parse_args()


def main():
    args = parse_args()
    if args.candidate_k <= 0:
        raise ValueError("candidate-k must be > 0")

    patents = read_jsonl(Path(args.patents))
    queries = read_jsonl(Path(args.queries))
    qrels = read_jsonl(Path(args.qrels))
    recall_params = load_recall_params(Path(args.recall_model))

    samples, ranking_rows, rel_by_query = build_dataset(
        patents,
        queries,
        qrels,
        recall_params=recall_params,
        candidate_k=args.candidate_k,
    )
    means, stds = standardize_features(samples)
    model, train_mse = train_model(samples, args.epochs, args.lr)
    metrics = evaluate(model, means, stds, ranking_rows, rel_by_query, args.k)
    metrics["train_mse"] = train_mse
    metrics["candidate_k"] = int(args.candidate_k)
    export_artifact(model, means, stds, metrics, Path(args.out))

    print(f"[ok] samples={len(samples)} queries={metrics['queries']}")
    print(f"[ok] candidate_k={args.candidate_k}")
    print(f"[ok] train_mse={train_mse:.6f}")
    print(f"[ok] Recall@{args.k}={metrics['recall_at_k']:.4f}")
    print(f"[ok] MRR@{args.k}={metrics['mrr_at_k']:.4f}")
    print(f"[ok] NDCG@{args.k}={metrics['ndcg_at_k']:.4f}")
    print(f"[ok] artifact={args.out}")


if __name__ == "__main__":
    main()
