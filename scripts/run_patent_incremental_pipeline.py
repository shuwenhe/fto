#!/usr/bin/env python3
"""Incremental patent daily sync pipeline."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys
from pathlib import Path

from patent_pipeline_common import (
    build_patent_map,
    load_jsonl,
    patent_fingerprint,
    resolve_root,
    sorted_patent_rows,
    write_json,
    write_jsonl,
)


def parse_args() -> argparse.Namespace:
    root = resolve_root()
    parser = argparse.ArgumentParser(description="Run incremental patent data pipeline")
    parser.add_argument("--base-jsonl", default=str(root / "data_sources" / "patents.jsonl"))
    parser.add_argument("--mirror-json", default=str(root / "data_sources" / "patents.json"))
    parser.add_argument("--updates-jsonl", default="", help="Patent insert/update patch JSONL")
    parser.add_argument("--legal-status-jsonl", default="", help="Legal status patch JSONL")
    parser.add_argument("--state-file", default=str(root / "data_lake" / "manifests" / "patent_pipeline_state.json"))
    parser.add_argument("--batch-dir", default=str(root / "data_lake" / "manifests" / "batches"))
    parser.add_argument("--delta-parquet-root", default=str(root / "data_lake" / "patent_delta"))
    parser.add_argument("--export-delta-parquet", action="store_true")
    parser.add_argument("--run-es-upsert", action="store_true")
    parser.add_argument("--queue-embedding", action="store_true")
    parser.add_argument("--es-url", default="http://127.0.0.1:9200")
    parser.add_argument("--es-index", default="fto_patents")
    parser.add_argument("--milvus-uri", default="http://127.0.0.1:19530")
    parser.add_argument("--milvus-collection", default="fto_patent_embeddings")
    parser.add_argument("--embedder", default="hash")
    return parser.parse_args()


def load_state(path: Path) -> dict:
    if not path.exists():
        return {"record_fingerprints": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def apply_updates(base_by_id: dict[str, dict], updates_path: Path | None, legal_status_path: Path | None):
    inserted = 0
    updated = 0
    legal_status_updates = 0

    if updates_path and updates_path.exists():
        for row in load_jsonl(updates_path):
            patent_id = str(row.get("patent_id", "")).strip()
            title = str(row.get("title", "")).strip()
            if not patent_id or not title:
                continue
            next_row = {
                "patent_id": patent_id,
                "title": title,
                "abstract": str(row.get("abstract", "") or ""),
                "claim": str(row.get("claim", "") or ""),
                "keywords": [str(item).strip() for item in (row.get("keywords") or []) if str(item).strip()],
                "legal_status": str(row.get("legal_status", "") or ""),
            }
            if patent_id in base_by_id:
                updated += 1
            else:
                inserted += 1
            base_by_id[patent_id] = next_row

    if legal_status_path and legal_status_path.exists():
        for row in load_jsonl(legal_status_path):
            patent_id = str(row.get("patent_id", "")).strip()
            if not patent_id or patent_id not in base_by_id:
                continue
            legal_status = str(row.get("legal_status", "")).strip()
            if not legal_status:
                continue
            if base_by_id[patent_id].get("legal_status", "") != legal_status:
                base_by_id[patent_id]["legal_status"] = legal_status
                legal_status_updates += 1

    return inserted, updated, legal_status_updates


def compute_changes(previous_fingerprints: dict[str, str], rows_by_id: dict[str, dict]):
    changed_ids: list[str] = []
    current_fingerprints: dict[str, str] = {}
    for patent_id, row in rows_by_id.items():
        fingerprint = patent_fingerprint(row)
        current_fingerprints[patent_id] = fingerprint
        if previous_fingerprints.get(patent_id) != fingerprint:
            changed_ids.append(patent_id)
    return sorted(changed_ids), current_fingerprints


def run(args: list[str]) -> None:
    subprocess.run(args, check=True)


def main() -> None:
    args = parse_args()
    base_jsonl = Path(args.base_jsonl)
    mirror_json = Path(args.mirror_json)
    state_path = Path(args.state_file)
    batch_dir = Path(args.batch_dir)
    delta_root = Path(args.delta_parquet_root)
    batch_ts = dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%SZ")

    rows_by_id = build_patent_map(load_jsonl(base_jsonl))
    inserted, updated, legal_status_updates = apply_updates(
        rows_by_id,
        Path(args.updates_jsonl) if args.updates_jsonl else None,
        Path(args.legal_status_jsonl) if args.legal_status_jsonl else None,
    )

    previous = load_state(state_path)
    changed_ids, current_fingerprints = compute_changes(previous.get("record_fingerprints", {}), rows_by_id)
    if not changed_ids:
        print("[ok] no_changed_patents")
        return

    sorted_rows = sorted_patent_rows(rows_by_id)
    write_jsonl(base_jsonl, sorted_rows)
    write_json(mirror_json, sorted_rows)

    batch_dir.mkdir(parents=True, exist_ok=True)
    ids_file = batch_dir / f"changed_patent_ids_{batch_ts}.txt"
    ids_file.write_text("".join(f"{patent_id}\n" for patent_id in changed_ids), encoding="utf-8")

    delta_dir = delta_root / f"batch_ts={batch_ts}"
    if args.export_delta_parquet:
        run(
            [
                sys.executable,
                str(resolve_root() / "scripts" / "export_patents_parquet.py"),
                "--input",
                str(base_jsonl),
                "--output",
                str(delta_dir),
                "--ids-file",
                str(ids_file),
                "--overwrite",
            ]
        )

    es_status = "skipped"
    if args.run_es_upsert:
        if not args.export_delta_parquet:
            raise SystemExit("[error] --run-es-upsert requires --export-delta-parquet")
        run(
            [
                sys.executable,
                str(resolve_root() / "scripts" / "index_patents_es_from_parquet.py"),
                "--input",
                str(delta_dir),
                "--url",
                args.es_url,
                "--index",
                args.es_index,
                "--ids-file",
                str(ids_file),
            ]
        )
        es_status = "done"

    embedding_status = "pending" if args.queue_embedding else "skipped"
    manifest = {
        "batch_ts": batch_ts,
        "changed_patent_count": len(changed_ids),
        "changed_ids_file": str(ids_file),
        "delta_parquet_dir": str(delta_dir) if args.export_delta_parquet else "",
        "inserted": inserted,
        "updated": updated,
        "legal_status_updates": legal_status_updates,
        "es": {"status": es_status, "url": args.es_url, "index": args.es_index},
        "embedding": {
            "status": embedding_status,
            "uri": args.milvus_uri,
            "collection": args.milvus_collection,
            "embedder": args.embedder,
        },
    }
    manifest_path = batch_dir / f"patent_batch_{batch_ts}.json"
    write_json(manifest_path, manifest)
    write_json(
        state_path,
        {
            "updated_at": batch_ts,
            "latest_batch_manifest": str(manifest_path),
            "record_fingerprints": current_fingerprints,
        },
    )

    print(
        f"[ok] patent_incremental_pipeline batch={batch_ts} changed={len(changed_ids)} "
        f"inserted={inserted} updated={updated} legal_status_updates={legal_status_updates}"
    )
    print(f"[ok] ids_file={ids_file}")
    print(f"[ok] batch_manifest={manifest_path}")


if __name__ == "__main__":
    main()
