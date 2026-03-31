#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO_ROOT" ]]; then
  echo "[auto] not inside a git repository"
  exit 1
fi

cd "$REPO_ROOT"

INTERVAL_SEC="${AUTO_COMMIT_INTERVAL_SEC:-5}"
PUSH_ENABLED_RAW="${AUTO_COMMIT_PUSH:-1}"
PUSH_REMOTE="${AUTO_COMMIT_PUSH_REMOTE:-origin}"
CURRENT_BRANCH="$(git branch --show-current 2>/dev/null || true)"
if [[ -z "$CURRENT_BRANCH" || "$CURRENT_BRANCH" == "HEAD" ]]; then
  CURRENT_BRANCH="main"
fi
PUSH_BRANCH="${AUTO_COMMIT_PUSH_BRANCH:-$CURRENT_BRANCH}"
COMMIT_PREFIX="${AUTO_COMMIT_PREFIX:-chore(auto)}"

is_true() {
  case "${1,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

if ! [[ "$INTERVAL_SEC" =~ ^[0-9]+$ ]] || [[ "$INTERVAL_SEC" -lt 1 ]]; then
  echo "[auto] invalid AUTO_COMMIT_INTERVAL_SEC='$INTERVAL_SEC', fallback to 5"
  INTERVAL_SEC=5
fi

PUSH_ENABLED=0
if is_true "$PUSH_ENABLED_RAW"; then
  PUSH_ENABLED=1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[auto] invalid git repository"
  exit 1
fi

if ! git remote get-url "$PUSH_REMOTE" >/dev/null 2>&1; then
  echo "[auto] remote '$PUSH_REMOTE' not found; set it first: git remote add $PUSH_REMOTE <url>"
  exit 1
fi

git_user_name="$(git config --get user.name || true)"
git_user_email="$(git config --get user.email || true)"
if [[ -z "$git_user_name" || -z "$git_user_email" ]]; then
  echo "[auto] missing git identity. configure first:"
  echo "[auto]   git config user.name \"Your Name\""
  echo "[auto]   git config user.email \"you@example.com\""
fi

echo "[auto] started repo=$REPO_ROOT interval=${INTERVAL_SEC}s push=$PUSH_ENABLED remote=$PUSH_REMOTE branch=$PUSH_BRANCH"

while true; do
  if [[ -n "$(git status --porcelain)" ]]; then
    git add -A

    if ! git diff --cached --quiet; then
      ts="$(date '+%Y-%m-%d %H:%M:%S')"
      subject="$COMMIT_PREFIX: sync changes at $ts"

      git_user_name="$(git config --get user.name || true)"
      git_user_email="$(git config --get user.email || true)"
      if [[ -z "$git_user_name" || -z "$git_user_email" ]]; then
        echo "[auto] skip commit: git user.name/user.email not configured"
        sleep "$INTERVAL_SEC"
        continue
      fi

      if git commit -m "$subject" >/dev/null 2>&1; then
        echo "[auto] committed: $subject"

        if [[ "$PUSH_ENABLED" -eq 1 ]]; then
          if git push "$PUSH_REMOTE" "$PUSH_BRANCH" >/dev/null 2>&1; then
            echo "[auto] pushed to ${PUSH_REMOTE}/${PUSH_BRANCH}"
          else
            echo "[auto] push failed: ${PUSH_REMOTE}/${PUSH_BRANCH}"
            git push "$PUSH_REMOTE" "$PUSH_BRANCH" 2>&1 | sed 's/^/[auto] push error: /' || true
          fi
        fi
      else
        echo "[auto] commit failed"
        git commit -m "$subject" 2>&1 | sed 's/^/[auto] commit error: /' || true
      fi
    fi
  fi

  sleep "$INTERVAL_SEC"
done
