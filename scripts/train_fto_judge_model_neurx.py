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
RISK_LABELS = ["low", "medium", "high"]

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


def map_relevance_to_class(relevance, medium_rel_threshold, high_rel_threshold):
    if relevance >= high_rel_threshold:
        return 2
    if relevance >= medium_rel_threshold:
        return 1
    return 0


def build_judge_samples(base_samples, reranker, medium_rel_threshold, high_rel_threshold):
    samples = []
    for sample in base_samples:
        relevance = float(sample["target"]) * 3.0
        label = map_relevance_to_class(
            relevance,
            float(medium_rel_threshold),
            float(high_rel_threshold),
        )
        base_features = list(sample["features"])
        reranker_score = score_reranker(reranker, base_features)
        features = base_features + [float(reranker_score)]

        weight = 1.0
        if label > 0:
            weight = 2.0
        if label == 2:
            weight = 3.0

        samples.append(
            {
                "query_id": sample["query_id"],
                "patent_id": sample["patent_id"],
                "features": features,
                "label": int(label),
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
    weights = neurx.Tensor([[sample["weight"]] for sample in samples], requires_grad=False)
    labels_by_head = [
        neurx.Tensor(
            [[1.0 if sample["label"] == class_idx else 0.0] for sample in samples],
            requires_grad=False,
        )
        for class_idx in range(len(RISK_LABELS))
    ]

    models = [nn.Linear(len(FEATURE_NAMES), 1) for _ in RISK_LABELS]
    optimizers = [optim.Adam(model.parameters(), lr=lr) for model in models]

    for _ in range(epochs):
        for class_idx, model in enumerate(models):
            model.zero_grad()
            probs = model(features).sigmoid()
            diff = probs - labels_by_head[class_idx]
            loss = ((diff * diff) * weights).mean()
            loss.backward()
            optimizers[class_idx].step()

    mse_by_head = {}
    for class_idx, model in enumerate(models):
        probs = model(features).sigmoid().to_numpy().reshape(-1).tolist()
        labels_flat = labels_by_head[class_idx].to_numpy().reshape(-1).tolist()
        mse = sum((probs[i] - labels_flat[i]) ** 2 for i in range(len(probs))) / len(probs)
        mse_by_head[RISK_LABELS[class_idx]] = float(mse)
    return models, mse_by_head


def score_sample(models, means, stds, features):
    scaled = [(features[idx] - means[idx]) / stds[idx] for idx in range(len(features))]
    tensor = neurx.Tensor([scaled], requires_grad=False)
    raw_scores = [float(model(tensor).sigmoid().to_numpy().reshape(-1)[0]) for model in models]
    total = sum(raw_scores)
    if total <= 1e-9:
        return [1.0 / len(RISK_LABELS)] * len(RISK_LABELS)
    return [score / total for score in raw_scores]


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


def multiclass_metrics(labels, probs_by_sample):
    num_classes = len(RISK_LABELS)
    confusion = [[0 for _ in range(num_classes)] for _ in range(num_classes)]
    pred_labels = []
    for label, probs in zip(labels, probs_by_sample):
        pred = max(range(num_classes), key=lambda idx: probs[idx])
        pred_labels.append(pred)
        confusion[int(label)][pred] += 1

    total = len(labels)
    correct = sum(confusion[idx][idx] for idx in range(num_classes))
    accuracy = correct / total if total else 0.0

    per_class = {}
    macro_precision = 0.0
    macro_recall = 0.0
    macro_f1 = 0.0
    weighted_f1 = 0.0
    for class_idx, label_name in enumerate(RISK_LABELS):
        tp = confusion[class_idx][class_idx]
        fp = sum(confusion[row][class_idx] for row in range(num_classes) if row != class_idx)
        fn = sum(confusion[class_idx][col] for col in range(num_classes) if col != class_idx)
        support = sum(confusion[class_idx])
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = 0.0
        if precision + recall > 0:
            f1 = 2.0 * precision * recall / (precision + recall)

        macro_precision += precision
        macro_recall += recall
        macro_f1 += f1
        weighted_f1 += f1 * support

        auc_labels = [1.0 if label == class_idx else 0.0 for label in labels]
        auc_probs = [probs[class_idx] for probs in probs_by_sample]
        per_class[label_name] = {
            "precision": precision,
            "recall": recall,
            "f1": f1,
            "support": support,
            "auc": compute_auc(auc_labels, auc_probs),
        }

    macro_precision /= num_classes
    macro_recall /= num_classes
    macro_f1 /= num_classes
    weighted_f1 = weighted_f1 / total if total else 0.0

    return {
        "accuracy": accuracy,
        "macro_precision": macro_precision,
        "macro_recall": macro_recall,
        "macro_f1": macro_f1,
        "weighted_f1": weighted_f1,
        "per_class": per_class,
        "confusion_matrix": {
            "labels": RISK_LABELS,
            "matrix": confusion,
        },
        "pred_labels": pred_labels,
    }


def evaluate(models, means, stds, samples):
    probs_by_sample = []
    labels = []
    for sample in samples:
        probs_by_sample.append(score_sample(models, means, stds, sample["features"]))
        labels.append(int(sample["label"]))

    metrics = multiclass_metrics(labels, probs_by_sample)
    metrics["samples"] = len(samples)
    metrics["class_distribution"] = {
        RISK_LABELS[idx]: sum(1 for label in labels if label == idx) / len(labels) if labels else 0.0
        for idx in range(len(RISK_LABELS))
    }
    return metrics


def export_artifact(models, means, stds, metrics, medium_rel_threshold, high_rel_threshold, out_path: Path):
    heads = []
    for class_idx, model in enumerate(models):
        state = model.state_dict()
        heads.append(
            {
                "label": RISK_LABELS[class_idx],
                "weights": [float(row[0]) for row in state["weight"].tolist()],
                "bias": float(state["bias"].tolist()[0]),
                "activation": "sigmoid",
            }
        )

    artifact = {
        "model_type": "neurx_linear_judge_multiclass",
        "version": 1,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "risk_labels": RISK_LABELS,
        "feature_names": FEATURE_NAMES,
        "feature_means": [float(value) for value in means],
        "feature_stds": [float(value) for value in stds],
        "heads": heads,
        "medium_rel_threshold": float(medium_rel_threshold),
        "high_rel_threshold": float(high_rel_threshold),
        "metrics": metrics,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_args():
    parser = argparse.ArgumentParser(description="Train FTO judge model with neurx (3-class)")
    parser.add_argument("--patents", default=str(DEFAULT_PATENTS))
    parser.add_argument("--queries", default=str(DEFAULT_QUERIES))
    parser.add_argument("--qrels", default=str(DEFAULT_QRELS))
    parser.add_argument("--recall-model", default=str(DEFAULT_RECALL_MODEL))
    parser.add_argument("--reranker-model", default=str(DEFAULT_RERANKER_MODEL))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--epochs", type=int, default=1000)
    parser.add_argument("--lr", type=float, default=0.03)
    parser.add_argument("--candidate-k", type=int, default=24)
    parser.add_argument("--medium-rel-threshold", type=float, default=2.0)
    parser.add_argument("--high-rel-threshold", type=float, default=3.0)
    return parser.parse_args()


def main():
    args = parse_args()
    if args.candidate_k <= 0:
        raise ValueError("candidate-k must be > 0")
    if args.high_rel_threshold < args.medium_rel_threshold:
        raise ValueError("high-rel-threshold must be >= medium-rel-threshold")

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
    judge_samples = build_judge_samples(
        base_samples,
        reranker,
        args.medium_rel_threshold,
        args.high_rel_threshold,
    )
    means, stds = standardize_features(judge_samples)
    models, train_mse = train_model(judge_samples, args.epochs, args.lr)

    metrics = evaluate(models, means, stds, judge_samples)
    metrics["train_mse"] = train_mse
    metrics["candidate_k"] = int(args.candidate_k)

    export_artifact(
        models,
        means,
        stds,
        metrics,
        medium_rel_threshold=args.medium_rel_threshold,
        high_rel_threshold=args.high_rel_threshold,
        out_path=Path(args.out),
    )

    print(f"[ok] samples={metrics['samples']}")
    print(f"[ok] candidate_k={args.candidate_k}")
    print(f"[ok] medium_rel_threshold={args.medium_rel_threshold}")
    print(f"[ok] high_rel_threshold={args.high_rel_threshold}")
    print(
        "[ok] train_mse="
        + ", ".join(f"{label}:{train_mse[label]:.6f}" for label in RISK_LABELS)
    )
    print(f"[ok] accuracy={metrics['accuracy']:.4f}")
    print(f"[ok] macro_precision={metrics['macro_precision']:.4f}")
    print(f"[ok] macro_recall={metrics['macro_recall']:.4f}")
    print(f"[ok] macro_f1={metrics['macro_f1']:.4f}")
    print(f"[ok] weighted_f1={metrics['weighted_f1']:.4f}")
    for label in RISK_LABELS:
        per = metrics["per_class"][label]
        print(
            f"[ok] class={label} precision={per['precision']:.4f} recall={per['recall']:.4f} f1={per['f1']:.4f} auc={per['auc']:.4f}"
        )
    print(f"[ok] artifact={args.out}")


if __name__ == "__main__":
    main()
