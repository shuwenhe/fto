#!/usr/bin/env python3
"""Generate patent embeddings from Parquet and upsert them into Milvus."""

from __future__ import annotations

import argparse
import hashlib
import math
from pathlib import Path


def require_pyarrow():
    try:
        import pyarrow.dataset as ds
    except ImportError as exc:
        raise SystemExit(
            "[error] pyarrow is required. Install with: pip install pyarrow"
        ) from exc
    return ds


def require_milvus():
    try:
        from pymilvus import (
            Collection,
            CollectionSchema,
            DataType,
            FieldSchema,
            connections,
            utility,
        )
    except ImportError as exc:
        raise SystemExit(
            "[error] pymilvus is required. Install with: pip install pymilvus"
        ) from exc
    return Collection, CollectionSchema, DataType, FieldSchema, connections, utility


def normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vec))
    if norm <= 1e-12:
        return vec
    return [x / norm for x in vec]


def hash_embed(text: str, dim: int) -> list[float]:
    vec = [0.0] * dim
    for token in text.lower().split():
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        idx = int.from_bytes(digest[:4], "big") % dim
        sign = 1.0 if digest[4] % 2 == 0 else -1.0
        vec[idx] += sign
    return normalize(vec)


def build_embedder(name: str, dim: int):
    mode = (name or "").strip()
    if mode == "hash":
        return lambda text: hash_embed(text, dim), dim

    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:
        raise SystemExit(
            "[error] sentence-transformers is required for model embeddings. "
            "Install with: pip install sentence-transformers"
        ) from exc
    model = SentenceTransformer(mode)
    sample_dim = len(model.encode("dimension probe", normalize_embeddings=True))
    return (
        lambda text: model.encode(text, normalize_embeddings=True).tolist(),
        sample_dim,
    )


def ensure_collection(collection_name: str, dim: int, metric_type: str):
    Collection, CollectionSchema, DataType, FieldSchema, connections, utility = require_milvus()

    if utility.has_collection(collection_name):
        col = Collection(collection_name)
        existing_dim = next(
            (field.params.get("dim") for field in col.schema.fields if field.name == "embedding"),
            None,
        )
        if existing_dim and int(existing_dim) != dim:
            raise SystemExit(
                f"[error] existing collection dim mismatch collection={collection_name} expected={existing_dim} got={dim}"
            )
        return col

    fields = [
        FieldSchema(name="patent_id", dtype=DataType.VARCHAR, is_primary=True, auto_id=False, max_length=128),
        FieldSchema(name="country", dtype=DataType.VARCHAR, max_length=8),
        FieldSchema(name="pub_year", dtype=DataType.INT64),
        FieldSchema(name="legal_status_group", dtype=DataType.VARCHAR, max_length=32),
        FieldSchema(name="text", dtype=DataType.VARCHAR, max_length=65535),
        FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=dim),
    ]
    schema = CollectionSchema(fields=fields, description="FTO patent embeddings")
    col = Collection(collection_name, schema=schema)
    col.create_index(
        field_name="embedding",
        index_params={
            "index_type": "HNSW",
            "metric_type": metric_type,
            "params": {"M": 16, "efConstruction": 200},
        },
    )
    return col


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Generate embeddings from patent Parquet and write to Milvus")
    parser.add_argument("--input", default=str(root / "data_lake" / "patent_core"))
    parser.add_argument("--uri", default="http://127.0.0.1:19530")
    parser.add_argument("--token", default="")
    parser.add_argument("--collection", default="fto_patent_embeddings")
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument(
        "--embedder",
        default="hash",
        help="Embedding backend: 'hash' for smoke tests or a sentence-transformers model id",
    )
    parser.add_argument("--hash-dim", type=int, default=256)
    parser.add_argument("--metric-type", default="COSINE")
    parser.add_argument("--ids-file", default="", help="Optional file containing patent IDs to embed")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    ds = require_pyarrow()
    Collection, CollectionSchema, DataType, FieldSchema, connections, utility = require_milvus()

    input_path = Path(args.input)
    if not input_path.exists():
        raise SystemExit(f"[error] parquet dataset not found: {input_path}")

    embed, dim = build_embedder(args.embedder, args.hash_dim)
    connections.connect(uri=args.uri, token=args.token or None)
    collection = ensure_collection(args.collection, dim, args.metric_type)

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
    patent_ids: list[str] = []
    countries: list[str] = []
    pub_years: list[int] = []
    status_groups: list[str] = []
    texts: list[str] = []
    vectors: list[list[float]] = []
    inserted = 0

    def flush():
        nonlocal patent_ids, countries, pub_years, status_groups, texts, vectors, inserted
        if not patent_ids:
            return
        collection.upsert([patent_ids, countries, pub_years, status_groups, texts, vectors])
        inserted += len(patent_ids)
        patent_ids, countries, pub_years, status_groups, texts, vectors = [], [], [], [], [], []

    for batch in dataset.to_batches(batch_size=args.batch_size):
        for row in batch.to_pylist():
            patent_id = str(row.get("patent_id", "")).strip()
            if not patent_id:
                continue
            if selected_ids is not None and patent_id not in selected_ids:
                continue
            text = " ".join(
                str(row.get(key, "") or "") for key in ("title", "abstract", "claim")
            ).strip()
            patent_ids.append(patent_id)
            countries.append(str(row.get("country", "") or "UN"))
            pub_years.append(int(row.get("pub_year") or 0))
            status_groups.append(str(row.get("legal_status_group", "") or "unknown"))
            texts.append(text[:65535])
            vectors.append(embed(text))
        flush()

    collection.load()
    print(
        f"[ok] milvus_upserted collection={args.collection} documents={inserted} "
        f"input={input_path} embedder={args.embedder} dim={dim}"
    )


if __name__ == "__main__":
    main()
