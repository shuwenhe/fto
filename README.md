# fto

## 项目结构

- `frontend/` Next.js 前端（通过 `/fto` 访问）
- `backend/` Gin 后端（通过 `/fto/api` 访问）
- `scripts/` 自动提交/推送脚本

## 最小联调启动

1. 安装前端依赖

```bash
cd /app/fto
make frontend-install
```

2. 安装后端依赖

```bash
cd /app/fto
make backend-deps
```

3. 启动前后端（两个终端）

```bash
cd /app/fto
make frontend-dev
```

```bash
cd /app/fto
make backend-run
```

4. 另一个终端检查联通

```bash
cd /app/fto
make nginx-test
make nginx-reload
make backend-health
```

5. 浏览器访问

```text
http://111.202.231.146:8080/fto
```

## 代码更新自动提交到 GitHub

已提供自动化脚本：检测代码变更后自动提交，并自动推送到远端分支。

1. 启动自动提交/推送

```bash
cd /app/fto
make git-auto-start
```

2. 查看状态

```bash
cd /app/fto
make git-auto-status
```

3. 查看日志

```bash
cd /app/fto
make git-auto-log
```

4. 停止

```bash
cd /app/fto
make git-auto-stop
```

可选环境变量（启动前设置）：

```bash
export AUTO_COMMIT_INTERVAL_SEC=5
export AUTO_COMMIT_PUSH=1
export AUTO_COMMIT_PUSH_REMOTE=origin
export AUTO_COMMIT_PUSH_BRANCH=main
export AUTO_COMMIT_PREFIX="chore(auto)"
```

如果日志提示缺少 git 身份，请先设置：

```bash
git config user.name "Your Name"
git config user.email "you@example.com"
```

## 召回一致性回归检查

用于随机抽样 query，对比线上接口与本地双路召回排序 top-k 是否完全一致。

```bash
cd /app/fto
make compare-online-offline
```

也可直接执行并自定义参数：

```bash
cd /app/fto
node scripts/compare_online_offline.mjs --k 5 --sample 10 --seed 20260331 --base-url http://127.0.0.1/fto/api --verbose
```

## 验收与基线文档

- 第 2 条验收清单（指标门槛 + 稳定性定义）：`docs/acceptance_checklist_v1.md`
- 基线冻结（数据快照、参数、命令）：`docs/baseline_v1.md`
- 第 3 条报告 schema：`docs/report_schema_v1.json`
- 第 3 条样例报告：`docs/report_sample_v1.json`

## 样例报告自动生成

一键生成第 3 条样例报告（自动执行：离线评测 + 一致性检查 + 指定 query 在线任务结果采集）：

```bash
cd /app/fto
make generate-report-sample
```

自定义参数示例：

```bash
cd /app/fto
node scripts/generate_report_sample.mjs --k 5 --query-id q1 --sample 5 --seed 20260331 --base-url http://127.0.0.1/fto/api --out docs/report_sample_v1.json
```

## 工程化（日志 + 监控 + 灰度）

后端新增能力：

- 结构化日志（含 request_id）
- 指标端点：`/fto/api/metrics`
- 灰度开关（dual / lexical / gray）

启动示例：

```bash
cd /app/fto/backend
REDIS_PASSWORD=123456 RANKING_MODE=gray RANKING_DUAL_RATIO=50 go run main.go
```

查看指标：

```bash
cd /app/fto
make backend-metrics
```

告警阈值检查：

```bash
cd /app/fto
make alert-check
```

趋势报告生成：

```bash
cd /app/fto
make trend-report
```

可执行清单见：`docs/engineering_checklist_v1.md`

运行手册见：`docs/runbook_v1.md`

## 压测（Load Test）

运行默认压测（并发 10、60 秒），输出 P50/P95/P99 并保存报告：

```bash
cd /app/fto
make load-test
```

自定义参数示例：

```bash
cd /app/fto
node scripts/load_test_tasks.mjs --base-url http://127.0.0.1/fto/api --concurrency 20 --duration-sec 120 --max-error-rate 0.01 --max-p95-ms 2000 --out docs/load_test_report_v1.json
```

压测基线对比（当前 vs 上次）：

```bash
cd /app/fto
make load-test-compare
```

该命令会写入：

- 当前报告：`docs/load_test_report_v1.json`
- 历史序列：`docs/load_test_history.jsonl`

## 灰度放量与自动回滚

按比例逐步放量并做阈值检查，超阈值自动回滚：

```bash
cd /app/fto
make gray-rollout-guard
```

默认放量比例：`1,10,30,50,100`。
默认阈值：`error_rate <= 1%` 且 `p95 <= 2000ms`。
若超阈值，自动回滚为 `lexical`。

每档结果会自动落盘并做历史对比：

- 本次汇总：`docs/gray_rollout_report_latest.json`
- 分档历史：`docs/gray_rollout_history.jsonl`

## 一键回滚（手工应急）

```bash
cd /app/fto
make rollback-now
```

默认回滚到：`mode=lexical`、`dual_ratio=0`。

## CI 门禁

单命令串行执行门禁：离线评测 + 一致性检查 + 样例报告生成 + alert-check。

```bash
cd /app/fto
make ci-gate
```

说明：`ci-gate` 会在执行前尝试把后端排序切到 `dual/100`，执行后恢复原灰度配置，避免被当前灰度流量状态干扰。

## 双闸门禁（质量 + 运维）

`ops-gate` = `ci-gate` + `trend-report`，用于产出完整门禁结果与趋势快照。

```bash
cd /app/fto
make ops-gate
```