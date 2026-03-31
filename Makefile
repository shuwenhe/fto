.PHONY: help frontend-install frontend-dev frontend-build frontend-start backend-deps backend-run backend-health curl nginx-test nginx-reload git-auto-start git-auto-stop git-auto-status git-auto-log

help:
	@echo "Available targets:"
	@echo "  make frontend-install # Install Next.js dependencies"
	@echo "  make frontend-dev     # Run Next.js dev server on :3010"
	@echo "  make frontend-build   # Build Next.js frontend"
	@echo "  make frontend-start   # Start Next.js production server on :3010"
	@echo "  make backend-deps     # Download Go dependencies"
	@echo "  make backend-run      # Run Gin backend on :8010"
	@echo "  make backend-health   # Check backend health via /fto/api/health"
	@echo "  make git-auto-start  # Start git auto commit/push daemon"
	@echo "  make git-auto-stop   # Stop git auto commit/push daemon"
	@echo "  make git-auto-status # Show git auto daemon status"
	@echo "  make git-auto-log    # Tail git auto daemon log"
	@echo "  make curl         # Quick check local nginx route: /fto/"
	@echo "  make nginx-test   # Test nginx config"
	@echo "  make nginx-reload # Reload nginx"

frontend-install:
	cd frontend && npm install

frontend-dev:
	cd frontend && npm run dev

frontend-build:
	cd frontend && npm run build

frontend-start:
	cd frontend && npm run start

backend-deps:
	cd backend && go mod tidy

git-auto-start:
	bash scripts/start_auto_push.sh

git-auto-stop:
	bash scripts/stop_auto_push.sh

git-auto-status:
	bash scripts/status_auto_push.sh

git-auto-log:
	tail -n 100 -f .git/.auto-commit.log

backend-run:
	cd backend && go run main.go

backend-health:
	curl -sS http://127.0.0.1/fto/api/health

curl:
	curl -sS -I http://127.0.0.1/fto/ | sed -n '1,20p'

nginx-test:
	nginx -t

nginx-reload:
	systemctl reload nginx
