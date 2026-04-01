#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO_ROOT" ]]; then
  echo "[auto-pull] not inside a git repository"
  exit 1
fi

cd "$REPO_ROOT"

INTERVAL_SEC="${AUTO_PULL_INTERVAL_SEC:-10}"
PULL_REMOTE="${AUTO_PULL_REMOTE:-origin}"
CURRENT_BRANCH="$(git branch --show-current 2>/dev/null || true)"
if [[ -z "$CURRENT_BRANCH" || "$CURRENT_BRANCH" == "HEAD" ]]; then
  CURRENT_BRANCH="main"
fi
PULL_BRANCH="${AUTO_PULL_BRANCH:-$CURRENT_BRANCH}"

if ! [[ "$INTERVAL_SEC" =~ ^[0-9]+$ ]] || [[ "$INTERVAL_SEC" -lt 1 ]]; then
  echo "[auto-pull] invalid AUTO_PULL_INTERVAL_SEC='$INTERVAL_SEC', fallback to 10"
  INTERVAL_SEC=10
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[auto-pull] invalid git repository"
  exit 1
fi

if ! git remote get-url "$PULL_REMOTE" >/dev/null 2>&1; then
  echo "[auto-pull] remote '$PULL_REMOTE' not found"
  exit 1
fi

echo "[auto-pull] started repo=$REPO_ROOT interval=${INTERVAL_SEC}s remote=$PULL_REMOTE branch=$PULL_BRANCH"

while true; do
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "[auto-pull] skip: working tree not clean"
    sleep "$INTERVAL_SEC"
    continue
  fi

  if [[ -d .git/rebase-merge || -d .git/rebase-apply || -f .git/MERGE_HEAD ]]; then
    echo "[auto-pull] skip: repository is in the middle of merge or rebase"
    sleep "$INTERVAL_SEC"
    continue
  fi

  if git fetch "$PULL_REMOTE" "$PULL_BRANCH" >/dev/null 2>&1; then
    counts="$(git rev-list --left-right --count HEAD...${PULL_REMOTE}/${PULL_BRANCH} 2>/dev/null || echo '0 0')"
    ahead="$(awk '{print $1}' <<<"$counts")"
    behind="$(awk '{print $2}' <<<"$counts")"

    if [[ "${behind:-0}" -gt 0 ]]; then
      if [[ "${ahead:-0}" -gt 0 ]]; then
        echo "[auto-pull] skip: local branch ahead=${ahead} behind=${behind}, requires manual reconciliation"
      elif git pull --ff-only "$PULL_REMOTE" "$PULL_BRANCH" >/dev/null 2>&1; then
        head_sha="$(git rev-parse --short HEAD)"
        echo "[auto-pull] updated to ${PULL_REMOTE}/${PULL_BRANCH} head=${head_sha}"
      else
        echo "[auto-pull] fast-forward pull failed: ${PULL_REMOTE}/${PULL_BRANCH}"
        git pull --ff-only "$PULL_REMOTE" "$PULL_BRANCH" 2>&1 | sed 's/^/[auto-pull] pull error: /' || true
      fi
    fi
  else
    echo "[auto-pull] fetch failed: ${PULL_REMOTE}/${PULL_BRANCH}"
    git fetch "$PULL_REMOTE" "$PULL_BRANCH" 2>&1 | sed 's/^/[auto-pull] fetch error: /' || true
  fi

  sleep "$INTERVAL_SEC"
done
