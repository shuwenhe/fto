#!/usr/bin/env python3
"""Bulk index patent documents into Elasticsearch from Parquet."""

from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.request
from pathlib import Path


def require_pyarrow():
    try:
        import pyarrow.dataset as ds
    except ImportError as exc:
        raise SystemExit(
            "[error] pyarrow is required. Install with: pip install pyarrow"
        ) from exc
    return ds


def http_json(method: str, url: str, body: bytes | None = None, headers: dict | None = None):
    req = urllib.request.Request(url, data=body, method=method)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "ignore")


def ensure_index(base_url: str, index: str) -> None:
    mapping = {
        "mappings": {
            "properties": {
                "patent_id": {"type": "keyword"},
                "country": {"type": "keyword"},
                "pub_year": {"type": "integer"},
                "legal_status": {"type": "keyword"},
                "legal_status_group": {"type": "keyword"},
                "title": {"type": "text"},
                "abstract": {"type": "text"},
                "claim": {"type": "text"},
                "keywords": {"type": "text"},
            }
        }
    }
    status, text = http_json(
        "PUT",
        f"{base_url.rstrip('/')}/{index}",
        body=json.dumps(mapping).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    if status not in (200, 201, 400):
        raise SystemExit(f"[error] create index failed status={status} body={text}")


def bulk_flush(base_url: str, ndjson: str) -> int:
    status, text = http_json(
        "POST",
        f"{base_url.rstrip('/')}/_bulk",
        body=ndjson.encode("utf-8"),
        headers={"Content-Type": "application/x-ndjson"},
    )
    if status not in (200, 201):
        raise SystemExit(f"[error] bulk index failed status={status} body={text}")
    data = json.loads(text)
    if data.get("errors"):
        raise SystemExit("[error] bulk index returned item errors")
    return len(data.get("items") or [])


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Index patents into Elasticsearch from Parquet dataset")
    parser.add_argument("--input", default=str(root / "data_lake" / "patent_core"))
    parser.add_argument("--url", default="http://127.0.0.1:9200")
    parser.add_argument("--index", default="fto_patents")
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--recreate", action="store_true")
    parser.add_argument("--ids-file", default="", help="Optional file containing patent IDs to index")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    ds = require_pyarrow()
    input_path = Path(args.input)
    if not input_path.exists():
        raise SystemExit(f"[error] parquet dataset not found: {input_path}")

    if args.recreate:
        http_json("DELETE", f"{args.url.rstrip('/')}/{args.index}")
    ensure_index(args.url, args.index)

    dataset = ds.dataset(str(input_path), format="parquet", partitioning="hive")
    selected_ids = None
    if args.ids_file:
        ids_path = Path(args.ids_file)
        if not ids_path.exists():
            raise SystemExit(f"[error] ids file not found: {ids_path}")
        selected_ids = {
            line.strip()
            for line in ids_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        }
    batch_docs: list[str] = []
    total = 0
    for batch in dataset.to_batches(batch_size=args.batch_size):
        rows = batch.to_pylist()
        for row in rows:
            patent_id = str(row.get("patent_id", "")).strip()
            if not patent_id:
                continue
            if selected_ids is not None and patent_id not in selected_ids:
                continue
            batch_docs.append(json.dumps({"index": {"_index": args.index, "_id": patent_id}}))
            batch_docs.append(json.dumps(row, ensure_ascii=False))
        if batch_docs:
            total += bulk_flush(args.url, "\n".join(batch_docs) + "\n")
            batch_docs = []

    http_json("POST", f"{args.url.rstrip('/')}/{args.index}/_refresh")
    print(f"[ok] es_indexed index={args.index} documents={total} input={input_path}")


if __name__ == "__main__":
    main()
