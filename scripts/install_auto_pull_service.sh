#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

mkdir -p "$SYSTEMD_DIR"

cat >"$SYSTEMD_DIR/fto-auto-pull.service" <<EOF
[Unit]
Description=FTO Auto Pull Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO_ROOT}
EnvironmentFile=-${HOME}/.config/fto-auto-pull.env
ExecStart=/usr/bin/bash ${REPO_ROOT}/scripts/auto_pull_on_update.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

if [[ ! -f "${HOME}/.config/fto-auto-pull.env" ]]; then
  mkdir -p "${HOME}/.config"
  cat >"${HOME}/.config/fto-auto-pull.env" <<'EOF'
# Auto pull service environment variables
AUTO_PULL_INTERVAL_SEC=10
AUTO_PULL_REMOTE=origin
EOF
  chmod 600 "${HOME}/.config/fto-auto-pull.env"
fi

systemctl --user daemon-reload
systemctl --user enable fto-auto-pull.service

echo "[ok] installed service: fto-auto-pull"
echo "[hint] edit ${HOME}/.config/fto-auto-pull.env to change auto pull interval or remote"
echo "[hint] start now: systemctl --user restart fto-auto-pull"
