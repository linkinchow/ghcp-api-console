import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';

import { config } from '../config.js';
import { importCopilotOauthToken } from '../db/accountsRepo.js';
import { closeStorage } from '../db/connection.js';
import { listRequestStats, recordRequestStat } from '../db/requestStatsRepo.js';
import { buildApp } from '../server.js';

const identity = `model-route-${Date.now()}`;
const apiKey = 'route-test-api-key';
const upstreamBodies: Array<{ path: string; body: Record<string, unknown> }> = [];
const originalFetch = globalThis.fetch;
const originalConfig = {
  apiKey: config.apiKey,
  dbPath: config.dbPath,
  requestStatsPerAccountLimit: config.requestStatsPerAccountLimit,
  claudeCodeOptimized: config.claudeCodeOptimized,
};

before(async () => {
  config.apiKey = apiKey;
  config.dbPath = ':memory:';
  config.requestStatsPerAccountLimit = 100;
  config.claudeCodeOptimized = true;
  await importCopilotOauthToken({
    identity,
    ssoUser: identity,
    ghLogin: `${identity}_test`,
    copilotOauthToken: 'test-oauth-token',
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/models') {
      return jsonResponse({
        data: [
          {
            id: 'claude-opus-5.2',
            version: 'claude-opus-5.2',
            name: 'Claude Opus 5.2',
            capabilities: { endpoints: ['/v1/messages', '/chat/completions', '/responses'] },
          },
          { id: 'gpt-4.1', name: 'GPT-4.1', capabilities: { endpoints: ['/chat/completions'] } },
        ],
      });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    upstreamBodies.push({ path: url.pathname, body });
    if (body.stream === true) {
      return new Response(
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5.2","id":"msg-test"}}\n\n'
          + 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
          + 'data: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    return jsonResponse({ id: 'response', model: 'claude-opus-5.2', content: [{ type: 'text', text: 'ok' }] });
  };
});

after(async () => {
  globalThis.fetch = originalFetch;
  await closeStorage();
  Object.assign(config, originalConfig);
});

test('advertises canonical Claude IDs in both model-list modes', async () => {
  await withServer(async (baseUrl) => {
    const optimized = await request(baseUrl, '/v1/models');
    assert.equal(optimized.status, 200);
    assert.deepEqual(optimized.body.data.map((model: { id: string }) => model.id), ['claude-opus-5-2']);
    assert.equal(optimized.body.first_id, 'claude-opus-5-2');
    assert.equal(optimized.body.last_id, 'claude-opus-5-2');

    const all = await request(baseUrl, '/v1/models', { 'X-Claude-Code-Optimized': 'false' });
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.data.map((model: { id: string }) => model.id), ['claude-opus-5-2', 'gpt-4.1']);
    assert.equal(all.body.data[0].version, 'claude-opus-5.2');
  });
});

test('all POST routes accept canonical and dotted aliases and send the live raw ID upstream', async () => {
  await withServer(async (baseUrl) => {
    const cases = [
      { path: '/v1/messages', model: 'claude-opus-5-2', optimized: 'false' },
      { path: '/v1/messages', model: 'claude-opus-5.2', optimized: 'true' },
      { path: '/chat/completions', model: 'claude-opus-5-2', optimized: 'false' },
      { path: '/responses', model: 'claude-opus-5-2', optimized: 'true' },
    ];
    for (const item of cases) {
      const result = await request(baseUrl, item.path, { 'X-Claude-Code-Optimized': item.optimized }, {
        model: item.model,
        messages: [{ role: 'user', content: 'hi' }],
        input: 'hi',
        max_tokens: 8,
      });
      assert.equal(result.status, 200, `${item.path} ${item.model}`);
      assert.equal(result.body.model, 'claude-opus-5-2');
    }
  });

  assert.deepEqual(upstreamBodies.map(({ path, body }) => ({ path, model: body.model })), [
    { path: '/v1/messages', model: 'claude-opus-5.2' },
    { path: '/v1/messages', model: 'claude-opus-5.2' },
    { path: '/chat/completions', model: 'claude-opus-5.2' },
    { path: '/responses', model: 'claude-opus-5.2' },
  ]);

  const stats = await listRequestStats(identity, 20);
  const routed = stats.filter((stat) => stat.path !== '/v1/models');
  assert.equal(routed.length, 4);
  assert.ok(routed.every((stat) => stat.model === 'claude-opus-5-2'));
});

test('canonicalizes model metadata in streaming responses', async () => {
  await withServer(async (baseUrl) => {
    const response = await originalFetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-User-Identity': identity,
        'X-Claude-Code-Optimized': 'true',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-opus-5-2',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 8,
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"model":"claude-opus-5-2"/);
    assert.doesNotMatch(text, /"model":"claude-opus-5\.2"/);
    assert.match(text, /"id":"msg-test"/);
    assert.doesNotMatch(text, /\[DONE\]/);
  });
});

test('canonicalizes new and historical request-stat model values at the repository boundary', async () => {
  const statsIdentity = `${identity}-stats`;
  await recordRequestStat({
    identity: statsIdentity,
    path: '/v1/messages',
    model: 'claude-opus-5-2-20260101',
    success: true,
  });
  const stats = await listRequestStats(statsIdentity, 10);
  assert.equal(stats[0]?.model, 'claude-opus-5-2');
});

test('does not invent availability for a canonical-looking model absent from the live catalog', async () => {
  const upstreamCount = upstreamBodies.length;
  await withServer(async (baseUrl) => {
    const result = await request(baseUrl, '/v1/messages', { 'X-Claude-Code-Optimized': 'false' }, {
      model: 'claude-opus-5-3',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error.message, /Unknown Copilot model/);
  });
  assert.equal(upstreamBodies.length, upstreamCount);
});

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = buildApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function request(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {},
  body?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const response = await originalFetch(`${baseUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'X-User-Identity': identity,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
