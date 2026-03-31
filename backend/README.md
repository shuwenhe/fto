# FTO Backend (FastAPI)

## Run

```bash
cd /app/fto/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8010 --reload
```

## API

- `GET /health`
- `POST /tasks` body: `{ "query": "..." }`
- `GET /tasks/{task_id}`
- `GET /tasks/{task_id}/result`
