# FTO Ops Runbook v1

版本日期：2026-03-31
适用范围：FTO 检索服务（日志、监控、压测、灰度、回滚）

## 1. 日常巡检

1. 检查服务健康

```bash
cd /app/fto
make backend-health
```

2. 检查实时指标

```bash
cd /app/fto
make backend-metrics
```

3. 执行告警阈值检查

```bash
cd /app/fto
make alert-check
```

4. 生成趋势报告

```bash
cd /app/fto
make trend-report
```

## 2. 发布前检查

1. 跑门禁

```bash
cd /app/fto
make ci-gate
```

2. 跑压测对比

```bash
cd /app/fto
make load-test-compare
```

3. 确认告警脚本通过

```bash
cd /app/fto
make alert-check
```

## 3. 灰度发布步骤

1. 先确认当前配置

```bash
curl -sS http://127.0.0.1/fto/api/ops/ranking-config
```

2. 执行自动灰度放量

```bash
cd /app/fto
make gray-rollout-guard
```

3. 查看灰度报告与历史

- `docs/gray_rollout_report_latest.json`
- `docs/gray_rollout_history.jsonl`

## 4. 故障应急回滚

1. 一键回滚（默认 lexical/0）

```bash
cd /app/fto
make rollback-now
```

2. 手工指定回滚目标

```bash
cd /app/fto
node scripts/emergency_rollback.mjs --base-url http://127.0.0.1/fto/api --mode lexical --dual-ratio 0
```

3. 回滚后验证

```bash
curl -sS http://127.0.0.1/fto/api/ops/ranking-config
cd /app/fto
make backend-health
make alert-check
```

## 5. 阈值建议（首版）

- Load error rate <= 1%
- Load P95 <= 5500ms
- Gray step error rate <= 1%
- Gray step P95 <= 5500ms
- Live POST /tasks P95 <= 200ms
- HTTP 5xx total <= 0（短周期窗口内）

## 6. 常见问题

1. 后端启动失败：`listen tcp :8010: bind: address already in use`
- 说明端口被占用，先停掉旧进程再启动。

2. `ci-gate` 在 gray 模式失败
- `ci-gate` 会自动切到 dual/100 再检查，结束后恢复。若仍失败，优先排查数据是否变更。

3. 告警脚本失败
- 先看 `docs/load_test_report_v1.json` 与 `docs/gray_rollout_report_latest.json` 是否过旧或缺失，再重跑：
  - `make load-test-compare`
  - `make gray-rollout-guard`
