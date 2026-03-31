.PHONY: help frontend-install frontend-dev frontend-build frontend-start backend-deps backend-run backend-health backend-metrics alert-check trend-report load-test load-test-compare gray-rollout-guard rollback-now ci-gate ops-gate data-source-check sync-patent-data eval-retrieval compare-online-offline generate-report-sample train-fto-model import-patent curl nginx-test nginx-reload git-auto-start git-auto-stop git-auto-status git-auto-log logs service-install service-start service-stop service-restart service-status service-restart-backend service-restart-frontend

help:
	@echo "Available targets:"
	@echo "  make frontend-install # Install Next.js dependencies"
	@echo "  make frontend-dev     # Run Next.js dev server on :3010"
	@echo "  make frontend-build   # Build Next.js frontend"
	@echo "  make frontend-start   # Start Next.js production server on :3010"
	@echo "  make backend-deps     # Download Go dependencies"
	@echo "  make backend-run      # Run Gin backend on :8010"
	@echo "  make backend-health   # Check backend health via /fto/api/health"
	@echo "  make backend-metrics  # Show /fto/api/metrics"
	@echo "  make alert-check      # Run threshold-based ops alerts check"
	@echo "  make trend-report     # Generate trend summary from history"
	@echo "  make load-test        # Run load test and print P50/P95/P99"
	@echo "  make load-test-compare # Run load test and compare against last baseline"
	@echo "  make gray-rollout-guard # Progressive gray rollout with auto rollback checks"
	@echo "  make rollback-now     # Emergency rollback ranking mode"
	@echo "  make ci-gate          # Run eval + consistency + sample report gate"
	@echo "  make ops-gate         # Run ci-gate + trend-report (dual gate)"
	@echo "  make data-source-check # Check patent data source JSONL file"
	@echo "  make sync-patent-data # Sync patents.json and patents.jsonl"
	@echo "  make eval-retrieval   # Run offline retrieval metrics on queries/qrels"
	@echo "  make compare-online-offline # Compare backend top-k order with local ranker"
	@echo "  make generate-report-sample # Generate docs/report_sample_v1.json"
	@echo "  make train-fto-model  # Train neurx ranker and export model artifact"
	@echo "  make import-patent PATENT_ID=CN202410001A # Import from Google Patents"
	@echo "  make git-auto-start  # Start git auto commit/push daemon"
	@echo "  make git-auto-stop   # Stop git auto commit/push daemon"
	@echo "  make git-auto-status # Show git auto daemon status"
	@echo "  make git-auto-log    # Tail git auto daemon log"
	@echo "  make logs [SERVICE=all|backend|frontend|watch] # Tail systemd service logs"
	@echo "  make service-install # Install and enable systemd services"
	@echo "  make service-start   # Start systemd services"
	@echo "  make service-stop    # Stop systemd services"
	@echo "  make service-restart # Restart systemd services"
	@echo "  make service-status  # Show systemd services status"
	@echo "  make service-restart-backend # Restart backend only"
	@echo "  make service-restart-frontend # Restart frontend only"
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

logs:
	@if [ "$(SERVICE)" = "backend" ]; then \
		journalctl -u fto-backend -n 100 -f --no-pager; \
	elif [ "$(SERVICE)" = "frontend" ]; then \
		journalctl -u fto-frontend -n 100 -f --no-pager; \
	elif [ "$(SERVICE)" = "watch" ]; then \
		journalctl -u fto-frontend-watch -n 100 -f --no-pager; \
	elif [ -z "$(SERVICE)" ] || [ "$(SERVICE)" = "all" ]; then \
		journalctl -u fto-backend -u fto-frontend -u fto-frontend-watch -n 100 -f --no-pager; \
	else \
		echo "Usage: make logs [SERVICE=all|backend|frontend|watch]"; \
		exit 1; \
	fi

backend-run:
	cd backend && go run main.go

backend-health:
	curl -sS http://127.0.0.1/fto/api/health

backend-metrics:
	curl -sS http://127.0.0.1/fto/api/metrics

alert-check:
	node scripts/alert_check.mjs --base-url http://127.0.0.1/fto/api --load-report docs/load_test_report_v1.json --gray-report docs/gray_rollout_report_latest.json --max-load-error-rate 0.01 --max-load-p95-ms 5500 --max-gray-error-rate 0.01 --max-gray-p95-ms 5500 --max-live-post-tasks-p95-ms 200 --max-http-errors-total 0

