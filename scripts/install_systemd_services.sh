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

if [[ ! -f /etc/default/fto-backend ]]; then
  cat >/etc/default/fto-backend <<'EOF'
# Backend environment variables
REDIS_PASSWORD=123456
EOF
  chmod 600 /etc/default/fto-backend
fi

systemctl daemon-reload
systemctl enable fto-backend.service fto-frontend.service fto-frontend-watch.service

echo "[ok] installed services: fto-backend, fto-frontend, fto-frontend-watch"
echo "[hint] edit /etc/default/fto-backend to change REDIS_PASSWORD"
echo "[hint] start now: systemctl restart fto-backend fto-frontend fto-frontend-watch"
