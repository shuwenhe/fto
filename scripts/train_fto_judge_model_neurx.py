#!/usr/bin/env python3

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import neurx
import neurx.nn as nn
import neurx.optim as optim

from train_fto_model_neurx import (
    DEFAULT_PATENTS,
    DEFAULT_QRELS,
    DEFAULT_QUERIES,
    build_dataset,
    load_recall_params,
    read_jsonl,
)

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RECALL_MODEL = ROOT / "model_artifacts" / "fto_recall_dual_v1.json"
DEFAULT_RERANKER_MODEL = ROOT / "model_artifacts" / "fto_reranker_neurx_v1.json"
DEFAULT_OUT = ROOT / "model_artifacts" / "fto_judge_neurx_v1.json"

BASE_FEATURE_NAMES = [
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
FEATURE_NAMES = BASE_FEATURE_NAMES + ["reranker_score"]


def sigmoid(value):
    if value >= 0:
        z = math.exp(-value)
        return 1.0 / (1.0 + z)
    z = math.exp(value)
    return z / (1.0 + z)


def load_reranker_artifact(path: Path):
    parsed = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError(f"invalid reranker artifact at {path}")

    weights = parsed.get("weights", [])
    feature_means = parsed.get("feature_means", [])
    feature_stds = parsed.get("feature_stds", [])
    if len(weights) != len(BASE_FEATURE_NAMES):
        raise ValueError(f"invalid reranker artifact at {path}: weights mismatch")
    if len(feature_means) != len(BASE_FEATURE_NAMES):
        raise ValueError(f"invalid reranker artifact at {path}: feature_means mismatch")
    if len(feature_stds) != len(BASE_FEATURE_NAMES):
        raise ValueError(f"invalid reranker artifact at {path}: feature_stds mismatch")

    return {
        "weights": [float(value) for value in weights],
        "bias": float(parsed.get("bias", 0.0)),
        "feature_means": [float(value) for value in feature_means],
        "feature_stds": [float(value) for value in feature_stds],
        "activation": str(parsed.get("activation", "sigmoid")).lower(),
    }


def score_reranker(reranker, base_features):
    value = reranker["bias"]
    for idx, raw in enumerate(base_features):
        std = reranker["feature_stds"][idx]
        if abs(std) < 1e-9:
            std = 1.0
        mean = reranker["feature_means"][idx]
        value += ((raw - mean) / std) * reranker["weights"][idx]
    if reranker["activation"] == "sigmoid":
        return sigmoid(value)
    return value


def build_judge_samples(base_samples, reranker, positive_rel_threshold):
    samples = []
    for sample in base_samples:
        relevance = float(sample["target"]) * 3.0
        label = 1.0 if relevance >= float(positive_rel_threshold) else 0.0
        base_features = list(sample["features"])
        reranker_score = score_reranker(reranker, base_features)
        features = base_features + [float(reranker_score)]

        weight = 1.0
        if label > 0.5:
            weight = 2.0

        samples.append(
            {
                "query_id": sample["query_id"],
                "patent_id": sample["patent_id"],
                "features": features,
                "label": label,
                "weight": float(weight),
            }
        )

    if not samples:
        raise ValueError("no judge training samples built")
    return samples


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
    labels = neurx.Tensor([[sample["label"]] for sample in samples], requires_grad=False)
    weights = neurx.Tensor([[sample["weight"]] for sample in samples], requires_grad=False)

    model = nn.Linear(len(FEATURE_NAMES), 1)
    optimizer = optim.Adam(model.parameters(), lr=lr)

    for _ in range(epochs):
        model.zero_grad()
        probs = model(features).sigmoid()
        diff = probs - labels
        loss = ((diff * diff) * weights).mean()
        loss.backward()
        optimizer.step()

    probs = model(features).sigmoid().data.reshape(-1).tolist()
    labels_flat = labels.data.reshape(-1).tolist()
    mse = sum((probs[i] - labels_flat[i]) ** 2 for i in range(len(probs))) / len(probs)
    return model, mse


def score_sample(model, means, stds, features):
    scaled = [(features[idx] - means[idx]) / stds[idx] for idx in range(len(features))]
    tensor = neurx.Tensor([scaled], requires_grad=False)
    score = model(tensor).sigmoid().data.reshape(-1)[0]
    return float(score)


def compute_auc(labels, probs):
    paired = sorted(zip(probs, labels), key=lambda item: item[0])
    n_pos = sum(1 for _, label in paired if label > 0.5)
    n_neg = len(paired) - n_pos
    if n_pos == 0 or n_neg == 0:
        return 0.0

    rank_sum = 0.0
    for idx, (_, label) in enumerate(paired, start=1):
        if label > 0.5:
            rank_sum += idx

    return (rank_sum - (n_pos * (n_pos + 1) / 2.0)) / (n_pos * n_neg)


def classification_metrics(labels, probs, threshold):
    tp = fp = tn = fn = 0
    for label, prob in zip(labels, probs):
        pred = 1.0 if prob >= threshold else 0.0
        if pred > 0.5 and label > 0.5:
            tp += 1
        elif pred > 0.5 and label <= 0.5:
            fp += 1
        elif pred <= 0.5 and label <= 0.5:
            tn += 1
        else:
            fn += 1

    total = tp + fp + tn + fn
    accuracy = (tp + tn) / total if total else 0.0
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 0.0
    if precision + recall > 0:
        f1 = 2.0 * precision * recall / (precision + recall)

    return {
        "accuracy": accuracy,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "auc": compute_auc(labels, probs),
        "confusion_matrix": {"tp": tp, "fp": fp, "tn": tn, "fn": fn},
    }


def evaluate(model, means, stds, samples, threshold):
    probs = []
    labels = []
    for sample in samples:
        probs.append(score_sample(model, means, stds, sample["features"]))
        labels.append(float(sample["label"]))

    metrics = classification_metrics(labels, probs, threshold)
    metrics["samples"] = len(samples)
    metrics["positive_ratio"] = sum(labels) / len(labels) if labels else 0.0
    return metrics


def export_artifact(model, means, stds, metrics, threshold, positive_rel_threshold, out_path: Path):
    state = model.state_dict()
    weights = [float(row[0]) for row in state["weight"].tolist()]
    bias = float(state["bias"].tolist()[0])

    artifact = {
        "model_type": "neurx_linear_judge",
        "version": 1,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "feature_names": FEATURE_NAMES,
        "feature_means": [float(value) for value in means],
        "feature_stds": [float(value) for value in stds],
        "weights": weights,
        "bias": bias,
        "activation": "sigmoid",
        "risk_threshold": float(threshold),
        "positive_rel_threshold": float(positive_rel_threshold),
        "metrics": metrics,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_args():
    parser = argparse.ArgumentParser(description="Train FTO judge model with neurx")
    parser.add_argument("--patents", default=str(DEFAULT_PATENTS))
    parser.add_argument("--queries", default=str(DEFAULT_QUERIES))
    parser.add_argument("--qrels", default=str(DEFAULT_QRELS))
    parser.add_argument("--recall-model", default=str(DEFAULT_RECALL_MODEL))
    parser.add_argument("--reranker-model", default=str(DEFAULT_RERANKER_MODEL))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--epochs", type=int, default=1000)
    parser.add_argument("--lr", type=float, default=0.03)
    parser.add_argument("--candidate-k", type=int, default=24)
    parser.add_argument("--positive-rel-threshold", type=float, default=2.0)
    parser.add_argument("--risk-threshold", type=float, default=0.5)
    return parser.parse_args()


def main():
    args = parse_args()
    if args.candidate_k <= 0:
        raise ValueError("candidate-k must be > 0")

    patents = read_jsonl(Path(args.patents))
    queries = read_jsonl(Path(args.queries))
    qrels = read_jsonl(Path(args.qrels))
    recall_params = load_recall_params(Path(args.recall_model))
    reranker = load_reranker_artifact(Path(args.reranker_model))

    base_samples, _, _ = build_dataset(
        patents,
        queries,
        qrels,
        recall_params=recall_params,
        candidate_k=args.candidate_k,
    )
    judge_samples = build_judge_samples(base_samples, reranker, args.positive_rel_threshold)
    means, stds = standardize_features(judge_samples)
    model, train_mse = train_model(judge_samples, args.epochs, args.lr)

    metrics = evaluate(model, means, stds, judge_samples, args.risk_threshold)
    metrics["train_mse"] = float(train_mse)
    metrics["candidate_k"] = int(args.candidate_k)

    export_artifact(
        model,
        means,
        stds,
        metrics,
        threshold=args.risk_threshold,
        positive_rel_threshold=args.positive_rel_threshold,
        out_path=Path(args.out),
    )

    print(f"[ok] samples={metrics['samples']}")
    print(f"[ok] candidate_k={args.candidate_k}")
    print(f"[ok] positive_rel_threshold={args.positive_rel_threshold}")
    print(f"[ok] risk_threshold={args.risk_threshold}")
    print(f"[ok] train_mse={train_mse:.6f}")
    print(f"[ok] accuracy={metrics['accuracy']:.4f}")
    print(f"[ok] precision={metrics['precision']:.4f}")
    print(f"[ok] recall={metrics['recall']:.4f}")
    print(f"[ok] f1={metrics['f1']:.4f}")
    print(f"[ok] auc={metrics['auc']:.4f}")
    print(f"[ok] artifact={args.out}")


if __name__ == "__main__":
    main()
