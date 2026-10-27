// In-cluster HTTP helper for kind-e2e.mjs. Runs inside the "LiteLLM stand-in" pod (namespace ghcp-e2e-caller) and
// inside the outsider pod, so requests travel the same Service DNS / pod network paths a real gateway would use.
// Usage: node driver.mjs <base64 JSON operation>; prints one JSON line. Node 22, no dependencies, no external hosts:
// every target must be a cluster-internal *.svc.cluster.local name or a pod IP (10.244.0.0/16).
import http from 'node:http';

const op = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8'));

function allowed(url) {
  const { hostname, protocol } = new URL(url);
  return protocol === 'http:' && (hostname.endsWith('.svc.cluster.local') || /^10\.244\.\d{1,3}\.\d{1,3}$/.test(hostname));
}

async function request(spec) {
  if (!allowed(spec.url)) throw new Error(`target not allowed: ${spec.url}`);
  const headers = { ...(spec.headers ?? {}) };
  let body;
  if (spec.form) {
    body = new URLSearchParams(spec.form).toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (spec.body !== undefined) {
    body = JSON.stringify(spec.body);
    headers['Content-Type'] = 'application/json';
  }
  const started = Date.now();
  try {
    const response = await fetch(spec.url, {
      method: spec.method ?? 'GET', headers, body, redirect: 'manual',
      signal: AbortSignal.timeout(spec.timeoutMs ?? 30000),
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { /* HTML, XML or SSE */ }
    return {
      status: response.status,
      ms: Date.now() - started,
      headers: {
        'content-type': response.headers.get('content-type'),
        location: response.headers.get('location'),
        'retry-after': response.headers.get('retry-after'),
        'set-cookie': response.headers.getSetCookie(),
      },
      json,
      text: json === undefined ? text.slice(0, spec.maxText ?? 200000) : undefined,
    };
  } catch (error) {
    return { status: 0, ms: Date.now() - started, error: error?.cause?.code ?? error?.name ?? String(error) };
  }
}

/**
 * One request over node:http with an explicit connection policy: `keep-alive` reuses pooled connections like a
 * gateway's HTTP client; `close` opens a new connection per request (`Connection: close`).
 */
function httpRequest(spec, agent) {
  if (!allowed(spec.url)) throw new Error(`target not allowed: ${spec.url}`);
  return new Promise((resolve) => {
    const body = spec.body === undefined ? undefined : JSON.stringify(spec.body);
    const headers = { ...(spec.headers ?? {}) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (agent === false) headers.Connection = 'close';
    const started = Date.now();
    const req = http.request(spec.url, { method: spec.method ?? 'GET', headers, agent, timeout: spec.timeoutMs ?? 30000 },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - started, text: text.slice(0, 300) }));
        res.on('error', (error) => resolve({ status: 0, ms: Date.now() - started, error: error.code ?? error.message }));
      });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', (error) => resolve({ status: 0, ms: Date.now() - started, error: error.code ?? error.message }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Sequential requests for `durationMs` from `concurrency` workers; reports status counts and failures. */
async function load(spec) {
  const end = Date.now() + spec.durationMs;
  const counts = {};
  const failures = [];
  const buckets = {};
  const latencies = [];
  let sent = 0;
  const agent = spec.connection === 'close' ? false : new http.Agent({ keepAlive: true, maxSockets: spec.concurrency ?? 1 });
  async function worker(id) {
    while (Date.now() < end) {
      const startedAt = Date.now();
      const result = await httpRequest(spec.request, agent);
      sent++;
      const key = String(result.status);
      counts[key] = (counts[key] ?? 0) + 1;
      latencies.push(result.ms);
      // 10-second buckets by start time: request count, slowest request, non-200 count.
      const bucket = new Date(Math.floor(startedAt / 10000) * 10000).toISOString().slice(11, 19);
      const entry = buckets[bucket] ??= { n: 0, maxMs: 0, failed: 0 };
      entry.n++;
      entry.maxMs = Math.max(entry.maxMs, result.ms);
      if (result.status !== 200) entry.failed++;
      if (result.status !== 200 && failures.length < 20) {
        failures.push({ worker: id, at: new Date().toISOString(), status: result.status, error: result.error,
          body: result.text?.slice(0, 300) });
      }
      await new Promise((resolve) => setTimeout(resolve, spec.intervalMs ?? 100));
    }
  }
  await Promise.all(Array.from({ length: spec.concurrency ?? 1 }, (_, id) => worker(id)));
  latencies.sort((a, b) => a - b);
  const at = (q) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] ?? null;
  return { sent, counts, failures, latencyMs: { p50: at(0.5), p95: at(0.95), max: latencies.at(-1) ?? null }, buckets };
}

const result = op.op === 'load' ? await load(op)
  : op.op === 'batch' ? await Promise.all((op.requests ?? []).map(request))
    : await request(op);
process.stdout.write(`${JSON.stringify(result)}\n`);
