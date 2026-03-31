#!/usr/bin/env python3

import argparse
import json
import math
from pathlib import Path

from train_fto_judge_model_neurx import (
    DEFAULT_RECALL_MODEL,
    DEFAULT_RERANKER_MODEL,
    build_judge_samples,
    build_dataset,
    classification_metrics,
    load_recall_params,
    load_reranker_artifact,
    read_jsonl,
)
from train_fto_model_neurx import DEFAULT_PATENTS, DEFAULT_QRELS, DEFAULT_QUERIES

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = ROOT / "model_artifacts" / "fto_judge_neurx_v1.json"
RISK_LABELS = ["low", "medium", "high"]


def load_judge_model(path: Path):
    parsed = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError(f"invalid judge model at {path}")
    return parsed


def predict_multiclass_prob(model, features, means, stds):
    heads = model.get("heads", [])
    if not heads:
        raise ValueError("judge model missing heads for multiclass inference")

    scaled = [
        (features[idx] - means[idx]) / (stds[idx] if abs(stds[idx]) > 1e-9 else 1.0)
        for idx in range(len(features))
    ]

    raw = []
    for head in heads:
        weights = [float(v) for v in head.get("weights", [])]
        bias = float(head.get("bias", 0.0))
        linear = bias
        for idx, feat in enumerate(scaled):
            linear += feat * weights[idx]
        if linear >= 0:
            z = math.exp(-linear)
            prob = 1.0 / (1.0 + z)
        else:
            z = math.exp(linear)
            prob = z / (1.0 + z)
        raw.append(prob)

    total = sum(raw)
    if total <= 1e-9:
        return [1.0 / len(raw)] * len(raw)
    return [value / total for value in raw]


def multiclass_metrics(labels, probs_by_sample):
    num_classes = len(RISK_LABELS)
    confusion = [[0 for _ in range(num_classes)] for _ in range(num_classes)]
    rows = []
    for idx, (label, probs) in enumerate(zip(labels, probs_by_sample)):
        pred = max(range(num_classes), key=lambda class_idx: probs[class_idx])
        confusion[int(label)][pred] += 1
        rows.append((idx, int(label), pred, probs))

    total = len(labels)
    correct = sum(confusion[i][i] for i in range(num_classes))
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
        per_class[label_name] = {
            "precision": precision,
            "recall": recall,
            "f1": f1,
            "support": support,
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
        "confusion_matrix": {"labels": RISK_LABELS, "matrix": confusion},
        "rows": rows,
    }


def evaluate(model, samples):
    means = [float(v) for v in model.get("feature_means", [])]
    stds = [float(v) for v in model.get("feature_stds", [])]

    probs_by_sample = []
    labels = []
    rows = []

    for sample in samples:
        probs = predict_multiclass_prob(model, sample["features"], means, stds)
        label = int(sample["label"])
        pred = max(range(len(RISK_LABELS)), key=lambda idx: probs[idx])
        probs_by_sample.append(probs)
        labels.append(label)
        rows.append(
            {
                "query_id": sample["query_id"],
                "patent_id": sample["patent_id"],
                "label": RISK_LABELS[int(label)],
                "pred": RISK_LABELS[pred],
                "prob_low": probs[0],
                "prob_medium": probs[1],
                "prob_high": probs[2],
            }
        )

    metrics = multiclass_metrics(labels, probs_by_sample)
    metrics["samples"] = len(samples)
    return metrics, rows


def parse_args():
    parser = argparse.ArgumentParser(description="Evaluate FTO judge model (3-class)")
    parser.add_argument("--patents", default=str(DEFAULT_PATENTS))
    parser.add_argument("--queries", default=str(DEFAULT_QUERIES))
    parser.add_argument("--qrels", default=str(DEFAULT_QRELS))
    parser.add_argument("--recall-model", default=str(DEFAULT_RECALL_MODEL))
    parser.add_argument("--reranker-model", default=str(DEFAULT_RERANKER_MODEL))
    parser.add_argument("--model", default=str(DEFAULT_MODEL))
    parser.add_argument("--candidate-k", type=int, default=24)
    parser.add_argument("--medium-rel-threshold", type=float, default=2.0)
    parser.add_argument("--high-rel-threshold", type=float, default=3.0)
    parser.add_argument("--verbose", action="store_true")
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
    judge_samples = build_judge_samples(
        base_samples,
        reranker,
        args.medium_rel_threshold,
        args.high_rel_threshold,
    )
    model = load_judge_model(Path(args.model))

    metrics, rows = evaluate(model, judge_samples)

    print("JudgeEval")
    print(f"candidate_k={args.candidate_k}")
    print(f"medium_rel_threshold={args.medium_rel_threshold}")
    print(f"high_rel_threshold={args.high_rel_threshold}")
    print(f"model={args.model}")
    print(f"samples={metrics['samples']}")
    print(f"accuracy={metrics['accuracy']:.4f}")
    print(f"macro_precision={metrics['macro_precision']:.4f}")
    print(f"macro_recall={metrics['macro_recall']:.4f}")
    print(f"macro_f1={metrics['macro_f1']:.4f}")
    print(f"weighted_f1={metrics['weighted_f1']:.4f}")
    for label in RISK_LABELS:
        per = metrics["per_class"][label]
        print(
            f"class={label} precision={per['precision']:.4f} recall={per['recall']:.4f} f1={per['f1']:.4f} support={per['support']}"
        )
    matrix = metrics["confusion_matrix"]["matrix"]
    print(f"confusion_matrix={matrix}")

    if args.verbose:
        print("--- per-sample ---")
        for row in rows:
            print(
                f"{row['query_id']}:{row['patent_id']} label={row['label']} pred={row['pred']} low={row['prob_low']:.4f} medium={row['prob_medium']:.4f} high={row['prob_high']:.4f}"
            )


if __name__ == "__main__":
    main()
