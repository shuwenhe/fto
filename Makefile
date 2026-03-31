.PHONY: help run run-bg stop status curl nginx-test nginx-reload git-auto-start git-auto-stop git-auto-status git-auto-log

PORT ?= 5173

help:
	@echo "Available targets:"
	@echo "  make run          # Serve current folder on http://127.0.0.1:$(PORT)"
	@echo "  make run-bg       # Run server in background (writes .server.pid/.server.log)"
	@echo "  make stop         # Stop background server"
	@echo "  make status       # Show background server status"
	@echo "  make git-auto-start  # Start git auto commit/push daemon"
	@echo "  make git-auto-stop   # Stop git auto commit/push daemon"
	@echo "  make git-auto-status # Show git auto daemon status"
	@echo "  make git-auto-log    # Tail git auto daemon log"
	@echo "  make curl         # Quick check local nginx route: /fto/"
	@echo "  make nginx-test   # Test nginx config"
	@echo "  make nginx-reload # Reload nginx"

run:
	python3 -m http.server $(PORT)

run-bg:
	@if [ -f .server.pid ] && kill -0 "$$(cat .server.pid)" 2>/dev/null; then \
		echo "[fto] server already running pid=$$(cat .server.pid)"; \
		exit 0; \
	fi
	@nohup python3 -m http.server $(PORT) > .server.log 2>&1 & echo $$! > .server.pid
	@echo "[fto] started pid=$$(cat .server.pid) port=$(PORT)"
	@echo "[fto] log: /app/fto/.server.log"

stop:
	@if [ ! -f .server.pid ]; then \
		echo "[fto] not running"; \
		exit 0; \
	fi
	@pid=$$(cat .server.pid); \
	if kill -0 "$$pid" 2>/dev/null; then \
		kill "$$pid"; \
		echo "[fto] stopped pid=$$pid"; \
	else \
		echo "[fto] stale pid $$pid"; \
	fi
	@rm -f .server.pid

status:
	@if [ -f .server.pid ] && kill -0 "$$(cat .server.pid)" 2>/dev/null; then \
		echo "[fto] running pid=$$(cat .server.pid)"; \
	else \
		echo "[fto] not running"; \
	fi

git-auto-start:
	bash scripts/start_auto_push.sh

git-auto-stop:
	bash scripts/stop_auto_push.sh

git-auto-status:
	bash scripts/status_auto_push.sh

git-auto-log:
	tail -n 100 -f .git/.auto-commit.log

curl:
	curl -sS -I http://127.0.0.1/fto/ | sed -n '1,20p'

nginx-test:
	nginx -t

nginx-reload:
	systemctl reload nginx
