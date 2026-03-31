# Patent Data Sources

This directory stores patent source datasets for FTO retrieval.

- `patents.jsonl`: newline-delimited JSON records used by backend local retrieval.
- Import helper: `node /app/fto/scripts/save_google_patent.mjs <PATENT_ID>`

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
