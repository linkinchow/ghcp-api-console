// Fixed-target ingress plus a mock-only adapter. No Docker socket, shell endpoint,
// configurable upstream, redirects, or access to host .env/certificates.
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PROJECT = 'ghcp-user-pool-mysql-test';
const INTERNAL = 'mysql-fixture-internal-only';
const RAW_MODEL = 'claude-opus-5.2';
const mode = process.argv[2];
const servers = [];
function json(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function authorized(req) {
  const value = Buffer.from(String(req.headers['x-internal-token'] ?? ''));
  const expected = Buffer.from(INTERNAL);
  return value.length === expected.length && timingSafeEqual(value, expected);
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error('body_limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
function forward(req, res, hostname, port, path = req.url) {
  const upstream = http.request({ hostname, port, path, method: req.method,
    headers: { ...req.headers, host: `${hostname}:${port}` } }, response => {
    res.writeHead(response.statusCode, response.headers);
    // pipe() does not forward IncomingMessage failures. A truncated upstream
    // must abort the downstream socket, not leave it hanging or turn it into EOF.
    const abort = () => res.destroy();
    response.on('aborted', abort);
    response.on('error', abort);
    response.on('close', () => { if (!response.complete) abort(); });
    response.pipe(res);
  });
  upstream.setTimeout(45000, () => upstream.destroy());
  upstream.on('error', () => {
    if (res.headersSent) res.destroy();
    else json(res, 502, { error: 'fixture_upstream_unavailable' });
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}
function listen(port, handler) {
  const server = http.createServer((req, res) => {
    // Never accept absolute-form URLs (or CONNECT) as a forward proxy.
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return json(res, 400, { error: 'invalid_path' });
    Promise.resolve(handler(req, res)).catch(() => {
      if (res.headersSent) res.destroy(); else json(res, 400, { error: 'invalid_fixture_request' });
    });
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 45000;
  server.listen(port, '0.0.0.0');
  servers.push(server);
}
let fixture;
if (mode === 'bridge') {
  const targets = [[18100, 'proxy', 3000], [18101, 'proxy2', 3000], [18102, 'mock', 8002], [18104, 'console', 7004]];
  if (process.env.MYSQL_STABILITY_FIXTURE === '1') targets.push([18103, 'litellm', 7000], [18105, 'pool-lb', 8080], [18106, 'pool-lb', 8081], [18107, 'pool-lb', 8082]);
  for (const [port, host, upstreamPort] of targets) listen(port, (req, res) => {
    const path = new URL(req.url, 'http://fixture.invalid').pathname;
    if (path === '/__mysql/manifest' && req.method === 'GET') {
      const service = port === 18105 ? 'businessLB' : port === 18106 ? 'internalLB' : port === 18107 ? 'lbStats' : host;
      const rehearsal = process.env.MYSQL_REHEARSAL_DB;
      if (rehearsal && !/^ghcp_pool_test_rehearsal_[a-f0-9]{32}$/.test(rehearsal)) return json(res, 500, { error: 'invalid_rehearsal_database' });
      return json(res, 200, { fixture: true, project: PROJECT, service, mysqlPort: 33184, database: rehearsal ?? 'ghcp_pool_mysql_test',
        ...(rehearsal ? { mode: 'rehearsal', rehearsalId: rehearsal.slice('ghcp_pool_test_rehearsal_'.length) } : {}) });
    }
    // SSO and real Login are reachable ONLY through these read-only fixture routes.
    // Real Login never receives a runnable task from this harness.
    if (port === 18102 && path.startsWith('/__mysql/sso/')) {
      const target = req.url.slice('/__mysql/sso'.length);
      const targetPath = new URL(target, 'http://fixture.invalid').pathname;
      const settings = process.env.MYSQL_PROVISION_FIXTURE === '1' && targetPath === '/api/settings/runtime'
        && ['GET', 'PATCH'].includes(req.method);
      if (!settings && (req.method !== 'GET' || !['/healthz', '/api/users'].includes(targetPath))) return json(res, 403, { error: 'read_only' });
      if (path !== '/__mysql/sso/healthz' && !authorized(req)) return json(res, 401, { error: 'unauthorized' });
      return forward(req, res, 'sso', 7001, target);
    }
    if (port === 18102 && path.startsWith('/__mysql/login/')) {
      const target = req.url.slice('/__mysql/login'.length);
      if (req.method !== 'GET' || !['/healthz', '/api/tasks'].includes(new URL(target, 'http://fixture.invalid').pathname)) return json(res, 403, { error: 'read_only' });
      if (path !== '/__mysql/login/healthz' && !authorized(req)) return json(res, 401, { error: 'unauthorized' });
      return forward(req, res, 'login', 7003, target);
    }
    return forward(req, res, host, upstreamPort);
  });
  const sockets = new Set();
  const mysql = net.createServer(client => {
    const upstream = net.connect({ host: 'mysql', port: 3306 });
    sockets.add(client); sockets.add(upstream);
    for (const socket of [client, upstream]) {
      socket.on('error', () => { client.destroy(); upstream.destroy(); });
      socket.on('close', () => { sockets.delete(socket); client.destroy(); upstream.destroy(); });
      socket.setTimeout(120000, () => socket.destroy());
    }
    client.pipe(upstream); upstream.pipe(client);
  });
  mysql.listen(33184, '0.0.0.0');
  servers.push(mysql);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { for (const socket of sockets) socket.destroy(); });
} else if (mode === 'mock') {
  // Keep the existing SCIM / seat / mock Login callback / warmup fixture intact.
  // The extra synthetic upstream accepts ONLY an explicitly registered load set;
  // no synthetic OAuth token is meaningful at GitHub or the original fixture.
  fixture = spawn(process.execPath, [fileURLToPath(new URL('./mock-services.mjs', import.meta.url))], {
    stdio: 'inherit', env: { ...process.env, PORT: '8003', PROXY_BASE_URL: process.env.MYSQL_STABILITY_FIXTURE === '1' ? 'http://pool-lb:8081' : 'http://proxy:3000' },
  });
  fixture.on('error', () => { console.error('FAIL nested_fixture_start'); process.exitCode = 1; shutdown(); });
  fixture.on('exit', code => { process.exitCode = code ?? 1; shutdown(); });
  let registered = false;
  const records = [];
  const primaryAttempts = [];
  const active = new Map();
  let peakActive = 0, modelLists = 0;
  listen(8002, async (req, res) => {
    const path = new URL(req.url, 'http://fixture.invalid').pathname;
    if (process.env.MYSQL_STABILITY_FIXTURE === '1') {
      if (path === '/__mysql/gateway-state' && req.method === 'GET') {
        if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
        return json(res, 200, { fixture: true, primaryAttempts });
      }
      if (path === '/other/v1/messages' && req.method === 'POST'
        && req.headers['x-api-key'] !== 'local-other-provider-test-only'
        && req.headers.authorization !== 'Bearer local-other-provider-test-only') {
        const input = await body(req);
        const text = JSON.stringify(input.messages ?? []);
        const marker = /POOL_TEST:(\{.*?\})/.exec(text.replaceAll('\\"', '"'))?.[1];
        let id;
        try { id = JSON.parse(marker ?? '{}').id; } catch {}
        if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(id)) return json(res, 400, { error: 'fixture_marker_required' });
        if (primaryAttempts.length >= 1000) return json(res, 429, { error: 'fixture_attempt_limit' });
        primaryAttempts.push({ marker: id, status: 503, identityHeaderPresent: Object.hasOwn(req.headers, 'x-user-identity') });
        return json(res, 503, { type: 'error', error: { type: 'api_error', message: 'Synthetic primary unavailable' } });
      }
    }
    if (path.startsWith('/__mysql/load-')) {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      if (path === '/__mysql/load-register' && req.method === 'POST') {
        const input = await body(req);
        if (input.confirm !== PROJECT || input.members !== 2000 || registered) return json(res, 409, { error: 'fresh_load_registration_required' });
        registered = true;
        return json(res, 201, { fixture: true, registered: 2000 });
      }
      if (path === '/__mysql/load-state' && req.method === 'GET') {
        return json(res, 200, { fixture: true, registered: registered ? 2000 : 0,
          requests: records.length, modelLists, active: active.size, peakActive, records });
      }
      return json(res, 404, { error: 'not_found' });
    }
    const match = /^Bearer mysql-fixture-load-token-([0-9]{4})$/.exec(String(req.headers.authorization ?? ''));
    if (!match) return forward(req, res, '127.0.0.1', 8003);
    const memberIndex = Number(match[1]);
    if (!registered || memberIndex >= 2000) return json(res, 401, { error: { code: 'unregistered_fixture_token' } });
    if (path === '/models' && req.method === 'GET') {
      modelLists++;
      return json(res, 200, { object: 'list', data: [{ id: RAW_MODEL, object: 'model', name: 'Synthetic MySQL fixture', vendor: 'Anthropic', capabilities: { type: 'chat', endpoints: ['/v1/messages', '/chat/completions', '/responses'] } }] });
    }
    if (req.method !== 'POST' || !['/v1/messages', '/chat/completions', '/responses'].includes(path)) return json(res, 404, { error: 'not_found' });
    const input = await body(req);
    const text = path === '/responses' ? input.input : input.messages?.[0]?.content;
    const marker = typeof text === 'string' && /^MYSQL_LOAD:([A-Za-z0-9-]{1,60})$/.exec(text)?.[1];
    if (input.model !== RAW_MODEL || !marker || records.length >= 10000) return json(res, 400, { error: 'invalid_load_input' });
    const record = { marker, memberIndex, path, stream: input.stream === true, complete: false };
    records.push(record);
    active.set(record, true); peakActive = Math.max(peakActive, active.size);
    res.once('close', () => active.delete(record));
    // A short fixed delay lets the load observer see real persisted request holds.
    await new Promise(resolve => setTimeout(resolve, 20));
    if (res.destroyed) return;
    const id = `fixture_${records.length}`;
    const output = path === '/v1/messages'
      ? { id, type: 'message', role: 'assistant', model: RAW_MODEL, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 1 } }
      : path === '/chat/completions'
        ? { id, object: 'chat.completion', model: RAW_MODEL, choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }
        : { id, object: 'response', model: RAW_MODEL, status: 'completed', error: null, output: [{ id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }], usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } };
    record.complete = true;
    if (!input.stream) return json(res, 200, output);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const event = (name, data) => res.write(`${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
    if (path === '/v1/messages') {
      event('message_start', { type: 'message_start', message: { ...output, content: [], stop_reason: null } });
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } });
      event('content_block_stop', { type: 'content_block_stop', index: 0 });
      event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
      event('message_stop', { type: 'message_stop' });
    } else if (path === '/chat/completions') {
      event(null, { id, object: 'chat.completion.chunk', model: RAW_MODEL, choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] });
      event(null, { id, object: 'chat.completion.chunk', model: RAW_MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: output.usage });
      res.write('data: [DONE]\n\n');
    } else {
      event('response.created', { type: 'response.created', sequence_number: 0, response: { ...output, status: 'in_progress', output: [] } });
      event('response.output_text.delta', { type: 'response.output_text.delta', sequence_number: 1, output_index: 0, content_index: 0, delta: 'OK' });
      event('response.completed', { type: 'response.completed', sequence_number: 2, response: output });
    }
    res.end();
  });
} else {
  throw new Error('Expected bridge or mock mode');
}
function shutdown() {
  for (const server of servers) { server.close(); server.closeAllConnections?.(); }
  if (fixture && fixture.exitCode === null) fixture.kill('SIGTERM');
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown);
console.log(`MYSQL_FIXTURE_READY mode=${mode}`);
