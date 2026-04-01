#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSTEMD_DIR="/etc/systemd/system"

if [[ ! -f /root/.nvm/nvm.sh ]]; then
  echo "[error] /root/.nvm/nvm.sh not found, frontend service requires Node from nvm"
  exit 1
fi

install -m 0644 "$REPO_ROOT/deploy/systemd/fto-backend.service" "$SYSTEMD_DIR/fto-backend.service"
install -m 0644 "$REPO_ROOT/deploy/systemd/fto-frontend.service" "$SYSTEMD_DIR/fto-frontend.service"
install -m 0644 "$REPO_ROOT/deploy/systemd/fto-frontend-watch.service" "$SYSTEMD_DIR/fto-frontend-watch.service"
install -m 0644 "$REPO_ROOT/deploy/systemd/fto-query-rewrite-prune.service" "$SYSTEMD_DIR/fto-query-rewrite-prune.service"
install -m 0644 "$REPO_ROOT/deploy/systemd/fto-query-rewrite-prune.timer" "$SYSTEMD_DIR/fto-query-rewrite-prune.timer"
install -m 0644 "$REPO_ROOT/deploy/systemd/fto-query-rewrite-prune.path" "$SYSTEMD_DIR/fto-query-rewrite-prune.path"

cat >"$SYSTEMD_DIR/fto-auto-commit.service" <<EOF
[Unit]
Description=FTO Auto Commit And Push Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO_ROOT}
EnvironmentFile=-/etc/default/fto-auto-commit
ExecStart=/usr/bin/bash ${REPO_ROOT}/scripts/auto_commit_on_change.sh
Restart=always
RestartSec=5
User=root
Group=root

[Install]
WantedBy=multi-user.target
EOF

if [[ ! -f /etc/default/fto-backend ]]; then
  cat >/etc/default/fto-backend <<'EOF'
# Backend environment variables
REDIS_PASSWORD=123456
EOF
  chmod 600 /etc/default/fto-backend
fi

if [[ ! -f /etc/default/fto-auto-commit ]]; then
  cat >/etc/default/fto-auto-commit <<'EOF'
# Auto commit service environment variables
AUTO_COMMIT_INTERVAL_SEC=5
AUTO_COMMIT_PUSH=1
AUTO_COMMIT_PUSH_REMOTE=origin
EOF
  chmod 600 /etc/default/fto-auto-commit
fi

if [[ ! -f /etc/default/fto-query-rewrite-prune ]]; then
  cat >/etc/default/fto-query-rewrite-prune <<'EOF'
# Query rewrite auto prune environment variables
REWRITE_K=5
REWRITE_MIN_NDCG_CONTRIBUTION=0
REWRITE_MIN_HIT_QUERIES=2
REWRITE_AUTO_APPLY=1
REWRITE_RESTART_BACKEND_ON_APPLY=1
EOF
  chmod 600 /etc/default/fto-query-rewrite-prune
fi

systemctl daemon-reload
systemctl enable fto-backend.service fto-frontend.service fto-frontend-watch.service fto-auto-commit.service
systemctl enable fto-query-rewrite-prune.timer fto-query-rewrite-prune.path

echo "[ok] installed services: fto-backend, fto-frontend, fto-frontend-watch, fto-auto-commit, fto-query-rewrite-prune"
echo "[hint] edit /etc/default/fto-backend to change REDIS_PASSWORD"
echo "[hint] edit /etc/default/fto-auto-commit to change auto push interval or remote"
echo "[hint] edit /etc/default/fto-query-rewrite-prune to tune prune threshold"
echo "[hint] start now: systemctl restart fto-backend fto-frontend fto-frontend-watch fto-auto-commit"
echo "[hint] run prune now: systemctl start fto-query-rewrite-prune.service"
