#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSTEMD_DIR="/etc/systemd/system"

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

if [[ ! -f /etc/default/fto-auto-commit ]]; then
  cat >/etc/default/fto-auto-commit <<'EOF'
# Auto commit service environment variables
AUTO_COMMIT_INTERVAL_SEC=5
AUTO_COMMIT_PUSH=1
AUTO_COMMIT_PUSH_REMOTE=origin
EOF
  chmod 600 /etc/default/fto-auto-commit
fi

systemctl daemon-reload
systemctl enable fto-auto-commit.service

echo "[ok] installed service: fto-auto-commit"
echo "[hint] edit /etc/default/fto-auto-commit to change auto push interval or remote"
echo "[hint] start now: systemctl restart fto-auto-commit"
