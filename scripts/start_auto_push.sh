#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$REPO_ROOT/.git/.auto-commit.pid"
LOG_FILE="$REPO_ROOT/.git/.auto-commit.log"
DAEMON_SCRIPT="$REPO_ROOT/scripts/auto_commit_on_change.sh"
LOCK_DIR="$REPO_ROOT/.git/.auto-commit.lock"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[auto] another start is in progress, try again"
  exit 1
fi
trap 'rmdir "$LOCK_DIR" >/dev/null 2>&1 || true' EXIT

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" >/dev/null 2>&1; then
    echo "[auto] already running pid=$old_pid"
    echo "[auto] log: $LOG_FILE"
    exit 0
  fi
  rm -f "$PID_FILE"
  echo "[auto] removed stale pid file"
fi

cd "$REPO_ROOT"
nohup bash "$DAEMON_SCRIPT" >> "$LOG_FILE" 2>&1 &
new_pid=$!
echo "$new_pid" > "$PID_FILE"

echo "[auto] started pid=$new_pid"
echo "[auto] log: $LOG_FILE"
