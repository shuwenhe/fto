#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Running one-click deploy from ${REPO_ROOT}"

if [[ $(id -u) -ne 0 ]]; then
  echo "This script may use sudo for system installs; you may be prompted for your password."
fi

echo "1) Build backend"
cd "${REPO_ROOT}/backend"
if ! command -v go >/dev/null 2>&1; then
  echo "go not found in PATH; please install Go or run this script on the target host with Go available"
  exit 1
fi
go build -o fto-backend-bin
echo "backend built: ${REPO_ROOT}/backend/fto-backend-bin"

echo "2) Build frontend"
cd "${REPO_ROOT}"
if [[ -f /root/.nvm/nvm.sh ]]; then
  # prefer nvm-installed Node if present
  # shellcheck source=/root/.nvm/nvm.sh
  source /root/.nvm/nvm.sh || true
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found in PATH; please install Node.js (nvm recommended)"
  exit 1
fi
cd "${REPO_ROOT}/frontend"
npm ci
npm run build
echo "frontend built"

echo "3) Install nginx config"
NGINX_TARGET=/etc/nginx/conf.d/fto.conf
sudo cp "${REPO_ROOT}/deploy/nginx/fto.conf" "$NGINX_TARGET"
sudo nginx -t
sudo systemctl reload nginx || true
echo "nginx config installed to $NGINX_TARGET"

echo "4) Install and enable systemd services"
sudo bash "${REPO_ROOT}/scripts/install_systemd_services.sh"

echo "5) Restart services"
sudo systemctl restart fto-backend fto-frontend || sudo systemctl start fto-backend fto-frontend
if systemctl cat fto-frontend-watch >/dev/null 2>&1; then
  sudo systemctl restart fto-frontend-watch || true
fi
if systemctl cat fto-auto-commit >/dev/null 2>&1; then
  sudo systemctl restart fto-auto-commit || true
fi

echo "6) Open firewall port 8080 if ufw present"
if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow 8080/tcp || true
fi

echo "Deployment complete. Quick checks:"
echo "  curl -I http://8.140.241.141:8080/fto/"
echo "  curl -sS http://8.140.241.141:8080/fto/api/health"

echo "If any step failed, inspect logs with: sudo journalctl -u fto-backend -u fto-frontend -n 200 --no-pager"

exit 0
