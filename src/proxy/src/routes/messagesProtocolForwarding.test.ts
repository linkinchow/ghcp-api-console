import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DEFAULT_ENTERPRISE_ID } from '@ghcp/shared';

const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (!/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMDRIVE|NODE_TEST_CONTEXT)$/i.test(key)) delete process.env[key];
}
const root = mkdtempSync(join(tmpdir(), 'messages-protocol-test-'));
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: join(root, 'missing.env'), STORAGE_DRIVER: 'sqlite', DB_PATH: ':memory:',
  ACCOUNT_ROUTING_MODE: 'direct', API_KEY: 'synthetic-messages-client', INTERNAL_API_TOKEN: 'synthetic-internal',
  COPILOT_API_BASE_URL: 'https://messages.example.test', PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false',
});
const [{ buildApp }, { config }, { importCopilotOauthToken }, { closeStorage }] = await Promise.all([
  import('../server.js'), import('../config.js'), import('../db/accountsRepo.js'), import('../db/connection.js'),
]);
const nativeFetch = globalThis.fetch;
const identity = 'synthetic-messages-member';
const oauth = 'synthetic-messages-oauth';
const beta = 'mid-conversation-output-config-2026-07-01';
let origin = '';
let server: ReturnType<ReturnType<typeof buildApp>['listen']>;
let forceUpstreamRejection = false;
const forwarded: Array<{ path: string; headers: Headers; body: Record<string, unknown> }> = [];

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

before(async () => {
  globalThis.fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === origin) {
      assert.equal(url.pathname, '/v1/messages');
      return nativeFetch(input, options);
    }
    assert.equal(url.origin, 'https://messages.example.test', 'all real upstream and credential destinations are blocked');
    const headers = new Headers(options?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${oauth}`);
    if (url.pathname === '/models') return json({ data: [{ id: 'claude-opus-5.5', supported_endpoints: ['/v1/messages'] }] });
    assert.equal(url.pathname, '/v1/messages');
    const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
    forwarded.push({ path: url.pathname, headers, body });
    const messages = body.messages as Array<Record<string, unknown>>;
    if (forceUpstreamRejection || messages.some(message => Object.hasOwn(message, 'output_config')) && !headers.get('anthropic-beta')?.split(',').map(x => x.trim()).includes(beta)) {
      return json({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.output_config: Extra inputs are not permitted' }, request_id: 'req_synthetic_messages' }, 400);
    }
    if (body.stream === true) {
      return new Response('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_synthetic","model":"claude-opus-5.5","usage":{"input_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n', {
        status: 200, headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return json({ id: 'msg_synthetic', type: 'message', role: 'assistant', model: 'claude-opus-5.5', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  };
  await importCopilotOauthToken({
    enterpriseId: DEFAULT_ENTERPRISE_ID,
    identity,
    ssoUser: identity,
    ghLogin: 'synthetic_login',
    copilotOauthToken: oauth,
  });
  server = buildApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  globalThis.fetch = nativeFetch;
  if (server) await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
  await closeStorage();
  rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

function body(content: unknown = []): Record<string, unknown> {
  return {
    model: 'claude-opus-5-5', max_tokens: 4096, thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' },
    system: [{ type: 'text', text: "# currentDate\nToday's date is 2026-10-13.\n", cache_control: { type: 'ephemeral', scope: 'global' } }],
    messages: [
      { role: 'user', content: 'Synthetic first turn' },
      { role: 'system', content, output_config: { effort: 'high' } },
      { role: 'assistant', content: [{ type: 'text', text: 'Synthetic prior output' }] },
      { role: 'user', content: 'Synthetic follow-up' },
    ],
  };
}

async function request(payload: Record<string, unknown>, optimized: boolean, betaValue?: string) {
  const response = await fetch(`${origin}/v1/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'X-User-Identity': identity,
      'Content-Type': 'application/json', 'X-Claude-Code-Optimized': String(optimized), 'anthropic-version': '2023-06-01',
      ...(betaValue ? { 'anthropic-beta': betaValue } : {}) },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(8000),
  });
  return { status: response.status, body: await response.json() as { error?: { message?: string } } };
}

for (const optimized of [false, true]) {
  for (const content of [[], 'Operator instruction']) {
    test(`${optimized ? 'optimized' : 'plain'} Messages keeps ${Array.isArray(content) ? 'empty' : 'nonempty'} effort message paired with full beta header`, async () => {
      const payload = body(content);
      const expected = structuredClone(payload);
      const value = `${beta},future-compatible-beta-2026-10-01`;
      const response = await request(payload, optimized, value);
      assert.equal(response.status, 200);
      const captured = forwarded.at(-1)!;
      assert.equal(captured.headers.get('anthropic-beta'), value);
      assert.equal(captured.headers.get('anthropic-version'), '2023-06-01');
      assert.deepEqual(captured.body, { ...expected, model: 'claude-opus-5.5' });
      assert.deepEqual(payload, expected);
    });
  }
  test(`${optimized ? 'optimized' : 'plain'} Messages does not invent missing beta or mask provider rejection`, async () => {
    const payload = body('Operator instruction');
    const response = await request(payload, optimized);
    assert.equal(response.status, 400);
    assert.equal(response.body.error?.message, 'messages.1.output_config: Extra inputs are not permitted');
    assert.equal(forwarded.at(-1)!.headers.get('anthropic-beta'), null);
    assert.deepEqual(forwarded.at(-1)!.body.messages, payload.messages);
  });
}

test('plain legacy Messages forwards protocol headers without enabling body adaptation', async () => {
  const payload = { model: 'claude-opus-5.5', max_tokens: 8, messages: [{ role: 'user', content: 'hello' }] };
  const response = await request(payload, false, 'future-compatible-beta-2026-10-01');
  assert.equal(response.status, 200);
  assert.equal(forwarded.at(-1)!.headers.get('anthropic-beta'), 'future-compatible-beta-2026-10-01');
  assert.deepEqual(forwarded.at(-1)!.body, payload);
});

for (const optimized of [false, true]) {
  test(`${optimized ? 'optimized' : 'plain'} tool continuation remains agent initiated after an effort-only directive`, async () => {
    const payload = body();
    payload.messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_test', name: 'synthetic_tool', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_test', content: 'Synthetic result' }] },
      { role: 'system', content: [], output_config: { effort: 'high' } },
    ];
    const response = await request(payload, optimized, beta);
    assert.equal(response.status, 200);
    assert.equal(forwarded.at(-1)!.headers.get('x-initiator'), 'agent');
    assert.deepEqual(forwarded.at(-1)!.body.messages, payload.messages);
  });
  test(`${optimized ? 'optimized' : 'plain'} streaming Messages keeps protocol pairing through the final event`, async () => {
    const payload = { ...body(), model: 'claude-opus-5.5', stream: true };
    const response = await fetch(`${origin}/v1/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'X-User-Identity': identity,
        'Content-Type': 'application/json', 'X-Claude-Code-Optimized': String(optimized),
        'anthropic-version': '2023-06-01', 'anthropic-beta': beta },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(8000),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /message_stop/);
    assert.equal(forwarded.at(-1)!.headers.get('anthropic-beta'), beta);
    assert.deepEqual(forwarded.at(-1)!.body, payload);
  });
}

test('provider rejection with matching beta remains a 400, not a synthetic success', async () => {
  forceUpstreamRejection = true;
  try {
    const response = await request(body(), true, beta);
    assert.equal(response.status, 400);
    assert.equal(response.body.error?.message, 'messages.1.output_config: Extra inputs are not permitted');
  } finally { forceUpstreamRejection = false; }
});
