#!/usr/bin/env python3

import argparse
import json
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_QUERIES = ROOT / "data_sources" / "queries.jsonl"
DEFAULT_QRELS = ROOT / "data_sources" / "qrels.jsonl"


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


def parse_args():
    today = datetime.now().strftime("%Y%m%d")
    parser = argparse.ArgumentParser(
        description="Generate qrels labeling task list from queries.jsonl and qrels.jsonl"
    )
    parser.add_argument("--queries", default=str(DEFAULT_QUERIES))
    parser.add_argument("--qrels", default=str(DEFAULT_QRELS))
    parser.add_argument(
        "--out-md",
        default=str(ROOT / "docs" / f"qrels_label_tasks_{today}.md"),
        help="Output markdown task list",
    )
    parser.add_argument(
        "--out-batch",
        default=str(ROOT / "data_sources" / f"qrels_batch_{today}.jsonl"),
        help="Output JSONL batch template with placeholders",
    )
    parser.add_argument("--min-samples-per-query", type=int, default=8)
    parser.add_argument("--min-medium-per-query", type=int, default=2)
    parser.add_argument("--min-high-per-query", type=int, default=1)
    parser.add_argument("--min-low-per-query", type=int, default=3)
    parser.add_argument(
        "--only-incomplete",
        action="store_true",
        help="Only emit queries that still need more labels",
    )
    return parser.parse_args()


def safe_slug(text: str):
    return "".join(ch if ch.isalnum() else "_" for ch in text).strip("_").lower()


def build_task_rows(queries, qrels, min_samples_per_query, min_medium_per_query, min_high_per_query, min_low_per_query):
    counts = defaultdict(Counter)
    for row in qrels:
        query_id = str(row.get("query_id", "")).strip()
        relevance = row.get("relevance")
        if not query_id or relevance not in {0, 1, 2, 3}:
            continue
        counts[query_id][int(relevance)] += 1

    task_rows = []
    for query in queries:
        query_id = str(query.get("query_id", "")).strip()
        query_text = str(query.get("query", "")).strip()
        query_desc = str(query.get("desc", "")).strip()
        rel = counts[query_id]
        low_count = rel[0] + rel[1]
        medium_count = rel[2]
        high_count = rel[3]
        total = low_count + medium_count + high_count

        need_low = max(0, min_low_per_query - low_count)
        need_medium = max(0, min_medium_per_query - medium_count)
        need_high = max(0, min_high_per_query - high_count)
        need_total = max(0, min_samples_per_query - total)

        deficits = []
        deficits.extend([("low", 1)] * need_low)
        deficits.extend([("medium", 2)] * need_medium)
        deficits.extend([("high", 3)] * need_high)

        while len(deficits) < need_total:
            if medium_count + sum(1 for label, _ in deficits if label == "medium") < min_medium_per_query + 1:
                deficits.append(("medium", 2))
            elif low_count + sum(1 for label, _ in deficits if label == "low") < min_low_per_query + 1:
                deficits.append(("low", 1))
            else:
                deficits.append(("high", 3))

        status = "complete" if not deficits else "needs_labels"
        task_rows.append(
            {
                "query_id": query_id,
                "query": query_text,
                "desc": query_desc,
                "low_count": low_count,
                "medium_count": medium_count,
                "high_count": high_count,
                "total_count": total,
                "need_low": need_low,
                "need_medium": need_medium,
                "need_high": need_high,
                "need_total": max(need_total, len(deficits)),
                "deficits": deficits,
                "status": status,
            }
        )
    return task_rows


def write_markdown(path: Path, task_rows, args):
    lines = [
        "# Qrels Label Tasks",
        "",
        f"- queries: `{args.queries}`",
        f"- qrels: `{args.qrels}`",
        f"- min_samples_per_query: `{args.min_samples_per_query}`",
        f"- min_low_per_query: `{args.min_low_per_query}`",
        f"- min_medium_per_query: `{args.min_medium_per_query}`",
        f"- min_high_per_query: `{args.min_high_per_query}`",
        "",
        "| query_id | status | total | low | medium | high | need_low | need_medium | need_high | query | desc |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    ]

    for row in task_rows:
        lines.append(
            f"| {row['query_id']} | {row['status']} | {row['total_count']} | {row['low_count']} | "
            f"{row['medium_count']} | {row['high_count']} | {row['need_low']} | {row['need_medium']} | "
            f"{row['need_high']} | {row['query']} | {row['desc']} |"
        )

    lines.append("")
    lines.append("## Suggested Batch Fill")
    lines.append("")
    for row in task_rows:
        if not row["deficits"]:
            continue
        lines.append(f"### {row['query_id']}")
        lines.append("")
        lines.append(f"- query: `{row['query']}`")
        lines.append(f"- desc: {row['desc']}")
        lines.append(
            f"- current counts: low={row['low_count']} medium={row['medium_count']} high={row['high_count']} total={row['total_count']}"
        )
        need_parts = [f"{label}:{score}" for label, score in row["deficits"]]
        lines.append(f"- suggested additions: `{', '.join(need_parts)}`")
        lines.append("")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_batch_template(path: Path, task_rows):
    lines = []
    for row in task_rows:
        if not row["deficits"]:
            continue
        label_seq = Counter()
        for label_name, relevance in row["deficits"]:
            label_seq[label_name] += 1
            idx = label_seq[label_name]
            lines.append(
                json.dumps(
                    {
                        "query_id": row["query_id"],
                        "patent_id": f"TODO_FILL_{row['query_id'].upper()}_{label_name.upper()}_{idx:02d}",
                        "relevance": relevance,
                    },
                    ensure_ascii=False,
                )
            )

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def main():
    args = parse_args()
    queries = read_jsonl(Path(args.queries))
    qrels = read_jsonl(Path(args.qrels))

    task_rows = build_task_rows(
        queries,
        qrels,
        args.min_samples_per_query,
        args.min_medium_per_query,
        args.min_high_per_query,
        args.min_low_per_query,
    )
    if args.only_incomplete:
        task_rows = [row for row in task_rows if row["status"] != "complete"]

    write_markdown(Path(args.out_md), task_rows, args)
    write_batch_template(Path(args.out_batch), task_rows)

    incomplete = sum(1 for row in task_rows if row["status"] != "complete")
    print(f"[ok] markdown={args.out_md}")
    print(f"[ok] batch_template={args.out_batch}")
    print(f"[info] queries={len(task_rows)} incomplete={incomplete}")


if __name__ == "__main__":
    main()
