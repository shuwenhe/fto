# FTO Backend (Gin)

## Run

```bash
cd /app/fto/backend
go mod tidy
go run main.go
```

## API

- `GET /health`
- `POST /tasks` body: `{ "query": "..." }`
- `GET /tasks/{task_id}`
- `GET /tasks/{task_id}/result`
