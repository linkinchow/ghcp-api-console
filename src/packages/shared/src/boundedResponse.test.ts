import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InvalidJsonResponseError,
  readBoundedJson,
  readBoundedText,
  ResponseTooLargeError,
} from './boundedResponse.js';

const encoder = new TextEncoder();

function streamed(parts: Uint8Array[], headers: Record<string, string> = {}) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[state.pulled];
      state.pulled += 1;
      if (part) controller.enqueue(part);
      else controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, { headers }), state };
}

function chunks(...texts: string[]): Uint8Array[] {
  return texts.map((text) => encoder.encode(text));
}

test('reads text and JSON within the limit', async () => {
  assert.equal(await readBoundedText(new Response('héllo'), 6), 'héllo');
  assert.deepEqual(await readBoundedJson(new Response('{"ok":true}'), 11), { ok: true });
  assert.deepEqual(await readBoundedJson(streamed(chunks('{"a":', '[1,2]}')).response, 64), { a: [1, 2] });
});

test('missing body reads as empty text and invalid JSON', async () => {
  assert.equal(await readBoundedText(new Response(null, { status: 204 }), 10), '');
  await assert.rejects(readBoundedJson(new Response(null, { status: 204 }), 10), InvalidJsonResponseError);
});

test('rejects a declared Content-Length over the limit without reading and cancels the body', async () => {
  const { response, state } = streamed(chunks('x'), { 'content-length': '11' });
  await assert.rejects(readBoundedText(response, 10), (error) => {
    return error instanceof ResponseTooLargeError && error.maxBytes === 10 && error.code === 'response_too_large';
  });
  assert.equal(state.pulled <= 1, true);
  assert.equal(state.cancelled, true);
});

test('stops streaming and cancels once the running count exceeds the limit', async () => {
  const { response, state } = streamed(chunks('12345', '67890', 'abcde', 'never'));
  await assert.rejects(readBoundedText(response, 12), ResponseTooLargeError);
  assert.equal(state.cancelled, true);
  assert.ok(state.pulled <= 4);
});

test('a lying or malformed Content-Length does not bypass the running count', async () => {
  const lying = streamed(chunks('12345', '67890'), { 'content-length': '3' });
  await assert.rejects(readBoundedText(lying.response, 8), ResponseTooLargeError);
  const malformed = streamed(chunks('12345'), { 'content-length': 'abc' });
  assert.equal(await readBoundedText(malformed.response, 5), '12345');
});

test('counts bytes rather than characters', async () => {
  await assert.rejects(readBoundedText(new Response('éé'), 3), ResponseTooLargeError);
});

test('invalid JSON and invalid UTF-8 throw InvalidJsonResponseError with a cause', async () => {
  await assert.rejects(readBoundedJson(new Response('{nope'), 64), (error) => {
    return error instanceof InvalidJsonResponseError && error.cause instanceof SyntaxError;
  });
  const badUtf8 = new Response(new Uint8Array([0x22, 0xff, 0x22]));
  await assert.rejects(readBoundedJson(badUtf8, 64), InvalidJsonResponseError);
  assert.equal(await readBoundedText(new Response(new Uint8Array([0x61, 0xff])), 64), 'a�');
});

test('a body stream error propagates unchanged', async () => {
  const failure = new Error('socket reset');
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(failure);
    },
  });
  await assert.rejects(readBoundedText(new Response(body), 64), (error) => error === failure);
});

test('rejects an invalid limit', async () => {
  await assert.rejects(readBoundedText(new Response('x'), -1), RangeError);
});
