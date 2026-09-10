import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSuccessfulJson, StreamCompletion } from './responseCompletion.js';

function stream(path: string, text: string): boolean {
  const completion = new StreamCompletion(path);
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length; offset += 7) completion.add(bytes.subarray(offset, offset + 7));
  return completion.finish();
}

test('only well-formed non-error JSON counts as pool success', () => {
  assert.equal(isSuccessfulJson('{"content":[{"text":"ok"}]}'), true);
  for (const text of ['', 'not JSON', 'null', '[]', '{"error":{"message":"denied"}}', '{"status":"incomplete"}', '{"type":"error"}']) {
    assert.equal(isSuccessfulJson(text), false, text);
  }
});

test('Anthropic streams require message_stop and reject in-band errors and incomplete EOF', () => {
  assert.equal(stream('/v1/messages', 'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\ndata: [DONE]\r\n\r\n'), true);
  assert.equal(stream('/v1/messages', 'data: [DONE]\n\n'), false);
  assert.equal(stream('/v1/messages', 'data: {"type":"message_delta"}\n\n'), false);
  assert.equal(stream('/v1/messages', 'data: {"type":"message_stop"}'), false);
  assert.equal(stream('/v1/messages', 'event: error\ndata: {"error":{"message":"busy"}}\n\ndata: {"type":"message_stop"}\n\n'), false);
});

test('Responses streams require successful response.completed', () => {
  assert.equal(stream('/responses', 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'), true);
  assert.equal(stream('/responses', 'data: {"type":"response.incomplete"}\n\ndata: [DONE]\n\n'), false);
  assert.equal(stream('/responses', 'data: {"type":"response.completed","response":{"status":"failed"}}\n\n'), false);
});

test('chat streams require DONE and do not hide earlier errors', () => {
  assert.equal(stream('/chat/completions', ': ping\n\ndata: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n'), true);
  assert.equal(stream('/chat/completions', 'data: {"choices":[]}\n\n'), false);
  assert.equal(stream('/chat/completions', 'data: {"error":"failed"}\n\ndata: [DONE]\n\n'), false);
  assert.equal(stream('/chat/completions', 'data: not-json\n\ndata: [DONE]\n\n'), false);
});
