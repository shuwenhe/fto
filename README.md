# fto

## 项目结构

- `frontend/` Next.js 前端（通过 `/fto` 访问）
- `backend/` Gin 后端（通过 `/fto/api` 访问）
- `model/recall/` 召回模型训练与 Ascend 流水线
- `model/reranker/` 重排模型训练与 Ascend 流水线
- `model/encoder/` 特征提取模型训练与 Ascend 流水线
- `model/judge/` 风险判断模型训练与 Ascend 流水线
- `scripts/` 自动提交/推送脚本

## Elasticsearch 召回接入

后端已支持将 Elasticsearch 作为候选召回层使用，后续仍复用本地语义、`neurx` reranker、encoder 和 judge 做排序与判定。

1. 导入专利到 Elasticsearch

```bash
cd /app/fto
make index-patents-es
```

2. 启动后端时启用 Elasticsearch

```bash
cd /app/fto/backend
ELASTICSEARCH_ENABLED=1 ELASTICSEARCH_URL=http://127.0.0.1:9200 ELASTICSEARCH_INDEX=fto_patents go run main.go
```

可选参数：

```bash
ELASTICSEARCH_CANDIDATE_MULTIPLIER=6
```

含义：Elasticsearch 先召回 `top_k * multiplier` 的候选专利，再交给本地模型链路重排。

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
make logs
```

只看单个服务日志：

```bash
cd /app/fto
make logs SERVICE=backend
make logs SERVICE=frontend
```

Git 自动提交日志：

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

## 使用 neurx 训练 FTO 排序模型

仓库已支持用 `neurx` 基于 `queries.jsonl + qrels.jsonl + patents.jsonl` 训练一个轻量排序器，并导出为后端可直接加载的 JSON 工件。

训练：

```bash
cd /app/fto
make train-fto-model
```

默认输出：

```text
/app/fto/model_artifacts/fto_ranker_neurx_v1.json
```

后端启动时会自动尝试加载该工件；若文件不存在，则回退到原先的启发式双路融合。也可以显式指定：

```bash
cd /app/fto/backend
RANKING_MODEL_PATH=/app/fto/model_artifacts/fto_ranker_neurx_v1.json go run main.go
```

## 训练召回模型（建议先做）

新增了基于 neurx 的可训练双路召回参数模型（标题/摘要/权利要求/关键词权重、融合权重、召回深度参数），用于先把 `Recall@K` 打稳。

训练：

```bash
cd /app/fto
make train-fto-recall-model
```

默认输出：

```text
/app/fto/model_artifacts/fto_recall_dual_v1.json
```

离线评测（使用训练后的召回模型）：

```bash
cd /app/fto
make eval-retrieval-model
```

## 训练特征提取模型（encoder）

新增 `model/encoder/` 目录，用于承载特征提取模型说明；训练侧新增了一个基于 `neurx` 的两层特征编码器，会把现有 reranker 手工特征压缩成低维 embedding，并在同一轮训练里学习相关性打分头。

Ascend 310P3 上训练：

```bash
cd /app/fto
make train-eval-fto-encoder
```

仅训练并导出 artifact：

```bash
cd /app/fto
make train-fto-encoder-model
```

默认输出：

```text
/app/fto/model_artifacts/fto_encoder_neurx_v1.json
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

## 生产模式自动编译与自动刷新

前端生产服务支持源码变更后自动执行构建，并在构建成功后自动重启前端服务。浏览器页面会轮询当前前端 build id，检测到新版本后自动刷新。

首次安装或更新 systemd 服务：

```bash
cd /app/fto
make service-install
make service-restart
```

查看 watcher 日志：

```bash
cd /app/fto
make logs SERVICE=watch
```

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

CI 可直接采集汇总文件：`docs/ops_gate_latest.json`。
