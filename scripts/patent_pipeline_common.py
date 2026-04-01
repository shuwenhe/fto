#!/usr/bin/env python3
"""Shared helpers for patent incremental pipeline scripts."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


def resolve_root() -> Path:
    return Path(__file__).resolve().parents[1]


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as fh:
        for line_no, raw in enumerate(fh, start=1):
            text = raw.strip()
            if not text:
                continue
            try:
                rows.append(json.loads(text))
            except json.JSONDecodeError as exc:
                raise SystemExit(f"[error] invalid jsonl line={line_no} path={path}: {exc}") from exc
    return rows


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def normalize_patent_record(row: dict) -> dict:
    patent_id = str(row.get("patent_id", "")).strip()
    title = str(row.get("title", "")).strip()
    abstract = str(row.get("abstract", "") or "")
    claim = str(row.get("claim", "") or "")
    legal_status = str(row.get("legal_status", "") or "")
    keywords = row.get("keywords") or []
    if not isinstance(keywords, list):
        keywords = []
    return {
        "patent_id": patent_id,
        "title": title,
        "abstract": abstract,
        "claim": claim,
        "keywords": [str(item).strip() for item in keywords if str(item).strip()],
        "legal_status": legal_status,
    }


def patent_fingerprint(row: dict) -> str:
    payload = json.dumps(
        normalize_patent_record(row),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def build_patent_map(rows: list[dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for row in rows:
        normalized = normalize_patent_record(row)
        if not normalized["patent_id"] or not normalized["title"]:
            continue
        out[normalized["patent_id"]] = normalized
    return out


def sorted_patent_rows(rows_by_id: dict[str, dict]) -> list[dict]:
    return [rows_by_id[key] for key in sorted(rows_by_id)]