trend-report:
	node scripts/trend_report.mjs --load-history docs/load_test_history.jsonl --gray-history docs/gray_rollout_history.jsonl --out-json docs/trend_summary_v1.json --out-md docs/trend_summary_v1.md --lookback 20

load-test:
	node scripts/load_test_tasks.mjs --base-url http://127.0.0.1/fto/api --concurrency 10 --duration-sec 60 --out docs/load_test_report_v1.json

load-test-compare:
	node scripts/load_test_baseline_compare.mjs --base-url http://127.0.0.1/fto/api --concurrency 10 --duration-sec 60 --out docs/load_test_report_v1.json --history-file docs/load_test_history.jsonl

gray-rollout-guard:
	node scripts/gray_rollout_guard.mjs --base-url http://127.0.0.1/fto/api --ratios 1,10,30,50,100 --concurrency 5 --duration-sec 20 --max-error-rate 0.01 --max-p95-ms 2000 --rollback-mode lexical --rollback-dual-ratio 0 --out docs/gray_rollout_report_latest.json --history-file docs/gray_rollout_history.jsonl

rollback-now:
	node scripts/emergency_rollback.mjs --base-url http://127.0.0.1/fto/api --mode lexical --dual-ratio 0

ci-gate:
	node scripts/ci_gate.mjs --k 5 --sample 5 --seed 20260331 --query-id q1 --base-url http://127.0.0.1/fto/api --report-out docs/report_sample_v1.json

ops-gate:
	node scripts/ops_gate.mjs --out docs/ops_gate_latest.json --base-url http://127.0.0.1/fto/api --k 5 --sample 5 --seed 20260331 --query-id q1 --report-out docs/report_sample_v1.json --trend-out-json docs/trend_summary_v1.json --trend-out-md docs/trend_summary_v1.md --lookback 20

data-source-check:
	@test -f /app/fto/data_sources/patents.jsonl && echo "[ok] /app/fto/data_sources/patents.jsonl"
	@test -f /app/fto/data_sources/patents.json && echo "[ok] /app/fto/data_sources/patents.json"

sync-patent-data:
	node scripts/sync_patent_data.mjs

eval-retrieval:
	node scripts/eval_retrieval.mjs --k 5 --verbose

compare-online-offline:
	node scripts/compare_online_offline.mjs --k 5 --sample 5 --verbose

generate-report-sample:
	node scripts/generate_report_sample.mjs --k 5 --query-id q1 --sample 5 --seed 20260331 --base-url http://127.0.0.1/fto/api --out docs/report_sample_v1.json

train-fto-model:
	python scripts/train_fto_model_neurx.py --out model_artifacts/fto_ranker_neurx_v1.json

import-patent:
	@test -n "$(PATENT_ID)" || (echo "Usage: make import-patent PATENT_ID=CN202410001A" && exit 1)
	node scripts/save_google_patent.mjs $(PATENT_ID)

curl:
	curl -sS -I http://127.0.0.1/fto/ | sed -n '1,20p'

nginx-test:
	nginx -t

nginx-reload:
	systemctl reload nginx

service-install:
	bash scripts/install_systemd_services.sh

service-start:
	@units="fto-backend fto-frontend"; \
	if systemctl cat fto-frontend-watch >/dev/null 2>&1; then \
		units="$$units fto-frontend-watch"; \
	else \
		echo "[warn] fto-frontend-watch not installed, run 'make service-install' to enable auto build/reload"; \
	fi; \
	systemctl start $$units

service-stop:
	@units="fto-backend fto-frontend"; \
	if systemctl cat fto-frontend-watch >/dev/null 2>&1; then \
		units="fto-frontend-watch $$units"; \
	fi; \
	systemctl stop $$units

service-restart:
	@units="fto-backend fto-frontend"; \
	if systemctl cat fto-frontend-watch >/dev/null 2>&1; then \
		units="$$units fto-frontend-watch"; \
	else \
		echo "[warn] fto-frontend-watch not installed, run 'make service-install' to enable auto build/reload"; \
	fi; \
	systemctl restart $$units

service-status:
	@units="fto-backend fto-frontend"; \
	if systemctl cat fto-frontend-watch >/dev/null 2>&1; then \
		units="$$units fto-frontend-watch"; \
	fi; \
	systemctl --no-pager --full status $$units

service-restart-backend:
	systemctl restart fto-backend

service-restart-frontend:
	systemctl restart fto-frontend
