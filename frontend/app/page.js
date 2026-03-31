'use client';

import { useEffect, useRef, useState } from 'react';

export default function HomePage() {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState(null);
  const [taskId, setTaskId] = useState('-');
  const [rows, setRows] = useState([]);
  const buildIdRef = useRef('');

  useEffect(() => {
    let cancelled = false;

    async function checkBuildId() {
      try {
        const res = await fetch(`/fto/api/frontend-build-id?ts=${Date.now()}`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          return;
        }
        const data = await res.json();
        const nextBuildId = String(data.build_id || '');
        if (!nextBuildId || cancelled) {
          return;
        }
        if (!buildIdRef.current) {
          buildIdRef.current = nextBuildId;
          return;
        }
        if (buildIdRef.current !== nextBuildId) {
          window.location.reload();
        }
      } catch {
        // Ignore transient polling failures during restart.
      }
    }

    checkBuildId();
    const timer = setInterval(checkBuildId, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  async function pollTask(id) {
    for (;;) {
      const res = await fetch(`/fto/api/tasks/${id}`);
      if (!res.ok) {
        setStatus('failed');
        return;
      }
      const data = await res.json();
      setStatus(data.status);
      setProgress(typeof data.progress === 'number' ? data.progress : null);
      setRows(data.result || []);
      if (data.status === 'succeeded' || data.status === 'failed') {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async function submitTask() {
    if (!query.trim()) {
      alert('请先输入技术方案描述');
      return;
    }
    setStatus('submitting');
    setProgress(0);
    setRows([]);

    const res = await fetch('/fto/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query.trim() }),
    });

    if (!res.ok) {
      setStatus('failed');
      return;
    }
    const data = await res.json();
    setTaskId(data.task_id);
    setStatus(data.status);
    setProgress(typeof data.progress === 'number' ? data.progress : 0);
    await pollTask(data.task_id);
  }

  return (
    <main className="page">
      <section className="card">
        <h1>FTO 专利防侵权</h1>
        <textarea
          placeholder="输入技术方案描述，例如：一种无线充电散热结构..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="row">
          <button onClick={submitTask}>提交分析任务</button>
          <span className="tag">
            状态：{status}
            {progress !== null ? ` ${progress}%` : ''}
          </span>
        </div>

        <div className="row">
          <strong>Task ID:</strong>
          <span>{taskId}</span>
        </div>
      </section>

      <section className="card">
        <h2>候选专利风险结果</h2>
        <table>
          <thead>
            <tr>
              <th>专利号</th>
              <th>标题</th>
              <th>风险</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4}>暂无结果</td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.patent_id}>
                  <td>
                    <a
                      href={r.patent_url || `https://patents.google.com/patent/${r.patent_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {r.patent_id}
                    </a>
                  </td>
                  <td>{r.title}</td>
                  <td>{r.risk_level}</td>
                  <td>{r.reason}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
