#!/usr/bin/env python3

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import neurx
import neurx.nn as nn
import neurx.optim as optim

ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = ROOT / "scripts"
RERANKER_DIR = ROOT / "model" / "reranker"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
if str(RERANKER_DIR) not in sys.path:
    sys.path.insert(0, str(RERANKER_DIR))

from train_fto_model_neurx import (  # noqa: E402
    DEFAULT_PATENTS,
    DEFAULT_QRELS,
    DEFAULT_QUERIES,
    FEATURE_NAMES,
    build_dataset,
    load_recall_params,
    read_jsonl,
    standardize_features,
)

DEFAULT_RECALL_MODEL = ROOT / "model_artifacts" / "fto_recall_dual_v1.json"
DEFAULT_OUT = ROOT / "model_artifacts" / "fto_encoder_neurx_v1.json"


def train_model(samples, epochs, lr, embedding_dim):
    features = neurx.Tensor([sample["scaled_features"] for sample in samples], requires_grad=False)
    targets = neurx.Tensor([[sample["target"]] for sample in samples], requires_grad=False)
    weights = neurx.Tensor([[sample["weight"]] for sample in samples], requires_grad=False)

    extractor = nn.Linear(len(FEATURE_NAMES), embedding_dim)
    head = nn.Linear(embedding_dim, 1)
    extractor_optimizer = optim.Adam(extractor.parameters(), lr=lr)
    head_optimizer = optim.Adam(head.parameters(), lr=lr)

    for _ in range(epochs):
        extractor.zero_grad()
        head.zero_grad()
        embeddings = extractor(features).sigmoid()
        preds = head(embeddings).sigmoid()
        diff = preds - targets
        loss = ((diff * diff) * weights).mean()
        loss.backward()
        extractor_optimizer.step()
        head_optimizer.step()

    embeddings_np = extractor(features).sigmoid().to_numpy().tolist()
    preds = head(neurx.Tensor(embeddings_np, requires_grad=False)).sigmoid().to_numpy().reshape(-1).tolist()
    targets_flat = targets.to_numpy().reshape(-1).tolist()
    mse = sum((preds[idx] - targets_flat[idx]) ** 2 for idx in range(len(preds))) / len(preds)
    return extractor, head, embeddings_np, mse


def score_sample(extractor, head, means, stds, features):
    scaled = [(features[idx] - means[idx]) / stds[idx] for idx in range(len(features))]
    tensor = neurx.Tensor([scaled], requires_grad=False)
    embedding = extractor(tensor).sigmoid()
    score = head(embedding).sigmoid().to_numpy().reshape(-1)[0]
    return float(score), embedding.to_numpy().reshape(-1).tolist()


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


def evaluate(extractor, head, means, stds, ranking_rows, rel_by_query, k):
    rows = []
    for query_id, samples in ranking_rows.items():
        ranked = []
        for sample in samples:
            score, _ = score_sample(extractor, head, means, stds, sample["features"])
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


def summarize_embeddings(embeddings):
    if not embeddings:
        return {"count": 0, "dims": 0, "mean": [], "std": []}
    dims = len(embeddings[0])
    means = [0.0] * dims
    for row in embeddings:
        for idx, value in enumerate(row):
            means[idx] += float(value)
    means = [value / len(embeddings) for value in means]

    stds = [0.0] * dims
    for row in embeddings:
        for idx, value in enumerate(row):
            delta = float(value) - means[idx]
            stds[idx] += delta * delta
    stds = [math.sqrt(value / len(embeddings)) for value in stds]
    return {
        "count": len(embeddings),
        "dims": dims,
        "mean": [float(value) for value in means],
        "std": [float(value) for value in stds],
    }


