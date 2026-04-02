#!/usr/bin/env python3

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path


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
    parser = argparse.ArgumentParser(description="Check qrels label distribution for judge training")
    parser.add_argument(
        "--qrels",
        default="/home/shuwen/fto/data_sources/qrels.jsonl",
        help="Path to qrels JSONL file",
    )
    parser.add_argument(
        "--min-query-count",
        type=int,
        default=30,
        help="Warn if distinct queries are below this threshold",
    )
    parser.add_argument(
        "--min-medium",
        type=int,
        default=30,
        help="Warn if relevance=2 samples are below this threshold",
    )
    parser.add_argument(
        "--max-query-share",
        type=float,
        default=0.10,
        help="Warn if a single query contributes more than this fraction of rows",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    rows = read_jsonl(Path(args.qrels))
    if not rows:
        raise ValueError("qrels is empty")

    total = len(rows)
    relevance_counter = Counter()
    judge_counter = Counter()
    query_counter = Counter()
    per_query_relevance = defaultdict(Counter)
    duplicate_pairs = Counter()
    invalid_rows = []

    for idx, row in enumerate(rows, start=1):
        query_id = str(row.get("query_id", "")).strip()
        patent_id = str(row.get("patent_id", "")).strip()
        relevance = row.get("relevance")

        if not query_id or not patent_id or relevance not in {0, 1, 2, 3}:
            invalid_rows.append({"row_no": idx, "row": row})
            continue

        relevance_counter[relevance] += 1
        query_counter[query_id] += 1
        per_query_relevance[query_id][relevance] += 1
        duplicate_pairs[(query_id, patent_id)] += 1

        if relevance >= 3:
            judge_counter["high"] += 1
        elif relevance >= 2:
            judge_counter["medium"] += 1
        else:
            judge_counter["low"] += 1

    duplicate_rows = [
        {"query_id": query_id, "patent_id": patent_id, "count": count}
        for (query_id, patent_id), count in duplicate_pairs.items()
        if count > 1
    ]
    duplicate_rows.sort(key=lambda item: (-item["count"], item["query_id"], item["patent_id"]))

    per_query_rows = []
    for query_id in sorted(query_counter):
        count = query_counter[query_id]
        share = count / total if total else 0.0
        rel = per_query_relevance[query_id]
        per_query_rows.append(
            {
                "query_id": query_id,
                "samples": count,
                "share": share,
                "relevance_0": rel[0],
                "relevance_1": rel[1],
                "relevance_2": rel[2],
                "relevance_3": rel[3],
                "has_medium": rel[2] > 0,
                "has_high": rel[3] > 0,
            }
        )

    max_query = max(per_query_rows, key=lambda item: item["samples"])
    missing_medium_queries = [row["query_id"] for row in per_query_rows if not row["has_medium"]]
    missing_high_queries = [row["query_id"] for row in per_query_rows if not row["has_high"]]

    print(f"[info] qrels={args.qrels}")
    print(f"[info] total_rows={total}")
    print(f"[info] distinct_queries={len(query_counter)}")
    print(
        "[info] relevance_distribution="
        f"0:{relevance_counter[0]} 1:{relevance_counter[1]} 2:{relevance_counter[2]} 3:{relevance_counter[3]}"
    )
    print(
        "[info] judge_distribution="
        f"low:{judge_counter['low']} medium:{judge_counter['medium']} high:{judge_counter['high']}"
    )
    print(
        f"[info] largest_query={max_query['query_id']} samples={max_query['samples']} share={max_query['share']:.2%}"
    )

    warnings = []
    if len(query_counter) < args.min_query_count:
        warnings.append(
            f"distinct_queries below threshold: {len(query_counter)} < {args.min_query_count}"
        )
    if relevance_counter[2] < args.min_medium:
        warnings.append(f"medium samples below threshold: {relevance_counter[2]} < {args.min_medium}")
    if max_query["share"] > args.max_query_share:
        warnings.append(
            f"largest query share too high: {max_query['query_id']} {max_query['share']:.2%} > {args.max_query_share:.2%}"
        )
    if missing_medium_queries:
        warnings.append(
            f"queries missing medium samples: {', '.join(missing_medium_queries[:10])}"
        )
    if invalid_rows:
        warnings.append(f"invalid rows found: {len(invalid_rows)}")
    if duplicate_rows:
        warnings.append(f"duplicate query_id+patent_id pairs found: {len(duplicate_rows)}")

    if warnings:
        for item in warnings:
            print(f"[warn] {item}")
    else:
        print("[ok] qrels distribution looks healthy for judge retraining")

    print("[info] per_query_summary:")
    for row in per_query_rows:
        print(
            f"  {row['query_id']}: samples={row['samples']} share={row['share']:.2%} "
            f"r0={row['relevance_0']} r1={row['relevance_1']} r2={row['relevance_2']} r3={row['relevance_3']}"
        )

    if missing_high_queries:
        print(f"[info] queries_without_high={', '.join(missing_high_queries[:20])}")
    if duplicate_rows:
        print("[info] duplicate_pairs:")
        for row in duplicate_rows[:20]:
            print(f"  {row['query_id']} {row['patent_id']} count={row['count']}")
    if invalid_rows:
        print("[info] invalid_rows:")
        for row in invalid_rows[:20]:
            print(f"  line={row['row_no']} row={json.dumps(row['row'], ensure_ascii=False)}")


if __name__ == "__main__":
    main()
