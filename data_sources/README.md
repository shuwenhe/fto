# Patent Data Sources

This directory stores patent source datasets for FTO retrieval.

- `patents.jsonl`: newline-delimited JSON records used by backend local retrieval.
- `patents.json`: JSON array mirror of the same dataset.
- `queries.jsonl`: evaluation queries (`query_id`, `query`, `desc`).
- `qrels.jsonl`: relevance labels (`query_id`, `patent_id`, `relevance`).
- Import helper: `node /app/fto/scripts/save_google_patent.mjs <PATENT_ID>`

## Keep JSON and JSONL In Sync

```bash
cd /app/fto
make sync-patent-data
```

The sync script auto-detects newer file as source (`patents.jsonl` or `patents.json`) and rewrites both files with de-duplicated records.

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
