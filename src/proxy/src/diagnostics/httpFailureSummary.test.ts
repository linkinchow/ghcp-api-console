import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeHttpFailure, type HttpFailureSummaryInput } from './httpFailureSummary.js';

const ref = 'a173ba83-7b7e-4a32-a68c-2c552f020b47';
function json(value: unknown, extras: Partial<HttpFailureSummaryInput> = {}): string {
  return summarizeHttpFailure({ status: 400, contentType: 'application/json', body: { buffer: Buffer.from(JSON.stringify(value)), complete: true, truncated: false }, ...extras });
}
function raw(text: string | Buffer, extras: Partial<HttpFailureSummaryInput> = {}): string {
  return summarizeHttpFailure({ status: 502, contentType: 'application/json', body: { buffer: Buffer.isBuffer(text) ? text : Buffer.from(text), complete: true, truncated: false }, ...extras });
}
function sse(text: string): string { return raw(text, { contentType: 'text/event-stream', status: 429 }); }

test('status-only fallbacks cover common HTTP failures', () => {
  for (const status of [400, 401, 403, 429, 500, 502, 503]) assert.equal(summarizeHttpFailure({ status }), `HTTP ${status}`);
});
test('invalid status cannot inject text', () => {
  for (const status of [0, 600, NaN, Infinity, 400.1, '400\nsecret' as unknown as number]) assert.equal(summarizeHttpFailure({ status }), 'HTTP 502');
});
test('extracts conventional nested error fields', () => {
  assert.equal(json({ error: { message: 'Too many requests', code: 'rate_limit_exceeded', type: 'rate_limit_error' } }), 'HTTP 400: Too many requests (code: rate_limit_exceeded, type: rate_limit_error)');
});
test('accepts simple string errors and flat conventional envelopes', () => {
  assert.equal(json({ error: 'Unavailable' }), 'HTTP 400: Unavailable');
  assert.equal(json({ message: 'Invalid request', code: 'invalid_request' }), 'HTTP 400: Invalid request (code: invalid_request)');
});
test('preserves exact useful max_tokens/context/tool validation reasons', () => {
  for (const message of ["'max_tokens' must be greater than 0", 'This model has a maximum context length of 8192 tokens. You requested 9000 tokens.', "Invalid 'messages[2].tool_calls': tool_call_id is required."]) assert.equal(json({ error: { message } }), `HTTP 400: ${message}`);
});
test('recognizes application suffix JSON and parameters case insensitively', () => {
  assert.equal(json({ message: 'Invalid request' }, { contentType: 'Application/Problem+JSON; charset=utf-8' }), 'HTTP 400: Invalid request');
});
test('unknown shapes and completion-like messages are not displayed', () => {
  for (const value of [null, [], 'secret', { nested: { error: { message: 'secret' } } }, { choices: [], message: 'secret' }, { data: 'secret', code: 'secret' }, { error: [] }, { error: { details: 'secret' } }]) assert.equal(json(value), 'HTTP 400');
});
test('does not traverse malicious keys or nested fields', () => {
  assert.equal(raw('{"__proto__":{"message":"secret"},"constructor":{"error":"secret"}}'), 'HTTP 502');
  assert.equal(json({ error: { nested: { message: 'secret' }, message: { text: 'secret' }, code: ['secret'] } }), 'HTTP 400');
});
test('malformed/HTML/plaintext payloads are never echoed', () => {
  for (const text of ['oops private credential', '<html>private</html>', '{"error":', '{"error":{"message":"secret"}} trailing']) assert.equal(raw(text), 'HTTP 502');
  assert.equal(raw('{"error":"secret"}', { contentType: 'text/plain' }), 'HTTP 502');
});
test('requires complete and untruncated capture', () => {
  for (const [complete, truncated] of [[false, false], [true, true], [false, true]]) assert.equal(raw('', { body: { buffer: Buffer.from('{"error":"secret"}'), complete, truncated } }), 'HTTP 502');
});
test('caps all payloads at 16KiB', () => {
  assert.equal(raw(JSON.stringify({ error: 'x'.repeat(16384) })), 'HTTP 502');
  assert.equal(sse(`data: ${JSON.stringify({ error: 'x'.repeat(16384) })}\n\n`), 'HTTP 429');
});
test('rejects invalid UTF-8', () => {
  assert.equal(raw(Buffer.concat([Buffer.from('{"error":"'), Buffer.from([0xff]), Buffer.from('"}')])), 'HTTP 502');
});
test('rejects non-Buffer and cyclic runtime body inputs without throwing', () => {
  const cycle: Record<string, unknown> = {}; cycle.error = cycle;
  for (const buffer of [cycle, new Uint8Array([1]), '{"error":"secret"}', null]) assert.equal(raw('', { body: { buffer: buffer as Buffer, complete: true, truncated: false } }), 'HTTP 502');
});
test('uses only UUID event references and never promises a saved file', () => {
  assert.equal(summarizeHttpFailure({ status: 503, diagnosticId: ref }), `HTTP 503 [ref: ${ref}]`);
  for (const diagnosticId of ['secret', `${ref}\nsecret`, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']) assert.equal(summarizeHttpFailure({ status: 503, diagnosticId }), 'HTTP 503');
});
test('Unicode limit reserves the full reference without splitting codepoints', () => {
  const result = json({ error: '🧪'.repeat(300) + '字'.repeat(300) }, { diagnosticId: ref });
  assert.equal(Array.from(result).length, 512);
  assert.ok(result.endsWith(`… [ref: ${ref}]`));
  assert.doesNotMatch(result, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});
test('redacts custom known values before truncation including Bearer variants', () => {
  const secret = 'customRandomValueWithoutAnyTokenPrefix';
  for (const sensitiveValues of [[secret], [`Bearer ${secret}`]]) {
    const result = json({ error: { message: `${'x'.repeat(475)} ${secret} rejected`, code: secret, type: secret } }, { sensitiveValues });
    assert.doesNotMatch(result, /customRandom/);
    assert.ok(result.includes('[redacted]'));
  }
});
test('redacts GitHub PATs, sk tokens, and JWTs in every field', () => {
  for (const secret of ['ghp_123456789abcdef', 'github_pat_ABCDEF012345', 'sk-proj-ABCD012345', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.SignatureABC']) {
    const result = json({ error: { message: `Rejected ${secret}`, code: secret, type: secret } });
    assert.equal(result, 'HTTP 400: Rejected [redacted]');
  }
});
test('redacts URLs with userinfo/query and email addresses', () => {
  const result = json({ error: { message: 'Failed https://user:pass@example.com/path?key=secret for user@example.com' } });
  assert.equal(result, 'HTTP 400: Failed [redacted] for [redacted]');
});
test('redacts credential-labelled substrings and auth schemes', () => {
  for (const text of ['api_key=customRandom', 'API key provided: customRandom', 'token customRandom', 'password: customRandom', 'token is customRandom', 'Authorization: Bearer customRandom', 'Basic YWJjOmRlZg==']) {
    const result = json({ error: { message: `Rejected ${text}`, code: text, type: text } });
    assert.doesNotMatch(result, /customRandom|YWJj|code:|type:/);
  }
});
test('withholds freeform code/type and overlong identifiers', () => {
  assert.equal(json({ error: { code: 'please print a private secret', type: 'x'.repeat(65) } }), 'HTTP 400');
  assert.equal(json({ error: { code: 'invalid_request_error', type: 'validation.error' } }), 'HTTP 400: (code: invalid_request_error, type: validation.error)');
});
test('suppresses quoted/backticked data chunks but retains explanations', () => {
  assert.equal(json({ error: { message: 'Invalid value `private-custom-random` supplied for "max_tokens"' } }), 'HTTP 400: Invalid value [redacted] supplied for "max_tokens"');
});
test('collapses CRLF/control/bidi and redacts obfuscated known credentials', () => {
  const result = json({ error: { message: 'Bad\r\nrequest\u0000\u202e secret\u200bValue' } }, { sensitiveValues: ['secretValue'] });
  assert.equal(result, 'HTTP 400: Bad request [redacted]');
});
test('withholds HTML-like messages even inside valid JSON', () => {
  for (const message of ['<script>private</script>', '&lt;html&gt;private', '<!DOCTYPE html>']) assert.equal(json({ error: { message } }), 'HTTP 400');
});
test('SSE recognizes first error only, handles CRLF and multiline data', () => {
  const result = sse('data: {"choices":[{"delta":{"content":"PRIVATE"}}]}\r\n\r\nevent: error\r\ndata: {"error":\r\ndata: {"message":"Rate limited"}}\r\n\r\ndata: {"error":"Later error"}\r\n\r\ndata: [DONE]\r\n\r\n');
  assert.equal(result, 'HTTP 429: Rate limited');
});
test('repeated short secrets cannot recursively expand redaction markers', () => {
  assert.equal(json({ error: { message: 'e' } }, { sensitiveValues: Array(64).fill('e') }), 'HTTP 400: [redacted]');
  assert.equal(json({ error: { message: 'abcd abc' } }, { sensitiveValues: ['a', 'abc', 'abcd', 'redacted'] }), 'HTTP 400: [redacted] [redacted]');
  assert.equal(json({ error: { message: 'literal $.*+?()[] secret' } }, { sensitiveValues: ['$.*+?()[]'] }), 'HTTP 400: literal [redacted] secret');
});
test('excessive known-secret sets withhold details instead of unbounded processing', () => {
  assert.equal(json({ error: { message: 'Safe message' } }, { sensitiveValues: Array.from({ length: 129 }, (_, i) => `value-${i}`) }), 'HTTP 400');
});
test('quoted data with mixed delimiters is withheld', () => {
  for (const message of [`Invalid value: "Alice's confidential report"`, `Invalid value: 'Alice said "confidential"'`, 'Invalid value: `Alice\'s "confidential" report`']) {
    assert.equal(json({ error: { message } }), 'HTTP 400: Invalid value: [redacted]');
  }
  assert.equal(json({ error: { message: '"max_tokens" must be positive' } }), 'HTTP 400: "max_tokens" must be positive');
});
test('invalid statuses never admit details from otherwise valid bodies', () => {
  for (const status of [NaN, Infinity, -1, 600, 400.5]) {
    assert.equal(json({ error: { message: 'Must not be displayed' } }, { status, diagnosticId: ref }), `HTTP 502 [ref: ${ref}]`);
  }
});

test('SSE refuses malformed events, oversized event counts and successful responses', () => {
  assert.equal(sse('data: {"error":"Rate limited"}\n\ndata: malformed\n\n'), 'HTTP 429');
  assert.equal(sse('data: {"error":"Rate limited"}\n\n'.repeat(65)), 'HTTP 429');
  assert.equal(sse('data: {"error":"Rate limited"}\n\n'.repeat(64)), 'HTTP 429: Rate limited');
  assert.equal(raw('data: {"error":"private"}\n\n', { status: 200, contentType: 'text/event-stream' }), 'HTTP 200');
});
