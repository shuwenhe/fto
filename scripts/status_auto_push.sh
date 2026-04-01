#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$REPO_ROOT/.git/.auto-commit.pid"
LOG_FILE="$REPO_ROOT/.git/.auto-commit.log"

if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE" || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    echo "[auto] running pid=$pid"
    echo "[auto] log: $LOG_FILE"
    exit 0
  fi
  rm -f "$PID_FILE"
  echo "[auto] removed stale pid file: $PID_FILE"
  exit 1
fi

echo "[auto] not running"
