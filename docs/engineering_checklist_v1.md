# 工程化执行清单 v1（监控、日志、压测、灰度）

版本日期：2026-03-31
范围：第 8 条第一阶段（最小可用闭环）

## A. 结构化日志

状态：已落地（基础版）

- [x] 接入 request_id（响应头 `X-Request-ID`）
- [x] 接入 HTTP access JSON 日志（method/path/status/latency/client_ip）
- [x] 任务关键事件日志（task_created/task_queried/task_result_queried/task_*_failed）

验收命令：

```bash
cd /app/fto/backend
REDIS_PASSWORD=123456 RANKING_MODE=gray RANKING_DUAL_RATIO=50 go run main.go
```

在日志中检查是否出现 JSON 行并包含 `request_id`、`event`、`path`。

## B. 监控指标

状态：已落地（基础版）

- [x] 暴露 `/fto/api/metrics`（Prometheus text）
- [x] 指标：
  - `fto_http_requests_total`
  - `fto_http_errors_total`
  - `fto_task_create_total`
  - `fto_task_query_total`
  - `fto_http_requests_by_status{method,path,status}`
  - `fto_http_latency_ms_avg{method,path}`
  - `fto_http_latency_ms_p95{method,path}`（桶近似）

验收命令：

```bash
cd /app/fto
make backend-health
make backend-metrics
```

## C. 灰度开关

状态：已落地（基础版）

- [x] `RANKING_MODE=dual|lexical|gray`
- [x] `RANKING_DUAL_RATIO=0..100`（仅在 `gray` 下生效）
- [x] 按 query 哈希稳定分流（同 query 命中同策略）

建议验收：

```bash
cd /app/fto/backend
REDIS_PASSWORD=123456 RANKING_MODE=dual go run main.go
# 新开终端请求同一 query，记录结果

cd /app/fto/backend
REDIS_PASSWORD=123456 RANKING_MODE=lexical go run main.go
# 对比 reason 文案和排序差异
```

## D. 压测（下一步马上做）

状态：已落地（基础版）

- [x] 增加压测脚本：`scripts/load_test_tasks.mjs`
- [x] 固定场景：并发 10、持续 60 秒、固定 query 集
- [x] 输出：总请求、成功率、P50/P95/P99、错误分布
- [x] 阈值检查参数：`--max-error-rate`、`--max-p95-ms`

验收命令：

```bash
cd /app/fto
make load-test
```

## E. 灰度放量策略（下一步）

状态：已落地（基础版）

- [x] 增加运行时配置 API：`GET/POST /ops/ranking-config`
- [x] 放量顺序自动化：1% -> 10% -> 30% -> 50% -> 100%
- [x] 阈值检查：错误率与 P95
- [x] 自动回滚：超阈值切回 `lexical`

验收命令：

```bash
cd /app/fto
make gray-rollout-guard
```

## F. 门禁流水线（下一步）

状态：已落地（基础版）

- [x] 单命令门禁：`make ci-gate`
- [x] 依次执行：eval -> consistency -> report sample
- [x] 任一失败即返回非 0
- [x] 门禁前自动切换 `dual/100`，结束后恢复原配置
