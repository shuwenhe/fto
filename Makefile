.PHONY: help frontend-install frontend-dev frontend-build frontend-start backend-deps backend-run backend-health backend-metrics alert-check trend-report load-test load-test-compare gray-rollout-guard rollback-now ci-gate ops-gate data-source-check sync-patent-data export-patents-parquet patent-incremental-sync patent-process-pending-embeddings index-patents-es index-patents-es-from-parquet index-patent-embeddings-milvus search-stack-up search-stack-down search-stack-logs eval-retrieval eval-query-rewrite-ab analyze-query-rewrite-rules auto-prune-query-rewrite-rules auto-prune-query-rewrite-status eval-ab-reranker eval-reranker-model eval-judge-model check-qrels-distribution generate-qrels-label-tasks merge-qrels-batch merge-and-check-qrels compare-online-offline generate-report-sample train-fto-model train-fto-reranker-model train-fto-recall-model train-fto-judge-model train-fto-encoder-model train-eval-fto-recall train-eval-fto-reranker train-eval-fto-judge train-eval-fto-encoder tune-fto-4-models-grid-8x310p3 eval-retrieval-model import-patent curl nginx-test nginx-reload git-auto-start git-auto-stop git-auto-status git-auto-log git-auto-service-install git-auto-pull-service-install logs service-install service-start service-stop service-restart service-status service-restart-backend service-restart-frontend

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
	@echo "  make export-patents-parquet # Convert patents.jsonl into partitioned Parquet dataset"
	@echo "  make patent-incremental-sync UPDATES_JSONL=... [LEGAL_STATUS_JSONL=...] # Daily patent delta sync"
	@echo "  make patent-process-pending-embeddings # Async backfill queued embedding batches into Milvus"
	@echo "  make index-patents-es # Create/update Elasticsearch patent index"
	@echo "  make index-patents-es-from-parquet # Build Elasticsearch index from Parquet dataset"
	@echo "  make index-patent-embeddings-milvus # Generate embeddings from Parquet and upsert to Milvus"
	@echo "  make search-stack-up # Start local Elasticsearch + Milvus search stack"
	@echo "  make search-stack-down # Stop local Elasticsearch + Milvus search stack"
	@echo "  make search-stack-logs # Tail local Elasticsearch + Milvus search stack logs"
	@echo "  make eval-retrieval   # Run offline retrieval metrics on queries/qrels"
	@echo "  make eval-query-rewrite-ab # Compare base vs rewrite query retrieval metrics"
	@echo "  make analyze-query-rewrite-rules # Analyze per-term contribution and output pruned rules"
	@echo "  make auto-prune-query-rewrite-rules # Run auto prune once now"
	@echo "  make auto-prune-query-rewrite-status # Show timer/path/service status"
	@echo "  make eval-ab-reranker # Compare linear vs linear+deep(top-N) offline"
	@echo "  make compare-online-offline # Compare backend top-k order with local ranker"
	@echo "  make generate-report-sample # Generate docs/report_sample_v1.json"
	@echo "  make train-fto-model  # Alias: train neurx reranker and export model artifact"
	@echo "  make train-fto-reranker-model # Train neurx reranker from recall candidates"
	@echo "  make train-fto-recall-model # Train neurx dual-recall model artifact"
	@echo "  make train-fto-judge-model # Train neurx judge classifier from recall+reranker features"
	@echo "  make train-fto-encoder-model # Train neurx feature encoder artifact"
	@echo "  make train-eval-fto-recall # One-command reproducible env+train+eval+logs"
	@echo "  make train-eval-fto-reranker # One-command reproducible env+train+eval+logs"
	@echo "  make train-eval-fto-judge # One-command reproducible env+train+eval+logs"
	@echo "  make train-eval-fto-encoder # One-command Ascend 310P3 encoder training"
	@echo "  make tune-fto-4-models-grid-8x310p3 # Joint 4-model grid tuning on 8x Ascend 310P3"
	@echo "  make eval-retrieval-model # Eval retrieval with trained recall model"
	@echo "  make eval-reranker-model # Eval reranker on recall candidates"
	@echo "  make eval-judge-model # Eval judge classifier with trained artifact"
	@echo "  make check-qrels-distribution # Check qrels class/query balance for judge labeling"
	@echo "  make generate-qrels-label-tasks # Generate markdown task list and today's qrels batch template"
	@echo "  make merge-qrels-batch BATCH=... # Safely merge a labeled qrels batch into qrels.jsonl"
	@echo "  make merge-and-check-qrels BATCH=... # Merge labeled qrels batch and immediately run distribution checks"
	@echo "  make import-patent PATENT_ID=CN202410001A # Import from Google Patents"
	@echo "  make git-auto-start  # Start git auto commit/push daemon"
	@echo "  make git-auto-stop   # Stop git auto commit/push daemon"
	@echo "  make git-auto-status # Show git auto daemon status"
	@echo "  make git-auto-log    # Tail git auto daemon log"
	@echo "  make git-auto-service-install # Install systemd service for auto commit/push"
	@echo "  make git-auto-pull-service-install # Install systemd service for auto pull"
	@echo "  make logs [SERVICE=all|backend|frontend|watch|git|pull] # Tail systemd service logs"
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

