#!/usr/bin/env python3
"""Process queued embedding backfill batches and upsert them into Milvus."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from patent_pipeline_common import resolve_root, write_json


def parse_args() -> argparse.Namespace:
    root = resolve_root()
    parser = argparse.ArgumentParser(description="Process queued patent embedding batches")
    parser.add_argument("--batch-dir", default=str(root / "data_lake" / "manifests" / "batches"))
    parser.add_argument("--milvus-uri", default="http://127.0.0.1:19530")
    parser.add_argument("--collection", default="fto_patent_embeddings")
    parser.add_argument("--embedder", default="", help="Override embedder from manifest")
    parser.add_argument("--limit", type=int, default=1)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    batch_dir = Path(args.batch_dir)
    processed = 0
    for manifest_path in sorted(batch_dir.glob("patent_batch_*.json")):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        embedding = manifest.get("embedding") or {}
        if embedding.get("status") != "pending":
            continue
        delta_dir = str(manifest.get("delta_parquet_dir") or "").strip()
        ids_file = str(manifest.get("changed_ids_file") or "").strip()
        if not delta_dir or not ids_file:
            embedding["status"] = "failed"
            embedding["error"] = "missing delta_parquet_dir or changed_ids_file"
            manifest["embedding"] = embedding
            write_json(manifest_path, manifest)
            continue

        embedder = args.embedder or embedding.get("embedder") or "hash"
        try:
            subprocess.run(
                [
                    sys.executable,
                    str(resolve_root() / "scripts" / "index_patent_embeddings_milvus.py"),
                    "--input",
                    delta_dir,
                    "--ids-file",
                    ids_file,
                    "--uri",
                    args.milvus_uri,
                    "--collection",
                    args.collection,
                    "--embedder",
                    embedder,
                ],
                check=True,
            )
        except subprocess.CalledProcessError as exc:
            embedding["status"] = "failed"
            embedding["error"] = f"command exited with code {exc.returncode}"
            manifest["embedding"] = embedding
            write_json(manifest_path, manifest)
            raise

        embedding["status"] = "done"
        embedding["uri"] = args.milvus_uri
        embedding["collection"] = args.collection
        embedding["embedder"] = embedder
        manifest["embedding"] = embedding
        write_json(manifest_path, manifest)
        processed += 1
        if processed >= args.limit:
            break

    print(f"[ok] embedding_batches_processed={processed}")


if __name__ == "__main__":
    main()
