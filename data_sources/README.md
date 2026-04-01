# Patent Data Sources

This directory stores patent source datasets for FTO retrieval.

- `patents.jsonl`: newline-delimited JSON records used by backend local retrieval.
- `patents.json`: JSON array mirror of the same dataset.
- `../data_lake/patent_core/`: partitioned Parquet dataset for large-scale indexing and analytics.
- `queries.jsonl`: evaluation queries (`query_id`, `query`, `desc`).
- `qrels.jsonl`: relevance labels (`query_id`, `patent_id`, `relevance`).
- Import helper: `node /app/fto/scripts/save_google_patent.mjs <PATENT_ID>`

For large datasets, keep `patents.jsonl` only as import/exchange format. Generate Parquet as the durable source for Elasticsearch and Milvus indexing.

## Incremental Daily Pipeline

Recommended daily flow:

1. New patents land as JSONL patch file.
2. Legal status changes land as JSONL patch file.
3. Merge both into `patents.jsonl`.
4. Detect changed `patent_id`s via record fingerprint.
5. Export only changed records as delta Parquet.
6. Upsert delta into Elasticsearch immediately.
7. Queue embedding updates and backfill Milvus asynchronously.

Run incremental sync:

```bash
cd /app/fto
make patent-incremental-sync UPDATES_JSONL=/path/to/new_patents.jsonl
```

With legal status patch:

```bash
cd /app/fto
make patent-incremental-sync \
  UPDATES_JSONL=/path/to/new_patents.jsonl \
  LEGAL_STATUS_JSONL=/path/to/legal_status_updates.jsonl
```

Artifacts written by the pipeline:

- `data_lake/manifests/patent_pipeline_state.json`
- `data_lake/manifests/batches/patent_batch_<ts>.json`
- `data_lake/manifests/batches/changed_patent_ids_<ts>.txt`
- `data_lake/patent_delta/batch_ts=<ts>/`

Process queued embedding backfill later:

```bash
cd /app/fto
make patent-process-pending-embeddings
```

## Keep JSON and JSONL In Sync

```bash
cd /app/fto
make sync-patent-data
```

The sync script auto-detects newer file as source (`patents.jsonl` or `patents.json`) and rewrites both files with de-duplicated records.

## Export To Parquet

```bash
cd /app/fto
make export-patents-parquet
```

Default output:

- `/app/fto/data_lake/patent_core/`

Default partitions:

- `country`
- `pub_year`

Dependency:

- `pip install pyarrow`

## Build Elasticsearch Index From Parquet

```bash
cd /app/fto
make index-patents-es-from-parquet
```

Dependency:

- `pip install pyarrow`

## Build Milvus Embeddings From Parquet

```bash
cd /app/fto
make index-patent-embeddings-milvus
```

Default mode uses `hash` embeddings for smoke tests. For production embeddings, pass a sentence-transformers model id to the script directly, for example:

```bash
python3 scripts/index_patent_embeddings_milvus.py \
  --embedder sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
```

Dependencies:

- `pip install pyarrow pymilvus`
- `pip install sentence-transformers` for model-based embeddings

## Retrieval Evaluation

```bash
cd /app/fto
make eval-retrieval
```

## neurx Model Training

Train the neurx-based FTO ranker artifact:

```bash
cd /app/fto
make train-fto-model
```

Default artifact output:

- `model_artifacts/fto_ranker_neurx_v1.json`

This computes `Recall@K`, `MRR@K`, and `NDCG@K` using `queries.jsonl` and `qrels.jsonl`.

## Recall Model Training

Train the weighted dual-recall model artifact first, then evaluate retrieval with this model:

```bash
cd /app/fto
make train-fto-recall-model
make eval-retrieval-model
```

Default recall artifact output:

- `model_artifacts/fto_recall_dual_v1.json`

JSONL schema:

- `patent_id` string
- `title` string
- `abstract` string
- `claim` string
- `keywords` string array
- `legal_status` string

## Import From Google Patents

Example:

```bash
cd /app/fto
make import-patent PATENT_ID=CN202410001A
```

This fetches metadata/content from Google Patents and upserts it into `patents.jsonl`.

If server cannot access Google directly, save page source from browser and import offline:

```bash
node /app/fto/scripts/save_google_patent.mjs --html /path/to/patent.html --id CN202410001A
```
