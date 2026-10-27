// In-container fixture for shutdown-keepalive-check.mjs (Node 22, no dependencies, internal network only).
//
//   node shutdown-keepalive-fixture.mjs mock                 # Copilot/Proxy-API stand-in on :8002 with slow responses
//   node shutdown-keepalive-fixture.mjs client <base64 JSON> # keep-alive client for one service; prints JSON lines
//
// The client opens raw HTTP/1.1 connections so it can see exactly what the server does with each socket:
//   A  an idle keep-alive connection (a short request about once a second keeps it below the servers' 5 s
//      keep-alive timeout, so only the drain can close it);
//   B  a request that is in flight at SIGTERM (its body is still being uploaded, so no response headers yet);
//   C  (Proxy, Console) a streamed response whose headers were already sent at SIGTERM (SSE / CSV export); the mock
//      keeps the stream going until the client calls /release after SIGTERM;
//   D  a new connection opened after SIGTERM.
// It prints {"phase":"ready"} once A, B and C are in place and waits until the orchestrator reports that the service
// logged the start of its drain (DRAINING_FILE). Then it opens D, releases C, finishes B and records Connection
// headers, FIN/RST timing and (if the server kept the connection open) whether it can be reused. Nothing here
// leaves the internal Docker network.
import { existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const mode = process.argv[2];
// Monotonic: the Docker Desktop VM clock can be stepped while a run is in progress.
const now = () => performance.now();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** Created in the client container by the orchestrator once the service logged that it started draining. */
const DRAINING_FILE = '/tmp/shutdown-check-draining';

// ------------------------------------------------------------------------------------------------------------
// Mock

const TICK_MS = 300;
/** Streams run until the client calls /release (so they are surely open at SIGTERM), then end this much later. */
const RELEASE_DELAY_MS = 2000;
const STREAM_CAP_MS = 90_000;
const openStreams = new Set();

const MESSAGE_BODY = {
  id: 'msg_shutdown', model: 'claude-opus-5.5', type: 'message', role: 'assistant',
  content: [{ type: 'text', text: 'SHUTDOWN_MOCK_OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
};

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200_000) throw new Error('bounded request required');
  }
  return raw ? JSON.parse(raw) : {};
}

/** Writes `frame()` every TICK_MS until released (or STREAM_CAP_MS), then `last` and ends. */
function slowStream(res, first, frame, last) {
  res.write(first);
  const stream = { endAt: now() + STREAM_CAP_MS };
  openStreams.add(stream);
  const timer = setInterval(() => {
    if (res.destroyed) { clearInterval(timer); openStreams.delete(stream); return; }
    if (now() >= stream.endAt) {
      clearInterval(timer);
      openStreams.delete(stream);
      res.end(last);
      return;
    }
    res.write(frame());
  }, TICK_MS);
}

function startMock() {
  const counts = { messages: 0, streams: 0, exports: 0, releases: 0 };
  http.createServer(async (req, res) => {
    try {
      if (req.url === '/healthz') return json(res, { fixture: true });
      if (req.url === '/evidence') return json(res, counts);
      if (req.url === '/release' && req.method === 'POST') {
        counts.releases++;
        for (const stream of openStreams) stream.endAt = Math.min(stream.endAt, now() + RELEASE_DELAY_MS);
        return json(res, { released: openStreams.size });
      }
      if (req.url === '/models') {
        return json(res, { data: [{ id: 'claude-opus-5.5', supported_endpoints: ['/v1/messages'],
          capabilities: { limits: { max_context_window_tokens: 200000, max_output_tokens: 8192 } } }] });
      }
      if (req.url === '/v1/messages' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.stream) {
          counts.messages++;
          await sleep(300);
          return json(res, MESSAGE_BODY);
        }
        counts.streams++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        let n = 0;
        return slowStream(res,
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_shutdown","model":"claude-opus-5.5","usage":{"input_tokens":1}}}\n\n',
          () => `event: ping\ndata: {"type":"ping","n":${++n}}\n\n`,
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n'
            + 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
      }
      // Console forwards /api/console/proxy/<path> to <PROXY_BASE_URL>/api/<path>; a CSV attachment is streamed.
      if (req.url.startsWith('/api/shutdown-export.csv') && req.method === 'GET') {
        counts.exports++;
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="shutdown-export.csv"' });
        let n = 0;
        return slowStream(res, 'row,value\n', () => `${++n},fixture\n`, 'end,complete\n');
      }
      return json(res, { error: 'fixture_destination_not_allowed' }, 403);
    } catch (error) {
      return json(res, { error: String(error) }, 500);
    }
  }).listen(8002, '0.0.0.0');
}

