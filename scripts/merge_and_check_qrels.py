#!/usr/bin/env python3
"""Merge a labeled qrels batch, then run full qrels distribution checks."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from patent_pipeline_common import resolve_root


def parse_args() -> argparse.Namespace:
    root = resolve_root()
    parser = argparse.ArgumentParser(description="Merge qrels batch and run distribution checks")
    parser.add_argument("--base-qrels", default=str(root / "data_sources" / "qrels.jsonl"))
    parser.add_argument("--batch-qrels", required=True, help="Labeled batch JSONL to merge")
    parser.add_argument("--backup-dir", default=str(root / "data_sources" / "backups"))
    parser.add_argument("--out", default="", help="Optional merged qrels output path")
    parser.add_argument("--overwrite-conflicts", action="store_true")
    parser.add_argument("--min-query-count", type=int, default=30)
    parser.add_argument("--min-medium", type=int, default=30)
    parser.add_argument("--max-query-share", type=float, default=0.10)
    parser.add_argument(
        "--keep-going-on-check-warn",
        action="store_true",
        help="Reserved flag for future non-zero warn handling; current checker prints warnings but exits 0",
    )
    return parser.parse_args()


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True)


def main() -> None:
    args = parse_args()
    root = resolve_root()
    merge_script = root / "scripts" / "merge_qrels_batch.py"
    check_script = root / "scripts" / "check_qrels_distribution.py"
    merged_path = args.out if args.out else args.base_qrels

    merge_cmd = [
        sys.executable,
        str(merge_script),
        "--base-qrels",
        args.base_qrels,
        "--batch-qrels",
        args.batch_qrels,
        "--backup-dir",
        args.backup_dir,
    ]
    if args.out:
        merge_cmd.extend(["--out", args.out])
    if args.overwrite_conflicts:
        merge_cmd.append("--overwrite-conflicts")

    check_cmd = [
        sys.executable,
        str(check_script),
        "--qrels",
        merged_path,
        "--min-query-count",
        str(args.min_query_count),
        "--min-medium",
        str(args.min_medium),
        "--max-query-share",
        str(args.max_query_share),
    ]

    print(f"[info] merge_batch={args.batch_qrels}")
    print(f"[info] merged_qrels_target={merged_path}")
    run(merge_cmd)
    run(check_cmd)
    print("[ok] qrels merge+check completed")


if __name__ == "__main__":
    main()