git-auto-service-install:
	bash scripts/install_auto_commit_service.sh

git-auto-pull-service-install:
	bash scripts/install_auto_pull_service.sh

logs:
	@if [ "$(SERVICE)" = "backend" ]; then \
		journalctl -u fto-backend -n 100 -f --no-pager; \
	elif [ "$(SERVICE)" = "frontend" ]; then \
		journalctl -u fto-frontend -n 100 -f --no-pager; \
	elif [ "$(SERVICE)" = "watch" ]; then \
		journalctl -u fto-frontend-watch -n 100 -f --no-pager; \
	elif [ "$(SERVICE)" = "git" ]; then \
		journalctl -u fto-auto-commit -n 100 -f --no-pager; \
	elif [ "$(SERVICE)" = "pull" ]; then \
		journalctl --user -u fto-auto-pull -n 100 -f --no-pager; \
	elif [ -z "$(SERVICE)" ] || [ "$(SERVICE)" = "all" ]; then \
		journalctl -u fto-backend -u fto-frontend -u fto-frontend-watch -u fto-auto-commit -n 100 -f --no-pager; \
		journalctl --user -u fto-auto-pull -n 100 -f --no-pager; \
	else \
		echo "Usage: make logs [SERVICE=all|backend|frontend|watch|git|pull]"; \
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

export-patents-parquet:
	python3 scripts/export_patents_parquet.py --overwrite

patent-incremental-sync:
	@test -n "$(UPDATES_JSONL)$(LEGAL_STATUS_JSONL)" || (echo "Usage: make patent-incremental-sync UPDATES_JSONL=/path/to/new_patents.jsonl [LEGAL_STATUS_JSONL=/path/to/legal_status_updates.jsonl]" && exit 1)
	python3 scripts/run_patent_incremental_pipeline.py \
		$(if $(UPDATES_JSONL),--updates-jsonl $(UPDATES_JSONL),) \
		$(if $(LEGAL_STATUS_JSONL),--legal-status-jsonl $(LEGAL_STATUS_JSONL),) \
		--export-delta-parquet \
		--run-es-upsert \
		--queue-embedding

patent-process-pending-embeddings:
	python3 scripts/process_pending_embedding_updates.py

index-patents-es:
	node scripts/index_patents_elasticsearch.mjs

index-patents-es-from-parquet:
	python3 scripts/index_patents_es_from_parquet.py --recreate

index-patent-embeddings-milvus:
	python3 scripts/index_patent_embeddings_milvus.py

search-stack-up:
	docker compose -f deploy/docker-compose.search.yml up -d

search-stack-down:
	docker compose -f deploy/docker-compose.search.yml down

search-stack-logs:
	docker compose -f deploy/docker-compose.search.yml logs -f --tail=100

eval-retrieval:
	node scripts/eval_retrieval.mjs --k 5 --verbose

eval-query-rewrite-ab:
	node scripts/eval_query_rewrite_ab.mjs --k 5 --model model_artifacts/fto_recall_dual_v1.json --rules backend/config/query_rewrite_rules.json --out-json docs/query_rewrite_ab_report_v1.json --out-md docs/query_rewrite_ab_report_v1.md --verbose

analyze-query-rewrite-rules:
	node scripts/analyze_query_rewrite_rule_contrib.mjs --k 5 --model model_artifacts/fto_recall_dual_v1.json --rules backend/config/query_rewrite_rules.json --out-json docs/query_rewrite_rule_contrib_v1.json --out-md docs/query_rewrite_rule_contrib_v1.md --min-ndcg-contribution 0 --min-hit-queries 2 --write-pruned-rules backend/config/query_rewrite_rules.pruned.json --verbose

auto-prune-query-rewrite-rules:
	bash scripts/query_rewrite_auto_prune.sh

auto-prune-query-rewrite-status:
	@systemctl status fto-query-rewrite-prune.timer --no-pager -n 20 || true
	@systemctl status fto-query-rewrite-prune.path --no-pager -n 20 || true
	@systemctl status fto-query-rewrite-prune.service --no-pager -n 20 || true

eval-ab-reranker:
	node scripts/eval_ab_reranker.mjs --k 5 --deep-top-n 8 --deep-mix-alpha 0.35 --verbose

check-qrels-distribution:
	python3 scripts/check_qrels_distribution.py

