# FTO Backend (Gin)

## 架构

- `internal/router` 路由层：处理 HTTP 请求与响应
- `internal/service` 服务层：业务编排与任务流程
- `internal/repository` 存储层：Redis 读写实现
- `internal/model` 数据模型

当前任务状态已从内存 map 切换到 Redis 存储。
并且已接入本地专利数据源（JSONL）用于检索。

## Run

```bash
cd /app/fto/backend
go mod tidy
go run main.go
```

可选环境变量：

```bash
export REDIS_ADDR=127.0.0.1:6379
export REDIS_PASSWORD=""
export PATENT_DATA_PATH=/app/fto/data_sources/patents.jsonl
```

## API

- `GET /health`
- `POST /tasks` body: `{ "query": "..." }`
- `GET /tasks/{task_id}`
- `GET /tasks/{task_id}/result`
