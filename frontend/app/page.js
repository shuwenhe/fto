'use client';

import { useEffect, useRef, useState } from 'react';

const navItems = [
  { label: '首页', href: 'http://111.202.231.146:8080/fto' },
  { label: '健康检查', href: 'http://111.202.231.146:8080/fto/api/health' },
  { label: '运行指标', href: 'http://111.202.231.146:8080/fto/api/metrics' },
  { label: '排序配置', href: 'http://111.202.231.146:8080/fto/api/ops/ranking-config' },
  { label: '排序模型', href: 'http://111.202.231.146:8080/fto/api/ops/ranking-model' },
];

export default function HomePage() {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState(null);
  const [taskId, setTaskId] = useState('-');
  const [rows, setRows] = useState([]);
  const [esMeta, setEsMeta] = useState({
    loaded: false,
    enabled: false,
    index: '-',
    candidateCount: null,
    error: '',
  });
  const [encoderStatus, setEncoderStatus] = useState('idle');
  const [encoderMeta, setEncoderMeta] = useState(null);
  const [encoderRows, setEncoderRows] = useState([]);
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

  async function refreshEsMeta(queryText = '') {
    try {
      const modelRes = await fetch('/fto/api/ops/ranking-model', { cache: 'no-store' });
      const modelData = await modelRes.json();
      if (!modelRes.ok) {
        setEsMeta((prev) => ({ ...prev, loaded: true, error: modelData.error || 'failed' }));
        return;
      }

      const next = {
        loaded: true,
        enabled: Boolean(modelData.elasticsearch_enabled),
        index: modelData.elasticsearch_index || '-',
        candidateCount: null,
        error: '',
      };

      if (queryText.trim()) {
        const explainRes = await fetch('/fto/api/ops/ranking-explain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: queryText.trim(), limit: 5 }),
        });
        const explainData = await explainRes.json();
        if (explainRes.ok) {
          next.candidateCount =
            typeof explainData.candidate_count === 'number' ? explainData.candidate_count : null;
        }
      }

      setEsMeta(next);
    } catch {
      setEsMeta((prev) => ({ ...prev, loaded: true, error: 'failed' }));
    }
  }

  useEffect(() => {
    refreshEsMeta('');
  }, []);

  async function submitTask() {
    if (!query.trim()) {
      alert('请先输入技术方案描述');
      return;
    }
    setStatus('submitting');
    setProgress(0);
    setRows([]);
    refreshEsMeta(query);

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

  async function testEncoder() {
    if (!query.trim()) {
      alert('请先输入技术方案描述');
      return;
    }
    setEncoderStatus('loading');
    setEncoderRows([]);
    setEncoderMeta(null);

    try {
      const res = await fetch('/fto/api/ops/encoder-explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), limit: 5 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEncoderStatus(data.error || 'failed');
        return;
      }
      setEncoderMeta({
        modelType: data.model_type || '-',
        modelVersion: data.model_version || 0,
        embeddingDim: data.embedding_dim || 0,
        candidateCount: data.candidate_count || 0,
      });
      setEncoderRows(data.results || []);
      setEncoderStatus('succeeded');
    } catch {
      setEncoderStatus('failed');
    }
  }

  function formatVector(values, max = 8) {
    if (!Array.isArray(values) || values.length === 0) {
      return '[]';
    }
    const preview = values.slice(0, max).map((value) => Number(value).toFixed(4));
    const suffix = values.length > max ? `, ... (${values.length})` : '';
    return `[${preview.join(', ')}${suffix}]`;
  }

  return (
    <main className="page">
      <nav className="topNav">
        <div className="brand" aria-label="FTO 专利防侵权">
          <span className="brandLatin">FTO</span>
          <span className="brandCn">专利防侵权</span>
        </div>
        <div className="navLinks">
          {navItems.map((item) => (
            <a
              key={item.href}
              className="navLink"
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {item.label}
            </a>
          ))}
        </div>
      </nav>

      <section className="card">
        <textarea
          placeholder="输入技术方案描述，例如：一种无线充电散热结构..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="row">
          <button onClick={submitTask}>提交分析任务</button>
          <button onClick={testEncoder}>测试 Encoder</button>
          <button onClick={() => refreshEsMeta(query)}>刷新 ES 状态</button>
          <span className="tag">
            状态：{status}
            {progress !== null ? ` ${progress}%` : ''}
          </span>
          <span className="tag">Encoder：{encoderStatus}</span>
        </div>

        <div className="row">
          <span className="tag">
            ES 召回：
            {esMeta.loaded ? (esMeta.enabled ? 'enabled' : 'disabled') : 'loading'}
          </span>
          <span className="tag">ES 索引：{esMeta.index}</span>
          <span className="tag">ES 候选数：{esMeta.candidateCount ?? '-'}</span>
          {esMeta.error ? <span className="tag">ES 错误：{esMeta.error}</span> : null}
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

      <section className="card">
        <h2>Encoder 调试面板</h2>
        <p>使用当前输入的查询，查看 top-k 候选专利的特征向量、embedding 和 encoder score。</p>

        <div className="row">
          <span className="tag">候选数：{encoderMeta?.candidateCount ?? '-'}</span>
          <span className="tag">Encoder：{encoderMeta?.modelType ?? '-'}</span>
          <span className="tag">版本：{encoderMeta?.modelVersion ?? '-'}</span>
          <span className="tag">Embedding Dim：{encoderMeta?.embeddingDim ?? '-'}</span>
        </div>

        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>专利号</th>
              <th>标题</th>
              <th>Encoder Score</th>
              <th>Final Score</th>
              <th>Embedding</th>
              <th>Features</th>
            </tr>
          </thead>
          <tbody>
            {encoderRows.length === 0 ? (
              <tr>
                <td colSpan={7}>暂无 Encoder 调试结果</td>
              </tr>
            ) : (
              encoderRows.map((row) => (
                <tr key={row.patent_id}>
                  <td>{row.rank}</td>
                  <td>
                    <a
                      href={row.patent_url || `https://patents.google.com/patent/${row.patent_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {row.patent_id}
                    </a>
                  </td>
                  <td>{row.title}</td>
                  <td>{Number(row.encoder_score || 0).toFixed(4)}</td>
                  <td>{Number(row.final_score || 0).toFixed(4)}</td>
                  <td>
                    <code className="vectorText">{formatVector(row.embedding)}</code>
                  </td>
                  <td>
                    <code className="vectorText">{formatVector(row.features)}</code>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
