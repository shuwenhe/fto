from __future__ import annotations

import threading
import time
import uuid
from datetime import datetime
from typing import Dict, List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


class TaskCreateRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)


class TaskResultItem(BaseModel):
    patent_id: str
    title: str
    risk_level: str
    reason: str


class TaskState(BaseModel):
    task_id: str
    query: str
    status: str
    progress: int
    created_at: str
    updated_at: str
    result: List[TaskResultItem] = []


app = FastAPI(title="FTO Backend", version="0.1.0")
_tasks: Dict[str, TaskState] = {}
_lock = threading.Lock()


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _simulate_task(task_id: str) -> None:
    steps = [20, 45, 70, 100]
    for p in steps:
        time.sleep(1.2)
        with _lock:
            task = _tasks.get(task_id)
            if not task:
                return
            task.progress = p
            task.updated_at = _now()
            if p < 100:
                task.status = "running"
            else:
                task.status = "succeeded"
                task.result = [
                    TaskResultItem(
                        patent_id="CN202410001A",
                        title="一种用于无线充电的温控结构",
                        risk_level="medium",
                        reason="核心结构相似，建议调整散热层叠设计。",
                    ),
                    TaskResultItem(
                        patent_id="US20240123456A1",
                        title="Wireless charging coil arrangement",
                        risk_level="low",
                        reason="技术路线相近但关键参数不同，侵权风险较低。",
                    ),
                ]


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "fto-backend"}


@app.post("/tasks")
def create_task(payload: TaskCreateRequest) -> dict:
    task_id = str(uuid.uuid4())
    now = _now()
    task = TaskState(
        task_id=task_id,
        query=payload.query,
        status="queued",
        progress=0,
        created_at=now,
        updated_at=now,
    )
    with _lock:
        _tasks[task_id] = task

    t = threading.Thread(target=_simulate_task, args=(task_id,), daemon=True)
    t.start()

    return {"task_id": task_id, "status": task.status}


@app.get("/tasks/{task_id}")
def get_task(task_id: str) -> dict:
    with _lock:
        task = _tasks.get(task_id)
        if not task:
            raise HTTPException(status_code=404, detail="task not found")
        return task.model_dump()


@app.get("/tasks/{task_id}/result")
def get_result(task_id: str) -> dict:
    with _lock:
        task = _tasks.get(task_id)
        if not task:
            raise HTTPException(status_code=404, detail="task not found")
        if task.status != "succeeded":
            return {"task_id": task_id, "status": task.status, "result": []}
        return {"task_id": task_id, "status": task.status, "result": [r.model_dump() for r in task.result]}
