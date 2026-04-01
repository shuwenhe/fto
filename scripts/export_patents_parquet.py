#!/usr/bin/env python3
"""Export patent JSONL records into partitioned Parquet files.

This script treats JSONL as an import/exchange format only. The generated
Parquet dataset is intended to be the durable analytics/indexing source.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from patent_pipeline_common import load_jsonl


def require_pyarrow():
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError as exc:
        raise SystemExit(
            "[error] pyarrow is required. Install with: pip install pyarrow"
        ) from exc
    return pa, pq


def normalize_legal_status(value: str) -> str:
    text = (value or "").strip().lower()
    if not text:
        return "unknown"
    if any(token in text for token in ("active", "授权", "有效", "公开", "pending", "审中")):
        if "expired" in text or "cease" in text or "失效" in text:
            return "expired"
        if "pending" in text or "审中" in text or "公开" in text:
            return "pending"
        return "active"
    if any(token in text for token in ("expired", "cease", "withdraw", "lapse", "fee related", "失效", "终止", "撤回")):
        return "expired"
    return "other"


def detect_country(patent_id: str) -> str:
    patent_id = (patent_id or "").strip().upper()
    if len(patent_id) < 2:
        return "UN"
    return patent_id[:2]


def detect_pub_year(patent_id: str) -> int:
    patent_id = (patent_id or "").strip().upper()
    digits = "".join(ch for ch in patent_id if ch.isdigit())
    if len(digits) >= 4:
        year = int(digits[:4])
        if 1900 <= year <= 2100:
            return year
    return 0


def iter_jsonl_records(path: Path):
    for row in load_jsonl(path):
        patent_id = str(row.get("patent_id", "")).strip()
        title = str(row.get("title", "")).strip()
        if not patent_id or not title:
            continue
        keywords = row.get("keywords") or []
        if not isinstance(keywords, list):
            keywords = []
        legal_status = str(row.get("legal_status", "")).strip()
        yield {
            "patent_id": patent_id,
            "title": title,
            "abstract": str(row.get("abstract", "") or ""),
            "claim": str(row.get("claim", "") or ""),
            "keywords": [str(item) for item in keywords if str(item).strip()],
            "legal_status": legal_status,
            "country": detect_country(patent_id),
            "pub_year": detect_pub_year(patent_id),
            "legal_status_group": normalize_legal_status(legal_status),
        }


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Export patents.jsonl to partitioned Parquet dataset")
    parser.add_argument("--input", default=str(root / "data_sources" / "patents.jsonl"))
    parser.add_argument("--output", default=str(root / "data_lake" / "patent_core"))
    parser.add_argument(
        "--partition-by",
        default="country,pub_year",
        help="Comma-separated partition columns. Supported: country,pub_year,legal_status_group",
    )
    parser.add_argument("--row-group-size", type=int, default=2048)
    parser.add_argument("--compression", default="snappy")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--ids-file", default="", help="Optional file containing patent IDs to export")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    pa, pq = require_pyarrow()

    input_path = Path(args.input)
    output_path = Path(args.output)
    if not input_path.exists():
        raise SystemExit(f"[error] input not found: {input_path}")

    partitions = [item.strip() for item in args.partition_by.split(",") if item.strip()]
    supported = {"country", "pub_year", "legal_status_group"}
    invalid = [item for item in partitions if item not in supported]
    if invalid:
        raise SystemExit(f"[error] unsupported partition columns: {', '.join(invalid)}")

    if output_path.exists() and args.overwrite:
        shutil.rmtree(output_path)
    output_path.mkdir(parents=True, exist_ok=True)

    rows = list(iter_jsonl_records(input_path))
    if args.ids_file:
        ids_path = Path(args.ids_file)
        if not ids_path.exists():
            raise SystemExit(f"[error] ids file not found: {ids_path}")
        selected_ids = {
            line.strip()
            for line in ids_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        }
        rows = [row for row in rows if row["patent_id"] in selected_ids]
    if not rows:
        raise SystemExit("[error] no patent records loaded from input JSONL")

    table = pa.Table.from_pylist(rows)
    pq.write_to_dataset(
        table,
        root_path=str(output_path),
        partition_cols=partitions,
        compression=args.compression,
        existing_data_behavior="overwrite_or_ignore" if not args.overwrite else "delete_matching",
        row_group_size=args.row_group_size,
    )
    print(
        f"[ok] parquet_exported records={len(rows)} input={input_path} output={output_path} "
        f"partitions={','.join(partitions) or '-'} compression={args.compression}"
    )


if __name__ == "__main__":
    main()