generate-qrels-label-tasks:
	python3 scripts/generate_qrels_label_tasks.py --only-incomplete

merge-qrels-batch:
	@test -n "$(BATCH)" || (echo "Usage: make merge-qrels-batch BATCH=data_sources/qrels_batch_YYYYMMDD.jsonl" && exit 1)
	python3 scripts/merge_qrels_batch.py --batch-qrels "$(BATCH)"

merge-and-check-qrels:
	@test -n "$(BATCH)" || (echo "Usage: make merge-and-check-qrels BATCH=data_sources/qrels_batch_YYYYMMDD.jsonl" && exit 1)
	python3 scripts/merge_and_check_qrels.py --batch-qrels "$(BATCH)"

compare-online-offline:
	node scripts/compare_online_offline.mjs --k 5 --sample 5 --verbose

generate-report-sample:
	node scripts/generate_report_sample.mjs --k 5 --query-id q1 --sample 5 --seed 20260331 --base-url http://127.0.0.1/fto/api --out docs/report_sample_v1.json

train-fto-model:
	python model/reranker/train_fto_model_neurx.py --out model_artifacts/fto_reranker_neurx_v1.json

train-fto-reranker-model:
	python model/reranker/train_fto_model_neurx.py --out model_artifacts/fto_reranker_neurx_v1.json

train-fto-recall-model:
	python model/recall/train_fto_recall_model.py --out model_artifacts/fto_recall_dual_v1.json

train-fto-judge-model:
	python model/judge/train_fto_judge_model_neurx.py --recall-model model_artifacts/fto_recall_dual_v1.json --reranker-model model_artifacts/fto_reranker_neurx_v1.json --out model_artifacts/fto_judge_neurx_v1.json

train-fto-encoder-model:
	python model/encoder/train_fto_encoder_neurx.py --recall-model model_artifacts/fto_recall_dual_v1.json --out model_artifacts/fto_encoder_neurx_v1.json

train-eval-fto-recall:
	bash model/recall/run_fto_recall_pipeline.sh

train-eval-fto-reranker:
	bash model/reranker/run_fto_reranker_pipeline.sh

train-eval-fto-judge:
	bash model/judge/run_fto_judge_pipeline.sh

train-eval-fto-encoder:
	bash model/encoder/run_fto_encoder_pipeline.sh

tune-fto-4-models-grid-8x310p3:
	bash model/run_fto_joint_tuning_8x310p3.sh

eval-retrieval-model:
	node scripts/eval_retrieval.mjs --k 5 --model model_artifacts/fto_recall_dual_v1.json --verbose

eval-reranker-model:
	node scripts/eval_reranker_model.mjs --k 5 --candidate-k 24 --recall-model model_artifacts/fto_recall_dual_v1.json --model model_artifacts/fto_reranker_neurx_v1.json --verbose

eval-judge-model:
	python scripts/eval_judge_model.py --candidate-k 24 --recall-model model_artifacts/fto_recall_dual_v1.json --reranker-model model_artifacts/fto_reranker_neurx_v1.json --model model_artifacts/fto_judge_neurx_v1.json --verbose

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
	if systemctl cat fto-auto-commit >/dev/null 2>&1; then \
		units="$$units fto-auto-commit"; \
	else \
		echo "[warn] fto-auto-commit not installed, run 'make service-install' to enable auto commit/push"; \
	fi; \
	systemctl start $$units

service-stop:
	@units="fto-backend fto-frontend"; \
	if systemctl cat fto-frontend-watch >/dev/null 2>&1; then \
		units="fto-frontend-watch $$units"; \
	fi; \
	if systemctl cat fto-auto-commit >/dev/null 2>&1; then \
		units="fto-auto-commit $$units"; \
	fi; \
	systemctl stop $$units

service-restart:
	@units="fto-backend fto-frontend"; \
	if systemctl cat fto-frontend-watch >/dev/null 2>&1; then \
		units="$$units fto-frontend-watch"; \
	else \
		echo "[warn] fto-frontend-watch not installed, run 'make service-install' to enable auto build/reload"; \
	fi; \
	if systemctl cat fto-auto-commit >/dev/null 2>&1; then \
		units="$$units fto-auto-commit"; \
	else \
		echo "[warn] fto-auto-commit not installed, run 'make service-install' to enable auto commit/push"; \
	fi; \
	systemctl restart $$units

service-status:
	@units="fto-backend fto-frontend"; \
	if systemctl cat fto-frontend-watch >/dev/null 2>&1; then \
		units="$$units fto-frontend-watch"; \
	fi; \
	if systemctl cat fto-auto-commit >/dev/null 2>&1; then \
		units="$$units fto-auto-commit"; \
	fi; \
	systemctl --no-pager --full status $$units

service-restart-backend:
	systemctl restart fto-backend

service-restart-frontend:
	systemctl restart fto-frontend
