#!/usr/bin/env python3
"""Merge a qrels batch JSONL file into the main qrels JSONL safely."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

from patent_pipeline_common import load_jsonl, resolve_root, write_jsonl


def parse_args() -> argparse.Namespace:
    root = resolve_root()
    parser = argparse.ArgumentParser(description="Merge qrels batch into main qrels JSONL")
    parser.add_argument("--base-qrels", default=str(root / "data_sources" / "qrels.jsonl"))
    parser.add_argument("--batch-qrels", required=True, help="New batch JSONL to merge")
    parser.add_argument(
        "--backup-dir",
        default=str(root / "data_sources" / "backups"),
        help="Where to write a timestamped backup of base qrels before merge",
    )
    parser.add_argument(
        "--out",
        default="",
        help="Optional output path. Defaults to overwriting --base-qrels after backing it up",
    )
    parser.add_argument(
        "--overwrite-conflicts",
        action="store_true",
        help="Allow batch rows to overwrite existing relevance for the same query_id+patent_id",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and print merge summary without writing files",
    )
    return parser.parse_args()


def normalize_qrels_row(row: dict, line_no: int, path: Path) -> dict:
    query_id = str(row.get("query_id", "")).strip()
    patent_id = str(row.get("patent_id", "")).strip()
    relevance = row.get("relevance")

    if not query_id:
        raise SystemExit(f"[error] missing query_id line={line_no} path={path}")
    if not patent_id:
        raise SystemExit(f"[error] missing patent_id line={line_no} path={path}")
    if relevance not in {0, 1, 2, 3}:
        raise SystemExit(
            f"[error] invalid relevance line={line_no} path={path}: expected one of 0/1/2/3, got {relevance!r}"
        )

    return {
        "query_id": query_id,
        "patent_id": patent_id,
        "relevance": int(relevance),
    }


def load_qrels_rows(path: Path) -> list[dict]:
    rows = load_jsonl(path)
    return [normalize_qrels_row(row, idx, path) for idx, row in enumerate(rows, start=1)]


def sort_qrels_rows(rows: list[dict]) -> list[dict]:
    return sorted(
        rows,
        key=lambda row: (
            row["query_id"],
            row["patent_id"],
        ),
    )


def main() -> None:
    args = parse_args()
    base_path = Path(args.base_qrels)
    batch_path = Path(args.batch_qrels)
    out_path = Path(args.out) if args.out else base_path
    backup_dir = Path(args.backup_dir)

    if not batch_path.exists():
        raise SystemExit(f"[error] batch qrels not found: {batch_path}")
    if not base_path.exists():
        raise SystemExit(f"[error] base qrels not found: {base_path}")

    base_rows = load_qrels_rows(base_path)
    batch_rows = load_qrels_rows(batch_path)

    base_by_key: dict[tuple[str, str], dict] = {}
    batch_by_key: dict[tuple[str, str], dict] = {}
    duplicate_batch_keys: list[tuple[str, str]] = []

    for row in base_rows:
        key = (row["query_id"], row["patent_id"])
        base_by_key[key] = row

    for row in batch_rows:
        key = (row["query_id"], row["patent_id"])
        if key in batch_by_key:
            duplicate_batch_keys.append(key)
        batch_by_key[key] = row

    if duplicate_batch_keys:
        dup = duplicate_batch_keys[0]
        raise SystemExit(
            f"[error] duplicate rows inside batch for query_id={dup[0]} patent_id={dup[1]}"
        )

    inserted = 0
    unchanged = 0
    updated = 0
    conflicts: list[dict] = []

    merged_by_key = dict(base_by_key)
    for key, batch_row in batch_by_key.items():
        existing = merged_by_key.get(key)
        if existing is None:
            merged_by_key[key] = batch_row
            inserted += 1
            continue
        if int(existing["relevance"]) == int(batch_row["relevance"]):
            unchanged += 1
            continue
        conflicts.append(
            {
                "query_id": key[0],
                "patent_id": key[1],
                "base_relevance": int(existing["relevance"]),
                "batch_relevance": int(batch_row["relevance"]),
            }
        )
        if args.overwrite_conflicts:
            merged_by_key[key] = batch_row
            updated += 1

    if conflicts and not args.overwrite_conflicts:
        print(f"[error] found {len(conflicts)} conflicting rows. Re-run with --overwrite-conflicts to apply batch labels.")
        for row in conflicts[:20]:
            print(
                f"[error] conflict query_id={row['query_id']} patent_id={row['patent_id']} "
                f"base={row['base_relevance']} batch={row['batch_relevance']}"
            )
        raise SystemExit(1)

    merged_rows = sort_qrels_rows(list(merged_by_key.values()))

    print(f"[info] base_qrels={base_path}")
    print(f"[info] batch_qrels={batch_path}")
    print(f"[info] base_rows={len(base_rows)} batch_rows={len(batch_rows)} merged_rows={len(merged_rows)}")
    print(f"[info] inserted={inserted} unchanged={unchanged} updated={updated} conflicts={len(conflicts)}")

    if args.dry_run:
        print("[ok] dry_run only, no files written")
        return

    if out_path == base_path:
        backup_dir.mkdir(parents=True, exist_ok=True)
        ts = dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%SZ")
        backup_path = backup_dir / f"{base_path.stem}_{ts}{base_path.suffix}"
        backup_path.write_text(base_path.read_text(encoding="utf-8"), encoding="utf-8")
        print(f"[ok] backup={backup_path}")

    write_jsonl(out_path, merged_rows)
    print(f"[ok] merged_qrels={out_path}")


if __name__ == "__main__":
    main()
