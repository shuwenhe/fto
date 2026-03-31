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


def load_judge_model(path: Path):
    parsed = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError(f"invalid judge model at {path}")
    return parsed


def evaluate(model, samples, threshold):
    means = [float(v) for v in model.get("feature_means", [])]
    stds = [float(v) for v in model.get("feature_stds", [])]

    probs = []
    labels = []
    rows = []

    weights = [float(v) for v in model.get("weights", [])]
    bias = float(model.get("bias", 0.0))

    def predict_prob(features):
        scaled = [(features[idx] - means[idx]) / (stds[idx] if abs(stds[idx]) > 1e-9 else 1.0) for idx in range(len(features))]
        linear = bias
        for idx, feat in enumerate(scaled):
            linear += feat * weights[idx]
        if linear >= 0:
            z = math.exp(-linear)
            return 1.0 / (1.0 + z)
        z = math.exp(linear)
        return z / (1.0 + z)

    for sample in samples:
        prob = predict_prob(sample["features"])
        label = float(sample["label"])
        probs.append(prob)
        labels.append(label)
        rows.append(
            {
                "query_id": sample["query_id"],
                "patent_id": sample["patent_id"],
                "label": int(label),
                "prob": prob,
                "pred": 1 if prob >= threshold else 0,
            }
        )

    metrics = classification_metrics(labels, probs, threshold)
    metrics["samples"] = len(samples)
    return metrics, rows


def parse_args():
    parser = argparse.ArgumentParser(description="Evaluate FTO judge model")
    parser.add_argument("--patents", default=str(DEFAULT_PATENTS))
    parser.add_argument("--queries", default=str(DEFAULT_QUERIES))
    parser.add_argument("--qrels", default=str(DEFAULT_QRELS))
    parser.add_argument("--recall-model", default=str(DEFAULT_RECALL_MODEL))
    parser.add_argument("--reranker-model", default=str(DEFAULT_RERANKER_MODEL))
    parser.add_argument("--model", default=str(DEFAULT_MODEL))
    parser.add_argument("--candidate-k", type=int, default=24)
    parser.add_argument("--positive-rel-threshold", type=float, default=2.0)
    parser.add_argument("--risk-threshold", type=float, default=0.5)
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
    judge_samples = build_judge_samples(base_samples, reranker, args.positive_rel_threshold)
    model = load_judge_model(Path(args.model))

    threshold = args.risk_threshold
    if "risk_threshold" in model:
        threshold = float(model.get("risk_threshold", threshold))

    metrics, rows = evaluate(model, judge_samples, threshold)

    print("JudgeEval")
    print(f"candidate_k={args.candidate_k}")
    print(f"positive_rel_threshold={args.positive_rel_threshold}")
    print(f"risk_threshold={threshold}")
    print(f"model={args.model}")
    print(f"samples={metrics['samples']}")
    print(f"accuracy={metrics['accuracy']:.4f}")
    print(f"precision={metrics['precision']:.4f}")
    print(f"recall={metrics['recall']:.4f}")
    print(f"f1={metrics['f1']:.4f}")
    print(f"auc={metrics['auc']:.4f}")

    if args.verbose:
        print("--- per-sample ---")
        for row in rows:
            print(
                f"{row['query_id']}:{row['patent_id']} label={row['label']} pred={row['pred']} prob={row['prob']:.4f}"
            )


if __name__ == "__main__":
    main()
