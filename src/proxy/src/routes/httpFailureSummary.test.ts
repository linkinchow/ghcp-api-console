import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Response as ExpressResponse } from 'express';
import type { ErrorDiagnosticContext } from '../diagnostics/errorDiagnostics.js';

const startup = { ...process.env };
Object.assign(process.env, { DOTENV_CONFIG_PATH: join(tmpdir(), `missing-http-summary-${randomUUID()}`),
  STORAGE_DRIVER: 'sqlite', DB_PATH: ':memory:', MYSQL_SSL_MODE: 'disabled', ACCOUNT_ROUTING_MODE: 'direct',
  PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false', REQUEST_STATS_PER_ACCOUNT_LIMIT: '20' });
const [{ pipeAndRecord, recordTokenCountFallbackFailure }, { errorDiagnosticsStore }, { config },
  { listRequestStats }, { closeStorage }] = await Promise.all([
  import('./compatible.js'), import('../diagnostics/errorDiagnostics.js'), import('../config.js'),
  import('../db/requestStatsRepo.js'), import('../db/connection.js'),
]);
for (const key of Object.keys(process.env)) if (!(key in startup)) delete process.env[key];
Object.assign(process.env, startup);

const upstreamSecret = 'synthetic-upstream-secret-value';
const inboundSecret = 'synthetic-inbound-secret-value';
function context(identity: string): ErrorDiagnosticContext {
  return { identity, path: '/v1/messages', model: 'synthetic-model', inboundRequest: {
    method: 'POST', url: '/v1/messages?api_key=synthetic-query-secret', rawHeaders: ['Authorization', 'Bearer ' + inboundSecret,
      'X-API-Key', 'synthetic-api-key', 'Cookie', 'session=synthetic-cookie'], body: Buffer.from('{"model":"synthetic-model"}'),
  } };
}
const prepared = { url: 'https://synthetic.invalid/v1/messages', method: 'POST' as const,
  headers: { Authorization: 'Bearer ' + upstreamSecret, 'Content-Type': 'application/json' }, body: '{"model":"synthetic-model"}' };
function responseRecorder() {
  const chunks: Buffer[] = [];
  const headers = new Map<string, unknown>();
  const result = { statusCode: 0, locals: {}, headersSent: false, writableEnded: false,
    status(status: number) { this.statusCode = status; return this; },
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; },
    write(value: Uint8Array | string) { chunks.push(Buffer.from(value)); this.headersSent = true; return true; },
    send(value: Uint8Array | string) { chunks.push(Buffer.from(value)); this.headersSent = true; this.writableEnded = true; return this; },
    end() { this.headersSent = true; this.writableEnded = true; return this; },
    type(value: string) { headers.set('content-type', value); return this; },
    json(value: unknown) { return this.send(JSON.stringify(value)); },
  };
  return { res: result as unknown as ExpressResponse, result, headers, text: () => Buffer.concat(chunks).toString('utf8') };
}

async function record(status: number, body: string | null, contentType = 'application/json') {
  const identity = `summary-${randomUUID()}`;
  const recorded = responseRecorder();
  const headers = { 'Content-Type': contentType, 'Retry-After': '17' };
  await pipeAndRecord(new Response(body, { status, headers }), prepared, recorded.res,
    { identity, path: '/v1/messages', model: 'synthetic-model' }, context(identity));
  const stats = await listRequestStats(identity, 10);
  assert.equal(stats.length, 1);
  assert.equal(recorded.result.statusCode, status);
  assert.equal(recorded.headers.get('retry-after'), '17');
  assert.equal(recorded.text(), body ?? '', 'wire body must remain unchanged');
  return stats[0]!;
}

test('upstream HTTP summary integration preserves wire and adds bounded safe details', async t => {
  const previous = { ...errorDiagnosticsStore.options };
  const oldAppend = errorDiagnosticsStore.append;
  const oldApiKey = config.apiKey;
  const directory = await mkdtemp(join(tmpdir(), 'http-summary-diagnostics-'));
  try {
    Object.assign(errorDiagnosticsStore.options, { enabled: false, directory });
    config.apiKey = 'synthetic-api-key';
    await t.test('JSON errors across statuses keep message/code while diagnostics are disabled', async () => {
      for (const status of [400, 401, 403, 429, 500, 502, 503]) {
        const stat = await record(status, JSON.stringify({ error: { type: 'invalid_request_error', code: 'invalid_parameter', message: 'max_tokens must be positive' } }));
        assert.equal(stat.success, false);
        assert.match(stat.failureReason!, new RegExp(`^HTTP ${status}`));
        assert.match(stat.failureReason!, /max_tokens must be positive/);
        assert.match(stat.failureReason!, /invalid_parameter/);
        assert.match(stat.failureReason!, /\[ref: [a-f0-9-]{36}\]$/);
        assert.ok(Array.from(stat.failureReason!).length <= 512);
      }
      assert.equal((await errorDiagnosticsStore.list()).enabled, false);
    });
    await t.test('known incoming and outgoing credentials never enter stored summary', async () => {
      const stat = await record(400, JSON.stringify({ error: { message: `Unsupported credentials ${inboundSecret} ${upstreamSecret} synthetic-api-key synthetic-cookie synthetic-query-secret https://private.invalid/path?key=secret` } }));
      for (const secret of [inboundSecret, upstreamSecret, 'synthetic-api-key', 'synthetic-cookie', 'synthetic-query-secret', 'private.invalid']) {
        assert.ok(!stat.failureReason!.includes(secret), secret);
      }
    });
    await t.test('malformed HTML/plain/oversized and missing bodies remain safe', async () => {
      for (const [body, type] of [[null, 'application/json'], ['<html>secret page</html>', 'text/html'],
        ['raw-private-text', 'text/plain'], ['{"error":', 'application/json'],
        [JSON.stringify({ error: { message: 'x'.repeat(17000) } }), 'application/json']] as const) {
        const stat = await record(502, body, type);
        assert.match(stat.failureReason!, /^HTTP 502 \[ref: [a-f0-9-]{36}\]$/);
      }
    });
    await t.test('non-2xx SSE extracts error summary without changing SSE bytes', async () => {
      const body = 'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Please retry later"}}\n\n';
      const stat = await record(429, body, 'text/event-stream');
      assert.match(stat.failureReason!, /Please retry later/);
      assert.match(stat.failureReason!, /rate_limit_error/);
    });
    await t.test('reference resolves to captured diagnostic when persistence succeeds', async () => {
      Object.assign(errorDiagnosticsStore.options, { enabled: true });
      const stat = await record(400, '{"error":{"message":"Invalid tool result ordering"}}');
      const id = /\[ref: ([a-f0-9-]{36})\]/.exec(stat.failureReason!)![1]!;
      assert.ok(await errorDiagnosticsStore.get(id));
    });
    await t.test('diagnostic persistence failure does not suppress summary or alter response', async () => {
      errorDiagnosticsStore.append = async () => { throw new Error('synthetic persistence failure'); };
      const stat = await record(400, '{"error":{"message":"Invalid tool result ordering"}}');
      assert.match(stat.failureReason!, /Invalid tool result ordering/);
      errorDiagnosticsStore.append = oldAppend;
    });
    await t.test('successful JSON and SSE remain successful with no failure summary', async () => {
      for (const [body, type] of [['{"content":[{"text":"OK"}]}', 'application/json'],
        ['event: message_stop\ndata: {"type":"message_stop"}\n\n', 'text/event-stream']]) {
        const stat = await record(200, body!, type);
        assert.equal(stat.success, true);
        assert.equal(stat.failureReason ?? null, null);
      }
    });
    await t.test('token-count upstream diagnostic alone creates no failed inference stat', async () => {
      const identity = `count-${randomUUID()}`;
      await recordTokenCountFallbackFailure(new Response('{"error":{"message":"Not implemented"}}', { status: 501 }), prepared, context(identity));
      assert.deepEqual(await listRequestStats(identity), []);
    });
  } finally {
    Object.assign(errorDiagnosticsStore.options, previous);
    errorDiagnosticsStore.append = oldAppend;
    config.apiKey = oldApiKey;
    await closeStorage();
    await rm(directory, { recursive: true, force: true });
  }
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('real loopback HTTP preserves error responses and persists correlatable stats without retry', { timeout: 30000 }, async () => {
  const bodies = {
    json: '{"error":{"code":"invalid_parameter","message":"max_tokens must be positive"}}',
    sse: 'event: error\ndata: {"error":{"type":"rate_limit_error","message":"Retry later"}}\n\n',
    html: '<html>private upstream response</html>',
  };
  const calls: Record<string, number> = {};
  const identityByShape = Object.fromEntries(Object.keys(bodies).map(shape => [shape, `wire-${shape}-${randomUUID()}`]));
  const upstream = createServer((req, res) => {
    const shape = req.url!.slice(1) as keyof typeof bodies;
    calls[shape] = (calls[shape] ?? 0) + 1;
    res.writeHead(shape === 'sse' ? 429 : shape === 'html' ? 502 : 400, {
      'Content-Type': shape === 'sse' ? 'text/event-stream' : shape === 'html' ? 'text/html' : 'application/json',
      'Retry-After': '17',
    });
    res.end(bodies[shape]);
  });
  const upstreamBase = await listen(upstream);
  const app = express();
  app.use(async (req, res) => {
    const shape = req.path.slice(1);
    const identity = identityByShape[shape];
    if (!identity) { res.sendStatus(404); return; }
    try {
      const response = await fetch(upstreamBase + req.path, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      await pipeAndRecord(response, { ...prepared, url: upstreamBase + req.path }, res,
        { identity, path: '/v1/messages', model: 'synthetic-model' }, context(identity));
    } catch {
      if (!res.headersSent) res.sendStatus(500);
      else res.destroy();
    }
  });
  const proxy = createServer(app);
  const proxyBase = await listen(proxy);
  try {
    for (const [shape, body] of Object.entries(bodies)) {
      const response = await fetch(proxyBase + '/' + shape, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      assert.equal(response.status, shape === 'sse' ? 429 : shape === 'html' ? 502 : 400);
      assert.equal(response.headers.get('retry-after'), '17');
      assert.equal(await response.text(), body);
      const deadline = Date.now() + 5000;
      let stats = await listRequestStats(identityByShape[shape]!);
      while (!stats.length && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
        stats = await listRequestStats(identityByShape[shape]!);
      }
      assert.equal(stats.length, 1);
      assert.equal(stats[0]!.success, false);
      assert.match(stats[0]!.failureReason!, /\[ref: [a-f0-9-]{36}\]$/);
      if (shape === 'json') assert.match(stats[0]!.failureReason!, /max_tokens must be positive/);
      if (shape === 'sse') assert.match(stats[0]!.failureReason!, /Retry later/);
      if (shape === 'html') assert.doesNotMatch(stats[0]!.failureReason!, /private upstream/);
    }
    assert.deepEqual(calls, { json: 1, sse: 1, html: 1 });
  } finally {
    await close(proxy);
    await close(upstream);
    await closeStorage();
  }
});
