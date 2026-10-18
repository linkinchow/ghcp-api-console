import assert from 'node:assert/strict';
import test from 'node:test';
import { ExternalRequestFailedError, externalFetch, OutcomeUnknownError } from './externalFetch.js';

interface Call {
  url: string;
  init: RequestInit;
}

function recordingFetch(respond: (init: RequestInit) => Promise<Response>) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return respond(init);
  };
  return { calls, fetcher };
}

function rejectOnAbort(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  });
}

function socketError(code: string): TypeError {
  const cause = Object.assign(new Error(`connect ${code}`), { code });
  return new TypeError('fetch failed', { cause });
}

function notSent(reason: string) {
  return (error: unknown) => error instanceof ExternalRequestFailedError && error.reason === reason;
}

function unknownOutcome(reason: string) {
  return (error: unknown) => error instanceof OutcomeUnknownError && error.reason === reason;
}

test('forces redirect error and a signal, passing the rest of init through', async () => {
  const { calls, fetcher } = recordingFetch(async () => new Response('ok'));
  const init = { method: 'POST', body: 'x', redirect: 'follow', fetcher } as RequestInit & { fetcher: typeof fetch };
  const response = await externalFetch('https://api.github.com/user', init);
  assert.equal(await response.text(), 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://api.github.com/user');
  assert.equal(calls[0]!.init.redirect, 'error');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.ok(calls[0]!.init.signal instanceof AbortSignal);
  assert.equal('fetcher' in calls[0]!.init, false);
});

test('an HTTP error status is returned, not thrown', async () => {
  const { fetcher } = recordingFetch(async () => new Response('no', { status: 503 }));
  assert.equal((await externalFetch('https://example.test/', { fetcher })).status, 503);
});

test('invalid URLs and non-http schemes are rejected before fetch is called', async () => {
  const { calls, fetcher } = recordingFetch(async () => new Response('ok'));
  await assert.rejects(externalFetch('not a url', { fetcher }), notSent('invalid_url'));
  await assert.rejects(externalFetch('file:///etc/passwd', { fetcher }), notSent('invalid_url'));
  assert.equal(calls.length, 0);
});

test('an already aborted caller signal is reported as not sent', async () => {
  const { calls, fetcher } = recordingFetch(async () => new Response('ok'));
  const signal = AbortSignal.abort(new Error('cancelled'));
  await assert.rejects(externalFetch('https://example.test/', { fetcher, signal }), notSent('aborted'));
  assert.equal(calls.length, 0);
});

test('connection failures are reported as not sent', async () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT']) {
    const { fetcher } = recordingFetch(async () => Promise.reject(socketError(code)));
    await assert.rejects(externalFetch('https://example.test/', { fetcher }), notSent('connect_failed'));
  }
});

test('other network failures leave the outcome unknown', async () => {
  for (const failure of [socketError('ECONNRESET'), new TypeError('fetch failed')]) {
    const { fetcher } = recordingFetch(async () => Promise.reject(failure));
    await assert.rejects(externalFetch('https://example.test/', { fetcher }), (error) => {
      return unknownOutcome('network')(error) && (error as Error).cause === failure;
    });
  }
});

test('a timeout while waiting leaves the outcome unknown', async () => {
  const { fetcher } = recordingFetch(rejectOnAbort);
  await assert.rejects(externalFetch('https://example.test/', { fetcher, timeoutMs: 10 }), unknownOutcome('timeout'));
});

test('a caller abort in flight leaves the outcome unknown', async () => {
  const { fetcher } = recordingFetch(rejectOnAbort);
  const controller = new AbortController();
  const pending = externalFetch('https://example.test/', { fetcher, signal: controller.signal, timeoutMs: 60_000 });
  controller.abort(new Error('shutdown'));
  await assert.rejects(pending, unknownOutcome('aborted'));
});