// ------------------------------------------------------------------------------------------------------------
// Raw HTTP/1.1 connection

class Conn {
  constructor(host, port) {
    this.buf = Buffer.alloc(0);
    this.responses = [];
    this.current = null;
    this.endedAt = null;
    this.closedAt = null;
    this.error = null;
    this.socket = net.connect({ host, port });
    this.connected = new Promise((resolve) => {
      this.socket.once('connect', () => resolve({ ok: true }));
      this.socket.once('error', (error) => resolve({ ok: false, code: error.code }));
    });
    this.socket.on('data', (chunk) => { this.buf = Buffer.concat([this.buf, chunk]); this.parse(); });
    this.endedWall = null;
    this.socket.on('end', () => { this.endedAt = now(); this.endedWall = new Date().toISOString(); });
    this.socket.on('error', (error) => { this.error ??= { code: error.code ?? error.message, at: now() }; });
    this.socket.on('close', () => { this.closedAt = now(); });
  }

  write(text) { this.socket.write(text); }

  get open() { return this.endedAt === null && this.error === null && this.closedAt === null; }

  parse() {
    for (;;) {
      if (!this.current) {
        const end = this.buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const lines = this.buf.subarray(0, end).toString('latin1').split('\r\n');
        this.buf = this.buf.subarray(end + 4);
        const headers = {};
        for (const line of lines.slice(1)) {
          const i = line.indexOf(':');
          if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        this.current = { status: Number(lines[0].split(' ')[1]), headers, headersAt: now(), body: '', chunks: 0,
          chunked: /chunked/i.test(headers['transfer-encoding'] ?? ''),
          remaining: headers['content-length'] === undefined ? null : Number(headers['content-length']) };
      }
      const r = this.current;
      if (r.chunked) {
        const lineEnd = this.buf.indexOf('\r\n');
        if (lineEnd < 0) return;
        const size = parseInt(this.buf.subarray(0, lineEnd).toString('latin1'), 16);
        if (size === 0) {
          if (this.buf.length < lineEnd + 4) return; // "0\r\n\r\n" (no trailers)
          this.buf = this.buf.subarray(lineEnd + 4);
          this.finish();
          continue;
        }
        if (this.buf.length < lineEnd + 2 + size + 2) return;
        r.body += this.buf.subarray(lineEnd + 2, lineEnd + 2 + size).toString('utf8');
        r.chunks++;
        r.firstChunkAt ??= now();
        this.buf = this.buf.subarray(lineEnd + 2 + size + 2);
        continue;
      }
      if (r.remaining === null) return; // body until close: not expected from these servers
      const take = Math.min(r.remaining, this.buf.length);
      r.body += this.buf.subarray(0, take).toString('utf8');
      r.remaining -= take;
      this.buf = this.buf.subarray(take);
      if (r.remaining > 0) return;
      this.finish();
    }
  }

  finish() {
    this.current.completeAt = now();
    this.responses.push(this.current);
    this.current = null;
  }
}

async function until(predicate, timeoutMs, intervalMs = 10) {
  const end = now() + timeoutMs;
  while (now() < end) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

function rawRequest(method, path, host, headers = {}, body = '') {
  const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host}`, 'Connection: keep-alive'];
  for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
  if (body || method === 'POST') lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/** Summary of one connection relative to the drain trigger (all times in ms after the trigger). */
function describe(conn, trigger) {
  const rel = (at) => (at === null || at === undefined ? null : Math.round(at - trigger));
  return {
    responses: conn.responses.map((r) => ({ status: r.status, connection: r.headers.connection ?? null,
      headersAt: rel(r.headersAt), completeAt: rel(r.completeAt), chunks: r.chunks, bytes: r.body.length })),
    partial: conn.current ? { status: conn.current.status, headersAt: rel(conn.current.headersAt), bytes: conn.current.body.length } : null,
    finAt: rel(conn.endedAt), closedAt: rel(conn.closedAt), error: conn.error ? { code: conn.error.code, at: rel(conn.error.at) } : null,
  };
}

// ------------------------------------------------------------------------------------------------------------
// Client

async function client(spec) {
  const { host, port } = spec;
  const hostHeader = `${host}:${port}`;
  const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const setup = {};

  if (spec.setup === 'proxy') {
    // Synthetic SSO user + OAuth token for direct mode, then one ordinary request as a sanity check.
    const token = { 'x-internal-token': spec.internalToken, 'content-type': 'application/json' };
    const user = await fetch(`http://${spec.ssoHost}/api/enterprises/default/users`, { method: 'POST', headers: token,
      body: JSON.stringify({ ssoUser: spec.member, password: 'shutdown-fixture-password-only', email: `${spec.member}@example.test` }) });
    const imported = await fetch(`http://${hostHeader}/api/enterprises/default/accounts/copilot-oauth-token/import`,
      { method: 'POST', headers: token, body: JSON.stringify({ csvText: `name,copilotOauthToken\n${spec.member},shutdown-fixture-oauth\n` }) });
    const sanity = await fetch(`http://${hostHeader}/v1/messages`, { method: 'POST',
      headers: { ...spec.inferenceHeaders, 'content-type': 'application/json' }, body: spec.inferenceBody(false) });
    Object.assign(setup, { ssoUser: user.status, import: imported.status, sanity: sanity.status });
  }
  if (spec.setup === 'console') {
    const created = await fetch(`http://${hostHeader}/api/console/setup`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'shutdown-admin', password: 'shutdown-fixture-admin-password' }) });
    const cookies = created.headers.getSetCookie().map((line) => line.split(';', 1)[0]).join('; ');
    Object.assign(setup, { consoleSetup: created.status, cookie: Boolean(cookies) });
    spec.stream.headers = { ...spec.stream.headers, Cookie: cookies };
  }

  // A: idle keep-alive connection
  const a = new Conn(host, port);
  await a.connected;
  a.write(rawRequest('GET', '/healthz', hostHeader));
  await until(() => a.responses.length === 1, 10000);

  // B: in-flight request, body only partly uploaded
  const b = new Conn(host, port);
  await b.connected;
  const bodyText = spec.slow.body;
  const split = Math.floor(bodyText.length / 2);
  b.write(rawRequest('POST', spec.slow.path, hostHeader, { 'Content-Type': 'application/json', ...spec.slow.headers }, bodyText)
    + bodyText.slice(0, split));

  // C: streamed response with headers already sent
  let c;
  if (spec.stream) {
    c = new Conn(host, port);
    await c.connected;
    const streamBody = spec.stream.body ?? '';
    const headers = streamBody ? { 'Content-Type': 'application/json', ...spec.stream.headers } : spec.stream.headers;
    c.write(rawRequest(spec.stream.method, spec.stream.path, hostHeader, headers, streamBody) + streamBody);
    await until(() => (c.current?.chunks ?? 0) >= 1, 15000);
  }
  await sleep(300);
  const before = { aResponses: a.responses.length, aOpen: a.open, bOpen: b.open,
    cHeaders: c ? Boolean(c.current?.headersAt) : null, cChunks: c?.current?.chunks ?? null };
  out({ phase: 'ready', at: new Date().toISOString(), setup, before });

  // Keep A below the server's keep-alive timeout (5 s): a short request about once a second until the server closes
  // it or the orchestrator reports the drain. Each request takes milliseconds, so A is idle at SIGTERM; the
  // orchestrator compares A's FIN time with the service's own "draining" log line (same VM clock).
  let pings = 0;
  while (!existsSync(DRAINING_FILE) && a.open && pings < 300) {
    const count = a.responses.length;
    a.write(rawRequest('GET', '/healthz', hostHeader));
    await until(() => a.responses.length > count || !a.open, 5000);
    pings++;
    await until(() => existsSync(DRAINING_FILE) || !a.open, 1000);
  }

  // The orchestrator creates DRAINING_FILE after the service logged "SIGTERM received, draining": B is in flight and
  // C is streaming at that moment by construction.
  const triggered = await until(() => existsSync(DRAINING_FILE), spec.triggerTimeoutMs ?? 60000);
  const trigger = now();
  out({ phase: 'trigger', at: new Date().toISOString(), triggered, pings });

  // D: a new connection after SIGTERM
  const d = new Conn(host, port);
  const dResult = await Promise.race([d.connected, sleep(3000).then(() => ({ ok: null, code: 'timeout' }))]);
  d.socket.destroy();

  // C's upstream stream ends RELEASE_DELAY_MS after this.
  if (c) {
    const released = await fetch(`http://${spec.mockHost}/release`, { method: 'POST' }).then((r) => r.json(), () => null);
    out({ phase: 'released', released });
  }

  // B: finish the upload, read the response, then watch for FIN
  b.write(bodyText.slice(split));
  await until(() => b.responses.length >= 1 || !b.open, 30000);
  await until(() => !b.open, 3000);

  // Old behaviour: the connection stayed open. Show it is reused (a gateway keeps sending on it) until it closes.
  // Runs while C is still streaming, like a gateway that keeps using its pooled connections.
  const reuse = { attempted: false, served: 0, statuses: [], endedBy: null, lastServedAt: null };
  const reuseLoop = (async () => {
    if (!b.open || b.responses.length < 1) return;
    reuse.attempted = true;
    const deadline = now() + (spec.reuseMs ?? 45000);
    while (now() < deadline && b.open) {
      const count = b.responses.length;
      b.write(rawRequest('GET', '/healthz', hostHeader));
      const ok = await until(() => b.responses.length > count || !b.open, 5000);
      if (b.responses.length > count) {
        reuse.served++;
        reuse.lastServedAt = Math.round(now() - trigger);
        if (reuse.statuses.length < 5) reuse.statuses.push(b.responses.at(-1).status);
      } else if (!ok) break;
      await sleep(500);
    }
    reuse.endedBy = b.error ? `error:${b.error.code}` : b.endedAt ? 'fin' : 'still_open';
  })();

  // C: let the stream complete, then watch for FIN
  if (c) {
    await until(() => c.responses.length >= 1 || !c.open, 30000);
    await until(() => !c.open, 3000);
  }

  let cReuse = null;
  if (c?.open && c.responses.length >= 1) {
    const count = c.responses.length;
    c.write(rawRequest('GET', '/healthz', hostHeader));
    await until(() => c.responses.length > count || !c.open, 5000);
    cReuse = { served: c.responses.length > count, status: c.responses.at(-1)?.status ?? null };
  }
  await reuseLoop;

  const result = {
    phase: 'result', triggered,
    a: { ...describe(a, trigger), pings, finWall: a.endedWall ?? null },
    b: describe(b, trigger),
    c: c ? { ...describe(c, trigger), terminal: spec.stream.terminal ? c.responses[0]?.body.includes(spec.stream.terminal) ?? false : null,
      headersBeforeTrigger: (c.responses[0]?.headersAt ?? c.current?.headersAt ?? Infinity) < trigger, reuse: cReuse } : null,
    d: dResult,
    reuse,
  };
  for (const conn of [a, b, c]) conn?.socket.destroy();
  out(result);
}

if (mode === 'mock') startMock();
else if (mode === 'client') {
  const spec = JSON.parse(Buffer.from(process.argv[3] ?? '', 'base64').toString('utf8'));
  // The inference body differs only by `stream`; keep it a function for the sanity request.
  const inference = spec.inferenceBodyTemplate;
  spec.inferenceBody = (stream) => JSON.stringify({ ...inference, stream });
  await client(spec);
} else {
  console.error('usage: shutdown-keepalive-fixture.mjs mock | client <base64 JSON>');
  process.exitCode = 2;
}
