// Offline runner-contract tests; importing the runner performs no network I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { backendDelta, callerHash, check, main, parseSse, parseStats, safeFailure, success } from './litellm-mysql-smoke.mjs';

const csv = (a = 4, b = 7, state = 'UP') => `# pxname,svname,status,hrsp_2xx,description,\nproxies,proxy,UP,${a},"first, replica",\nproxies,proxy2,${state},${b},second,\nproxies,BACKEND,UP,999,summary,\n`;
test('CSV counter proof requires BOTH servers and exactly one business success per request', () => {
  assert.deepEqual(parseStats(csv()), { proxy: 4, proxy2: 7 });
  assert.deepEqual(backendDelta(parseStats(csv()), parseStats(csv(7, 10)), 6), { proxy: 3, proxy2: 3 });
  assert.throws(() => backendDelta({ proxy: 4, proxy2: 7 }, { proxy: 10, proxy2: 7 }, 6), /both_backends/);
  assert.throws(() => backendDelta({ proxy: 4, proxy2: 7 }, { proxy: 8, proxy2: 10 }, 6), /concurrent_traffic_or_http_replay/);
  assert.throws(() => parseStats(csv(4, 7, 'DOWN')), /not_up/);
  assert.throws(() => parseStats(csv().replace('proxies,proxy2', 'other,proxy2')), /two_haproxy/);
  assert.throws(() => parseStats(csv().replace('4,', 'NaN,')), /not_up/);
});
test('Caller identity is EXACT lowercase SHA256(raw virtual key), not alias', () => {
  const raw = 'sk-synthetic-offline-only';
  assert.equal(callerHash(raw), `sha256:${createHash('sha256').update(raw).digest('hex')}`);
  assert.match(callerHash(raw), /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(callerHash(raw), callerHash('same-alias'));
});
test('SSE validates terminal events, text, version and in-band failures', () => {
  const response = events => ({ status: 200, headers: new Headers({ 'content-type': 'text/event-stream', 'x-litellm-version': '1.99.1' }),
    text: events.map(event => `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\r\n\r\n`).join('') });
  const messages = [
    { type: 'message_start', message: { model: 'claude-opus-5-2' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } },
    { type: 'message_stop' },
  ];
  success(response(messages), 'messages', true);
  assert.throws(() => success(response(messages.slice(0, 2)), 'messages', true), /terminal/);
  assert.throws(() => success(response([...messages, { type: 'error', error: { code: 'synthetic' } }]), 'messages', true), /in_band/);
  const chat = [{ model: 'claude-opus-5-2', choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }, '[DONE]'];
  success(response(chat), 'chat', true);
  assert.throws(() => success(response(chat.slice(0, 1)), 'chat', true), /terminal/);
  assert.throws(() => parseSse('data: {not json}\n\n'), /invalid_json_sse_frame/);
});
test('Untrusted failures never escape as response text or raw key', () => {
  assert.equal(safeFailure(new Error('sk-do-not-print')), 'unexpected_fixture_or_transport_failure');
  assert.equal(safeFailure({ fixtureCheck: true, message: 'sk-do-not-print' }), 'unexpected_fixture_or_transport_failure');
  try { check(false, 'expected_contract_failure'); } catch (error) { assert.equal(safeFailure(error), 'expected_contract_failure'); }
});
test('Help and refusal perform no requests and print no credentials', async () => {
  const originalFetch = globalThis.fetch, log = console.log, error = console.error, output = [];
  globalThis.fetch = () => { throw new Error('unexpected network call'); };
  console.log = console.error = text => output.push(text);
  try {
    assert.equal(await main(['--help']), 0);
    assert.equal(await main([]), 1);
    assert.equal(await main(['--confirm-local-fixture', '--litellm-url=https://production.invalid']), 1);
  } finally { globalThis.fetch = originalFetch; console.log = log; console.error = error; }
  assert.ok(output.some(line => line.includes('Usage:')));
  assert.ok(output.some(line => line.includes('explicit_local_fixture_confirmation_required')));
  assert.ok(output.every(line => !/sk-[A-Za-z0-9_-]+/.test(line)));
});
