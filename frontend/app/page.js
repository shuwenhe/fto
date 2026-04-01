'use client';

import { useEffect, useRef, useState } from 'react';

const navItems = [
  { label: '首页', href: 'http://111.202.231.146:8080/fto' },
  { label: '健康检查', href: 'http://111.202.231.146:8080/fto/api/health' },
  { label: '运行指标', href: 'http://111.202.231.146:8080/fto/api/metrics' },
  { label: '排序配置', href: 'http://111.202.231.146:8080/fto/api/ops/ranking-config' },
  { label: '排序模型', href: 'http://111.202.231.146:8080/fto/api/ops/ranking-model' },
];

const PDF_FONT_NAME = 'DroidSansFallback';
const PDF_FONT_FILE = 'DroidSansFallbackFull.ttf';
let pdfFontBase64Promise = null;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function ensurePdfFont(doc) {
  if (typeof doc.getFontList === 'function') {
    const fonts = doc.getFontList();
    if (fonts[PDF_FONT_NAME]?.includes?.('normal')) {
      doc.setFont(PDF_FONT_NAME, 'normal');
      return;
    }
  }

  if (!pdfFontBase64Promise) {
    pdfFontBase64Promise = fetch(`/fto/fonts/${PDF_FONT_FILE}`)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`font fetch failed: ${res.status}`);
        }
        return res.arrayBuffer();
      })
      .then(arrayBufferToBase64);
  }

  const fontBase64 = await pdfFontBase64Promise;
  doc.addFileToVFS(PDF_FONT_FILE, fontBase64);
  doc.addFont(PDF_FONT_FILE, PDF_FONT_NAME, 'normal');
  doc.setFont(PDF_FONT_NAME, 'normal');
}

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
  const [rankingStatus, setRankingStatus] = useState('idle');
  const [rankingMeta, setRankingMeta] = useState(null);
  const [recallFilter, setRecallFilter] = useState('all');
  const [recallRows, setRecallRows] = useState([]);
  const [rerankerRows, setRerankerRows] = useState([]);
  const [judgeRows, setJudgeRows] = useState([]);
  const [reportStatus, setReportStatus] = useState('idle');
  const [reportData, setReportData] = useState(null);
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
        milvusEnabled: Boolean(modelData.milvus_enabled),
        index: modelData.elasticsearch_index || '-',
        milvusCollection: modelData.milvus_collection || '-',
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
    refreshRankingExplain(query.trim());
    runEncoderExplain(query.trim());

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

  async function refreshRankingExplain(queryText) {
    if (!queryText.trim()) {
      return;
    }
    setRankingStatus('loading');
    setRankingMeta(null);
    setRecallRows([]);
    setRerankerRows([]);
    setJudgeRows([]);

    try {
      const res = await fetch('/fto/api/ops/ranking-explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: queryText.trim(), limit: 5 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRankingStatus(data.error || 'failed');
        return;
      }

      const explainRows = data.results || [];
      setRankingMeta({
        mode: data.ranking_mode || '-',
        modelLoaded: Boolean(data.model_loaded),
        candidateCount: data.candidate_count || 0,
        recallDebug: data.recall_debug || null,
        featureNames: data.feature_names || [],
        originalQuery: data.original_query || data.query || '-',
        rewrittenQuery: data.rewritten_query || data.query || '-',
        rewriteApplied: Boolean(data.rewrite_applied),
      });
      setRecallRows(explainRows);
      setRerankerRows(explainRows);
      setJudgeRows(explainRows);
      setRankingStatus('succeeded');
    } catch {
      setRankingStatus('failed');
    }
  }

  async function runEncoderExplain(queryText) {
    if (!queryText.trim()) {
      return;
    }
    setEncoderStatus('loading');
    setEncoderRows([]);
    setEncoderMeta(null);

    try {
      const res = await fetch('/fto/api/ops/encoder-explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: queryText.trim(), limit: 5 }),
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
        recallDebug: data.recall_debug || null,
        originalQuery: data.original_query || data.query || '-',
        rewrittenQuery: data.rewritten_query || data.query || '-',
        rewriteApplied: Boolean(data.rewrite_applied),
      });
      setEncoderRows(data.results || []);
      setEncoderStatus('succeeded');
    } catch {
      setEncoderStatus('failed');
    }
  }

  async function refreshAllModelPanels() {
    if (!query.trim()) {
      alert('请先输入技术方案描述');
      return;
    }
    await Promise.all([refreshRankingExplain(query.trim()), runEncoderExplain(query.trim())]);
  }

  async function generateFTOReport() {
    if (!query.trim()) {
      alert('请先输入技术方案描述');
      return;
    }
    setReportStatus('loading');
    setReportData(null);
    try {
      const res = await fetch('/fto/api/ops/fto-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), limit: 8, top_n: 5, include_encoder: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        setReportStatus(data.error || 'failed');
        return;
      }
      setReportData(data);
      setReportStatus('succeeded');
    } catch {
      setReportStatus('failed');
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

  function formatIdList(values, max = 12) {
    if (!Array.isArray(values) || values.length === 0) {
      return '-';
    }
    const preview = values.slice(0, max);
    const suffix = values.length > max ? ` ... (${values.length})` : '';
    return `${preview.join(', ')}${suffix}`;
  }

  function countIdHits(values) {
    const counts = new Map();
    if (!Array.isArray(values)) {
      return counts;
    }
    values.forEach((value) => {
      const id = String(value || '').trim();
      if (!id) {
        return;
      }
      counts.set(id, (counts.get(id) || 0) + 1);
    });
    return counts;
  }

  function buildRankMap(values) {
    const ranks = new Map();
    if (!Array.isArray(values)) {
      return ranks;
    }
    values.forEach((value, index) => {
      const id = String(value || '').trim();
      if (!id || ranks.has(id)) {
        return;
      }
      ranks.set(id, index + 1);
    });
    return ranks;
  }

  function getDedupedLabel(id, esCounts, milvusCounts) {
    const esCount = esCounts.get(id) || 0;
    const milvusCount = milvusCounts.get(id) || 0;
    if (esCount > 0 && milvusCount > 0) {
      return '双方重复';
    }
    if (esCount > 1 || esCount > 0) {
      return '来自 ES';
    }
    if (milvusCount > 1 || milvusCount > 0) {
      return '来自 Milvus';
    }
    return '未知';
  }

  function getSourceHitLabel(id, esRanks, milvusRanks) {
    const esRank = esRanks.get(id);
    const milvusRank = milvusRanks.get(id);
    const parts = [];
    if (esRank) {
      parts.push(`ES#${esRank}`);
    }
    if (milvusRank) {
      parts.push(`Milvus#${milvusRank}`);
    }
    return parts.length > 0 ? parts.join(' | ') : '未命中';
  }

  function renderIdItems(values, options = {}) {
    const list = Array.isArray(values) ? values : [];
    if (list.length === 0) {
      return <li>-</li>;
    }
    const max = options.max ?? 12;
    const esCounts = options.esCounts || new Map();
    const milvusCounts = options.milvusCounts || new Map();
    const esRanks = options.esRanks || new Map();
    const milvusRanks = options.milvusRanks || new Map();
    const mergedSet = options.mergedSet || new Set();
    const sourceRanks = options.sourceRanks || new Map();
    return list.slice(0, max).map((id, index) => {
      const rank = sourceRanks.get(id) || index + 1;
      const mergedHit = mergedSet.has(id);
      return (
        <li
          key={`${options.prefix || 'id'}-${id}`}
          style={mergedHit ? { background: 'rgba(215, 140, 48, 0.12)', borderRadius: '6px', padding: '4px 6px' } : undefined}
        >
          <a
            href={`https://patents.google.com/patent/${id}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <code>{id}</code>
          </a>{' '}
          <span>#{rank}</span>
          {options.showDedupedLabel ? ` (${getDedupedLabel(id, esCounts, milvusCounts)})` : ''}
          {options.showSourceHitLabel ? ` [${getSourceHitLabel(id, esRanks, milvusRanks)}]` : ''}
        </li>
      );
    });
  }

  function filterRecallIds(values, filter, esCounts, milvusCounts) {
    const list = Array.isArray(values) ? values : [];
    if (filter === 'intersection') {
      return list.filter((id) => (esCounts.get(id) || 0) > 0 && (milvusCounts.get(id) || 0) > 0);
    }
    if (filter === 'es_only') {
      return list.filter((id) => (esCounts.get(id) || 0) > 0 && (milvusCounts.get(id) || 0) === 0);
    }
    if (filter === 'milvus_only') {
      return list.filter((id) => (milvusCounts.get(id) || 0) > 0 && (esCounts.get(id) || 0) === 0);
    }
    return list;
  }

  async function copyDebugJson() {
    const payload = {
      query: rankingMeta?.originalQuery || query || '',
      rewritten_query: rankingMeta?.rewrittenQuery || '',
      candidate_count: rankingMeta?.candidateCount ?? null,
      recall_debug: rankingMeta?.recallDebug || null,
    };
    const text = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      alert('debug json copied');
    } catch {
      alert('copy failed');
    }
  }

  function buildReportTextLines(report) {
    const lines = [];
    lines.push('FTO 专利防侵权分析报告');
    lines.push(`报告ID: ${report.report_id || '-'}`);
    lines.push(`生成时间: ${report.generated_at || '-'}`);
    lines.push(`原始查询: ${report.original_query || '-'}`);
    lines.push(`改写查询: ${report.rewritten_query || '-'}`);
    lines.push(`候选数: ${report.candidate_count ?? '-'}`);
    lines.push('');
    lines.push('执行摘要');
    lines.push(report.executive_summary || '-');
    lines.push('');
    lines.push('核心发现');
    (report.core_findings || []).forEach((item, idx) => lines.push(`${idx + 1}. ${item}`));
    lines.push('');
    lines.push('行动建议');
    (report.recommendations || []).forEach((item, idx) => lines.push(`${idx + 1}. ${item}`));
    lines.push('');
    lines.push('证据清单');
    (report.evidence || []).forEach((item) => {
      lines.push(
        `#${item.rank} ${item.patent_id} | ${item.title} | risk=${item.risk_level || '-'} | final=${Number(
          item.final_score || 0
        ).toFixed(4)}`
      );
      lines.push(`source: ${item.source_url || item.patent_url || '-'}`);
      lines.push(`reason: ${item.reason || '-'}`);
      lines.push('');
    });
    return lines;
  }

  async function withPdfDoc(report) {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    await ensurePdfFont(doc);
    doc.setFontSize(11);

    const lines = buildReportTextLines(report);
    const marginX = 40;
    const marginY = 50;
    const lineHeight = 16;
    const pageWidth = doc.internal.pageSize.getWidth() - marginX * 2;
    const pageHeight = doc.internal.pageSize.getHeight();
    let y = marginY;

    for (const line of lines) {
      const wrapped = doc.splitTextToSize(line, pageWidth);
      for (const seg of wrapped) {
        if (y > pageHeight - marginY) {
          doc.addPage();
          y = marginY;
        }
        doc.text(seg, marginX, y);
        y += lineHeight;
      }
    }
    return doc;
  }

  async function downloadReportPdf() {
    if (!reportData) return;
    const doc = await withPdfDoc(reportData);
    const ts = (reportData.generated_at || '').replace(/[:TZ-]/g, '').slice(0, 14) || Date.now();
    doc.save(`fto_report_${ts}.pdf`);
  }

  async function viewReportPdf() {
    if (!reportData) return;
    const doc = await withPdfDoc(reportData);
    const blob = doc.output('blob');
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function printReportPdf() {
    if (!reportData) return;
    const doc = await withPdfDoc(reportData);
    const blob = doc.output('blob');
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    if (win) {
      setTimeout(() => {
        win.focus();
        win.print();
      }, 800);
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function buildDocxBlob(report) {
    const { Document, Packer, Paragraph, HeadingLevel } = await import('docx');
    const children = [];
    children.push(new Paragraph({ text: 'FTO 专利防侵权分析报告', heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph(`报告ID: ${report.report_id || '-'}`));
    children.push(new Paragraph(`生成时间: ${report.generated_at || '-'}`));
    children.push(new Paragraph(`原始查询: ${report.original_query || '-'}`));
    children.push(new Paragraph(`改写查询: ${report.rewritten_query || '-'}`));
    children.push(new Paragraph(`候选数: ${report.candidate_count ?? '-'}`));
    children.push(new Paragraph(''));
    children.push(new Paragraph({ text: '执行摘要', heading: HeadingLevel.HEADING_2 }));
    children.push(new Paragraph(report.executive_summary || '-'));
    children.push(new Paragraph({ text: '核心发现', heading: HeadingLevel.HEADING_2 }));
    (report.core_findings || []).forEach((item, idx) => children.push(new Paragraph(`${idx + 1}. ${item}`)));
    children.push(new Paragraph({ text: '行动建议', heading: HeadingLevel.HEADING_2 }));
    (report.recommendations || []).forEach((item, idx) =>
      children.push(new Paragraph(`${idx + 1}. ${item}`))
    );
    children.push(new Paragraph({ text: '证据清单（可追溯）', heading: HeadingLevel.HEADING_2 }));
    (report.evidence || []).forEach((item) => {
      children.push(
        new Paragraph(
          `#${item.rank} ${item.patent_id} | ${item.title} | risk=${item.risk_level || '-'} | final=${Number(
            item.final_score || 0
          ).toFixed(4)}`
        )
      );
      children.push(new Paragraph(`source: ${item.source_url || item.patent_url || '-'}`));
      children.push(new Paragraph(`reason: ${item.reason || '-'}`));
      children.push(new Paragraph(''));
    });

    const doc = new Document({ sections: [{ children }] });
    return Packer.toBlob(doc);
  }

  async function downloadReportDocx() {
    if (!reportData) return;
    const blob = await buildDocxBlob(reportData);
    const ts = (reportData.generated_at || '').replace(/[:TZ-]/g, '').slice(0, 14) || Date.now();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `fto_report_${ts}.docx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function viewDocxFile() {
    if (!reportData) return;
    const blob = await buildDocxBlob(reportData);
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
          <button onClick={refreshAllModelPanels}>刷新四模型面板</button>
          <button onClick={generateFTOReport}>生成 FTO 专利防侵权分析报告</button>
          <button onClick={() => refreshEsMeta(query)}>刷新 ES 状态</button>
          <span className="tag">
            状态：{status}
            {progress !== null ? ` ${progress}%` : ''}
          </span>
          <span className="tag">Ranking：{rankingStatus}</span>
          <span className="tag">Encoder：{encoderStatus}</span>
          <span className="tag">Report：{reportStatus}</span>
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
        <h2>FTO 专利防侵权分析报告</h2>
        {reportData ? (
          <>
            <div className="row">
              <button onClick={viewReportPdf}>查看 PDF</button>
              <button onClick={printReportPdf}>打印 PDF</button>
              <button onClick={downloadReportPdf}>下载 PDF</button>
              <button onClick={viewDocxFile}>查看 DOCX</button>
              <button onClick={downloadReportDocx}>下载 DOCX</button>
            </div>
            <div className="row">
              <span className="tag">报告ID：{reportData.report_id || '-'}</span>
              <span className="tag">生成时间：{reportData.generated_at || '-'}</span>
              <span className="tag">候选数：{reportData.candidate_count ?? '-'}</span>
              <span className="tag">原始查询：{reportData.original_query || '-'}</span>
              <span className="tag">改写查询：{reportData.rewritten_query || '-'}</span>
            </div>

            <p>{reportData.executive_summary || '-'}</p>

            <h3>核心发现</h3>
            <ol>
              {(reportData.core_findings || []).map((item, idx) => (
                <li key={`finding-${idx}`}>{item}</li>
              ))}
            </ol>

            <h3>行动建议</h3>
            <ol>
              {(reportData.recommendations || []).map((item, idx) => (
                <li key={`recommendation-${idx}`}>{item}</li>
              ))}
            </ol>

            <h3>证据清单（可追溯）</h3>
            <table>
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>专利号</th>
                  <th>标题</th>
                  <th>Risk</th>
                  <th>Final</th>
                  <th>Model</th>
                  <th>Deep</th>
                  <th>Encoder</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {(reportData.evidence || []).length === 0 ? (
                  <tr>
                    <td colSpan={9}>暂无证据</td>
                  </tr>
                ) : (
                  (reportData.evidence || []).map((item) => (
                    <tr key={`report-${item.patent_id}`}>
                      <td>{item.rank}</td>
                      <td>
                        <a href={item.source_url || item.patent_url} target="_blank" rel="noopener noreferrer">
                          {item.patent_id}
                        </a>
                      </td>
                      <td>{item.title}</td>
                      <td>{item.risk_level || '-'}</td>
                      <td>{Number(item.final_score || 0).toFixed(4)}</td>
                      <td>{item.model_score === undefined ? '-' : Number(item.model_score).toFixed(4)}</td>
                      <td>{item.deep_score === undefined ? '-' : Number(item.deep_score).toFixed(4)}</td>
                      <td>{item.encoder_score === undefined ? '-' : Number(item.encoder_score).toFixed(4)}</td>
                      <td>{item.reason || '-'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </>
        ) : (
          <p>点击“生成 FTO 专利防侵权分析报告”后展示结构化报告与可追溯证据。</p>
        )}
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
        <h2>Recall</h2>
        <div className="row">
          <span className="tag">候选数：{rankingMeta?.candidateCount ?? '-'}</span>
          <span className="tag">模式：{rankingMeta?.mode ?? '-'}</span>
          <span className="tag">Reranker Loaded：{rankingMeta?.modelLoaded ? 'yes' : 'no'}</span>
          <span className="tag">原始查询：{rankingMeta?.originalQuery ?? '-'}</span>
          <span className="tag">改写查询：{rankingMeta?.rewrittenQuery ?? '-'}</span>
          <span className="tag">改写：{rankingMeta?.rewriteApplied ? 'applied' : 'no'}</span>
        </div>
        <div className="row">
          <span className="tag">Recall来源 ES：{rankingMeta?.recallDebug?.elasticsearch_count ?? '-'}</span>
          <span className="tag">Recall来源 Milvus：{rankingMeta?.recallDebug?.milvus_count ?? '-'}</span>
          <span className="tag">合并后：{rankingMeta?.recallDebug?.merged_count ?? '-'}</span>
          <span className="tag">Hybrid：{rankingMeta?.recallDebug?.hybrid_active ? 'effective' : 'off'}</span>
          <span className="tag">来源顺序：{Array.isArray(rankingMeta?.recallDebug?.sources) ? rankingMeta.recallDebug.sources.join(' + ') : '-'}</span>
          <span className="tag">Fallback：{rankingMeta?.recallDebug?.fallback ?? '-'}</span>
          <button onClick={copyDebugJson}>copy debug json</button>
        </div>
        <div className="row">
          <span className="tag">筛选视图</span>
          <button onClick={() => setRecallFilter('all')} disabled={recallFilter === 'all'}>全部</button>
          <button onClick={() => setRecallFilter('intersection')} disabled={recallFilter === 'intersection'}>只看交集</button>
          <button onClick={() => setRecallFilter('es_only')} disabled={recallFilter === 'es_only'}>只看 ES 独有</button>
          <button onClick={() => setRecallFilter('milvus_only')} disabled={recallFilter === 'milvus_only'}>只看 Milvus 独有</button>
        </div>
        <div
          className="debugPanel"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '16px' }}
        >
          {(() => {
            const esCounts = countIdHits(rankingMeta?.recallDebug?.elasticsearch_ids);
            const milvusCounts = countIdHits(rankingMeta?.recallDebug?.milvus_ids);
            const esRanks = buildRankMap(rankingMeta?.recallDebug?.elasticsearch_ids);
            const milvusRanks = buildRankMap(rankingMeta?.recallDebug?.milvus_ids);
            const mergedSet = new Set(rankingMeta?.recallDebug?.merged_ids || []);
            const esIds = filterRecallIds(rankingMeta?.recallDebug?.elasticsearch_ids, recallFilter, esCounts, milvusCounts);
            const milvusIds = filterRecallIds(rankingMeta?.recallDebug?.milvus_ids, recallFilter, esCounts, milvusCounts);
            const dedupedIds = filterRecallIds(rankingMeta?.recallDebug?.deduped_ids, recallFilter, esCounts, milvusCounts);
            const mergedIds = filterRecallIds(rankingMeta?.recallDebug?.merged_ids, recallFilter, esCounts, milvusCounts);
            return (
              <>
                <div>
                  <p><strong>ES top patent ids</strong></p>
                  <ul>
                    {renderIdItems(esIds, {
                      prefix: 'es',
                      sourceRanks: esRanks,
                      mergedSet,
                    })}
                  </ul>
                </div>
                <div>
                  <p><strong>Milvus top patent ids</strong></p>
                  <ul>
                    {renderIdItems(milvusIds, {
                      prefix: 'milvus',
                      sourceRanks: milvusRanks,
                      mergedSet,
                    })}
                  </ul>
                </div>
                <div>
                  <p><strong>合并去重移除的 IDs</strong></p>
                  <ul>
                    {renderIdItems(dedupedIds, {
                      prefix: 'deduped',
                      showDedupedLabel: true,
                      showSourceHitLabel: true,
                      esCounts,
                      milvusCounts,
                      esRanks,
                      milvusRanks,
                    })}
                  </ul>
                </div>
              </>
            );
          })()}
        </div>
        <div className="debugPanel">
          {(() => {
            const esRanks = buildRankMap(rankingMeta?.recallDebug?.elasticsearch_ids);
            const milvusRanks = buildRankMap(rankingMeta?.recallDebug?.milvus_ids);
            const esCounts = countIdHits(rankingMeta?.recallDebug?.elasticsearch_ids);
            const milvusCounts = countIdHits(rankingMeta?.recallDebug?.milvus_ids);
            const mergedIds = filterRecallIds(rankingMeta?.recallDebug?.merged_ids, recallFilter, esCounts, milvusCounts);
            return (
              <>
                <p><strong>最终 merged top ids</strong></p>
                <ul>
                  {renderIdItems(mergedIds, {
                    prefix: 'merged',
                    showSourceHitLabel: true,
                    esRanks,
                    milvusRanks,
                  })}
                </ul>
              </>
            );
          })()}
        </div>
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>专利号</th>
              <th>标题</th>
              <th>Lexical</th>
              <th>Semantic</th>
              <th>Matched</th>
            </tr>
          </thead>
          <tbody>
            {recallRows.length === 0 ? (
              <tr>
                <td colSpan={6}>暂无 Recall 结果</td>
              </tr>
            ) : (
              recallRows.map((row) => (
                <tr key={`recall-${row.patent_id}`}>
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
                  <td>{Number(row.lexical_score || 0).toFixed(4)}</td>
                  <td>{Number(row.semantic_score || 0).toFixed(4)}</td>
                  <td>{Array.isArray(row.matched) ? row.matched.join(', ') : '-'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Reranker</h2>
        <p>展示排序模型分数、深度重排分数与融合后最终分数。</p>
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>专利号</th>
              <th>标题</th>
              <th>Model Score</th>
              <th>Deep Score</th>
              <th>Final Score</th>
              <th>Features</th>
            </tr>
          </thead>
          <tbody>
            {rerankerRows.length === 0 ? (
              <tr>
                <td colSpan={7}>暂无 Reranker 结果</td>
              </tr>
            ) : (
              rerankerRows.map((row) => (
                <tr key={`reranker-${row.patent_id}`}>
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
                  <td>{row.model_score === undefined ? '-' : Number(row.model_score).toFixed(4)}</td>
                  <td>{row.deep_score === undefined ? '-' : Number(row.deep_score).toFixed(4)}</td>
                  <td>{Number(row.final_score || 0).toFixed(4)}</td>
                  <td>
                    <code className="vectorText">{formatVector(row.features)}</code>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Encoder</h2>
        <p>使用当前输入的查询，查看 top-k 候选专利的特征向量、embedding 和 encoder score。</p>

        <div className="row">
          <span className="tag">候选数：{encoderMeta?.candidateCount ?? '-'}</span>
          <span className="tag">Encoder：{encoderMeta?.modelType ?? '-'}</span>
          <span className="tag">版本：{encoderMeta?.modelVersion ?? '-'}</span>
          <span className="tag">Embedding Dim：{encoderMeta?.embeddingDim ?? '-'}</span>
          <span className="tag">原始查询：{encoderMeta?.originalQuery ?? '-'}</span>
          <span className="tag">改写查询：{encoderMeta?.rewrittenQuery ?? '-'}</span>
          <span className="tag">改写：{encoderMeta?.rewriteApplied ? 'applied' : 'no'}</span>
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

      <section className="card">
        <h2>Judge</h2>
        <p>展示风险等级判定与解释理由。</p>
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>专利号</th>
              <th>标题</th>
              <th>Risk</th>
              <th>Final Score</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {judgeRows.length === 0 ? (
              <tr>
                <td colSpan={6}>暂无 Judge 结果</td>
              </tr>
            ) : (
              judgeRows.map((row) => (
                <tr key={`judge-${row.patent_id}`}>
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
                  <td>{row.risk_level || '-'}</td>
                  <td>{Number(row.final_score || 0).toFixed(4)}</td>
                  <td>{row.reason || '-'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
