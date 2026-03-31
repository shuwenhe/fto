function parsePercentile(latencies, p) {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function average(nums) {
  if (nums.length === 0) return 0;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createTask(baseUrl, query) {
  const res = await fetch(`${baseUrl}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(`POST /tasks status=${res.status}`);
  }
  const body = await res.json();
  if (!body.task_id) {
    throw new Error('POST /tasks missing task_id');
  }
  return String(body.task_id);
}

async function waitTaskDone(baseUrl, taskId, pollMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`);
    if (!res.ok) {
      throw new Error(`GET /tasks/${taskId} status=${res.status}`);
    }
    const body = await res.json();
    const status = String(body.status || '');
    if (status === 'succeeded') return body;
    if (status === 'failed') throw new Error(`task ${taskId} failed`);
    await sleep(pollMs);
  }
  throw new Error(`task ${taskId} timeout`);
}

export async function runLoadTest(options) {
  const {
    baseUrl,
    queries,
    concurrency,
    durationSec,
    pollMs,
    timeoutMs,
  } = options;

  if (!Array.isArray(queries) || queries.length === 0) {
    throw new Error('queries is empty');
  }

  const startAt = Date.now();
  const endAt = startAt + durationSec * 1000;

  let queryCursor = 0;
  const latencies = [];
  let total = 0;
  let succeeded = 0;
  let failed = 0;
  const errors = new Map();

  async function worker() {
    while (Date.now() < endAt) {
      const query = String(queries[queryCursor % queries.length]);
      queryCursor += 1;

      const t0 = Date.now();
      total += 1;
      try {
        const taskId = await createTask(baseUrl, query);
        await waitTaskDone(baseUrl, taskId, pollMs, timeoutMs);
        const t1 = Date.now();
        latencies.push(t1 - t0);
        succeeded += 1;
      } catch (e) {
        const t1 = Date.now();
        latencies.push(t1 - t0);
        failed += 1;
        const key = e && e.message ? e.message : 'unknown_error';
        errors.set(key, (errors.get(key) || 0) + 1);
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const elapsedSec = Math.max(1e-9, (Date.now() - startAt) / 1000);
  const errorRate = total > 0 ? failed / total : 0;
  const report = {
    started_at: new Date(startAt).toISOString(),
    ended_at: new Date().toISOString(),
    duration_sec: Number(elapsedSec.toFixed(3)),
    concurrency,
    total_requests: total,
    succeeded,
    failed,
    error_rate: Number(errorRate.toFixed(6)),
    throughput_rps: Number((total / elapsedSec).toFixed(3)),
    latency_ms: {
      min: latencies.length ? Math.min(...latencies) : 0,
      avg: Number(average(latencies).toFixed(2)),
      p50: parsePercentile(latencies, 50),
      p95: parsePercentile(latencies, 95),
      p99: parsePercentile(latencies, 99),
      max: latencies.length ? Math.max(...latencies) : 0,
    },
    errors: Object.fromEntries([...errors.entries()].sort((a, b) => b[1] - a[1])),
  };

  return report;
}
