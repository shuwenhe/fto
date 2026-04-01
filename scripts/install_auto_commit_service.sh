#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

mkdir -p "$SYSTEMD_DIR"

cat >"$SYSTEMD_DIR/fto-auto-commit.service" <<EOF
[Unit]
Description=FTO Auto Commit And Push Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO_ROOT}
EnvironmentFile=-${HOME}/.config/fto-auto-commit.env
ExecStart=/usr/bin/bash ${REPO_ROOT}/scripts/auto_commit_on_change.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

if [[ ! -f "${HOME}/.config/fto-auto-commit.env" ]]; then
  mkdir -p "${HOME}/.config"
  cat >"${HOME}/.config/fto-auto-commit.env" <<'EOF'
# Auto commit service environment variables
AUTO_COMMIT_INTERVAL_SEC=5
AUTO_COMMIT_PUSH=1
AUTO_COMMIT_PUSH_REMOTE=origin
EOF
  chmod 600 "${HOME}/.config/fto-auto-commit.env"
fi

systemctl --user daemon-reload
systemctl --user enable fto-auto-commit.service

echo "[ok] installed service: fto-auto-commit"
echo "[hint] edit ${HOME}/.config/fto-auto-commit.env to change auto push interval or remote"
echo "[hint] start now: systemctl --user restart fto-auto-commit"
