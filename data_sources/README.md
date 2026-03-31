# Patent Data Sources

This directory stores patent source datasets for FTO retrieval.

- `patents.jsonl`: newline-delimited JSON records used by backend local retrieval.

JSONL schema:

- `patent_id` string
- `title` string
- `abstract` string
- `claim` string
- `keywords` string array
- `legal_status` string