def export_artifact(extractor, head, means, stds, metrics, embedding_summary, out_path: Path):
    extractor_state = extractor.state_dict()
    head_state = head.state_dict()
    feature_dim = len(FEATURE_NAMES)

    raw_extractor_weights = extractor_state["weight"].tolist()
    extractor_bias = [float(value) for value in extractor_state["bias"].tolist()]
    embedding_dim = len(extractor_bias)

    # neurx Linear may persist weights as [in_dim, out_dim]; backend expects [out_dim, in_dim].
    if (
        len(raw_extractor_weights) == feature_dim
        and raw_extractor_weights
        and len(raw_extractor_weights[0]) == embedding_dim
    ):
        extractor_weights = [
            [float(raw_extractor_weights[in_idx][out_idx]) for in_idx in range(feature_dim)]
            for out_idx in range(embedding_dim)
        ]
    elif (
        len(raw_extractor_weights) == embedding_dim
        and raw_extractor_weights
        and len(raw_extractor_weights[0]) == feature_dim
    ):
        extractor_weights = [[float(value) for value in row] for row in raw_extractor_weights]
    else:
        raise ValueError(
            f"unexpected extractor weight shape: {len(raw_extractor_weights)}x{len(raw_extractor_weights[0]) if raw_extractor_weights else 0}, "
            f"feature_dim={feature_dim}, embedding_dim={embedding_dim}"
        )

    raw_head_weights = head_state["weight"].tolist()
    if (
        len(raw_head_weights) == 1
        and raw_head_weights
        and len(raw_head_weights[0]) == embedding_dim
    ):
        head_weights = [float(value) for value in raw_head_weights[0]]
    elif (
        len(raw_head_weights) == embedding_dim
        and raw_head_weights
        and len(raw_head_weights[0]) == 1
    ):
        head_weights = [float(row[0]) for row in raw_head_weights]
    else:
        flat_head = [float(value) for row in raw_head_weights for value in row]
        if len(flat_head) != embedding_dim:
            raise ValueError(
                f"unexpected head weight shape: {len(raw_head_weights)}x{len(raw_head_weights[0]) if raw_head_weights else 0}, "
                f"embedding_dim={embedding_dim}"
            )
        head_weights = flat_head

    artifact = {
        "model_type": "neurx_feature_encoder",
        "version": 1,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "feature_names": FEATURE_NAMES,
        "feature_means": [float(value) for value in means],
        "feature_stds": [float(value) for value in stds],
        "embedding_dim": embedding_dim,
        "extractor": {
            "weights": extractor_weights,
            "bias": extractor_bias,
            "activation": "sigmoid",
        },
        "head": {
            "weights": head_weights,
            "bias": float(head_state["bias"].tolist()[0]),
            "activation": "sigmoid",
        },
        "embedding_summary": embedding_summary,
        "metrics": metrics,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_args():
    parser = argparse.ArgumentParser(description="Train FTO feature encoder with neurx")
    parser.add_argument("--patents", default=str(DEFAULT_PATENTS))
    parser.add_argument("--queries", default=str(DEFAULT_QUERIES))
    parser.add_argument("--qrels", default=str(DEFAULT_QRELS))
    parser.add_argument("--recall-model", default=str(DEFAULT_RECALL_MODEL))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--epochs", type=int, default=900)
    parser.add_argument("--lr", type=float, default=0.03)
    parser.add_argument("--k", type=int, default=5)
    parser.add_argument("--candidate-k", type=int, default=24)
    parser.add_argument("--embedding-dim", type=int, default=8)
    return parser.parse_args()


def main():
    args = parse_args()
    if args.candidate_k <= 0:
        raise ValueError("candidate-k must be > 0")
    if args.embedding_dim <= 0:
        raise ValueError("embedding-dim must be > 0")

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
    extractor, head, embeddings, train_mse = train_model(
        samples,
        epochs=args.epochs,
        lr=args.lr,
        embedding_dim=args.embedding_dim,
    )
    metrics = evaluate(extractor, head, means, stds, ranking_rows, rel_by_query, args.k)
    metrics["train_mse"] = float(train_mse)
    metrics["candidate_k"] = int(args.candidate_k)
    metrics["embedding_dim"] = int(args.embedding_dim)
    embedding_summary = summarize_embeddings(embeddings)
    export_artifact(extractor, head, means, stds, metrics, embedding_summary, Path(args.out))

    print(f"[ok] samples={len(samples)} queries={metrics['queries']}")
    print(f"[ok] candidate_k={args.candidate_k}")
    print(f"[ok] embedding_dim={args.embedding_dim}")
    print(f"[ok] train_mse={train_mse:.6f}")
    print(f"[ok] Recall@{args.k}={metrics['recall_at_k']:.4f}")
    print(f"[ok] MRR@{args.k}={metrics['mrr_at_k']:.4f}")
    print(f"[ok] NDCG@{args.k}={metrics['ndcg_at_k']:.4f}")
    print(f"[ok] artifact={args.out}")


if __name__ == "__main__":
    main()
