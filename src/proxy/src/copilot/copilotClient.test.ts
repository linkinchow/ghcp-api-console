import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import {
  clearModelsCache,
  forwardCopilotRequest,
  listModels,
  resolveCopilotModel,
  validateCopilotOauthToken,
} from './copilotClient.js';
import { config } from '../config.js';

test('uses OpenCode headers and isolates model caches by identity', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    if (String(input).endsWith('/models')) {
      return jsonResponse({ data: [{ id: `model-${requests.length}` }] });
    }
    return jsonResponse({ id: 'response' });
  };

  try {
    const alice = { identity: 'test-alice', accessToken: 'alice-token', api: 'https://api.githubcopilot.com' };
    const bob = { identity: 'test-bob', accessToken: 'bob-token', api: 'https://api.githubcopilot.com' };
    await listModels(alice);
    await listModels(alice);
    await listModels(bob);
    assert.equal(requests.length, 2);

    const refreshed = await listModels(alice, { useCache: false });
    assert.equal(requests.length, 3);
    assert.equal(refreshed[0]?.id, 'model-3');
    assert.equal((await listModels(alice))[0]?.id, 'model-3');

    await forwardCopilotRequest(alice, '/responses', { model: 'gpt-5', input: 'hello' }, {
      initiator: 'agent',
      visionRequest: true,
      interactionType: 'agent-session-name-generation',
    });

    const forward = requests[3]!;
    assert.equal(String(forward.input), 'https://api.githubcopilot.com/responses');
    const headers = new Headers(forward.init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer alice-token');
    assert.equal(headers.get('User-Agent'), config.opencodeUserAgent);
    assert.equal(headers.get('X-GitHub-Api-Version'), config.githubApiVersion);
    assert.equal(headers.get('Openai-Intent'), 'conversation-edits');
    assert.equal(headers.get('x-initiator'), 'agent');
    assert.equal(headers.get('Copilot-Vision-Request'), 'true');
    assert.equal(headers.get('X-Interaction-Type'), 'agent-session-name-generation');

    await validateCopilotOauthToken('test-import', 'candidate-token');
    const validation = requests[4]!;
    assert.equal(new Headers(validation.init?.headers).get('Authorization'), 'Bearer candidate-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cache bypass does not fall back to a stale models snapshot', async () => {
  const originalFetch = globalThis.fetch;
  const copilot = {
    identity: `cache-bypass-${Date.now()}`,
    accessToken: 'test-token',
    api: 'https://api.githubcopilot.com',
  };
  globalThis.fetch = async () => jsonResponse({ data: [{ id: 'cached-model' }] });

  try {
    await listModels(copilot);
    globalThis.fetch = async () => new Response('upstream unavailable', { status: 500 });

    await assert.rejects(
      listModels(copilot, { useCache: false }),
      /List models failed with HTTP 500/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolves canonical and dotted IDs against each identity live catalog', async () => {
  const originalFetch = globalThis.fetch;
  const copilot = {
    identity: `model-alias-${Date.now()}`,
    accessToken: 'test-token',
    api: 'https://api.githubcopilot.com',
  };
  globalThis.fetch = async () => jsonResponse({
    data: [
      { id: 'claude-opus-5.2', capabilities: { endpoints: ['/v1/messages', '/chat/completions'] } },
      { id: 'gpt-5.6-sol', capabilities: { endpoints: ['/responses'] } },
    ],
  });

  try {
    const canonical = await resolveCopilotModel(copilot, '/v1/messages', 'claude-opus-5-2');
    assert.equal(canonical.canonicalId, 'claude-opus-5-2');
    assert.equal(canonical.upstreamId, 'claude-opus-5.2');

    const dotted = await resolveCopilotModel(copilot, '/chat/completions', 'claude-opus-5.2');
    assert.equal(dotted.canonicalId, 'claude-opus-5-2');
    assert.equal(dotted.upstreamId, 'claude-opus-5.2');

    await assert.rejects(
      resolveCopilotModel(copilot, '/responses', 'claude-opus-5-2'),
      /not available on \/responses/,
    );
    await assert.rejects(
      resolveCopilotModel(copilot, '/v1/messages', 'claude-opus-5-3'),
      /Unknown Copilot model/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('does not use a stale snapshot when the refreshed catalog has canonical collisions', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const copilot = {
    identity: `collision-${Date.now()}`,
    accessToken: 'test-token',
    api: 'https://api.githubcopilot.com',
  };
  let collide = false;
  globalThis.fetch = async () => jsonResponse({
    data: collide
      ? [{ id: 'claude-opus-5.2' }, { id: 'claude-opus-5-2' }]
      : [{ id: 'claude-opus-5.2' }],
  });

  try {
    await listModels(copilot);
    collide = true;
    Date.now = () => originalNow() + 61 * 60 * 1000;
    await assert.rejects(
      resolveCopilotModel(copilot, '/v1/messages', 'claude-opus-5-2'),
      /Multiple Copilot model IDs map to canonical ID/,
    );
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});

test('model refresh 429 is not hidden by stale-cache fallback', async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  const copilot = { identity: 'rate-limited-cache-test', accessToken: 'test-token', api: 'https://api.githubcopilot.com' };
  try {
    globalThis.fetch = async () => jsonResponse({ data: [{ id: 'claude-test' }] });
    await listModels(copilot);
    Date.now = () => originalNow() + 61 * 60 * 1000;
    globalThis.fetch = async () => new Response('limited', { status: 429, headers: { 'Retry-After': '45' } });
    await assert.rejects(listModels(copilot), (error: any) => error.status === 429 && error.retryAfter === '45');
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});

test('signal-bearing catalog waiters share refresh and one cancellation leaves the other alive', async () => {
  const originalFetch = globalThis.fetch;
  const copilot = { identity: 'shared-signal', accessToken: 'shared-token', api: 'https://catalog.test' };
  const response = deferred<Response>();
  const first = new AbortController(), second = new AbortController();
  let calls = 0;
  let upstreamSignal: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    upstreamSignal = init?.signal ?? undefined;
    return response.promise;
  };
  try {
    const cancelled = listModels(copilot, { signal: first.signal });
    const survivor = resolveCopilotModel(copilot, '/responses', 'gpt-5', undefined, second.signal);
    assert.equal(calls, 1);
    assert.notEqual(upstreamSignal, first.signal);
    assert.notEqual(upstreamSignal, second.signal);
    const reason = new Error('first request disconnected');
    const rejected = assert.rejects(cancelled, (error) => error === reason);
    first.abort(reason);
    await rejected;
    assert.equal(upstreamSignal?.aborted, false);
    assert.equal(getEventListeners(first.signal, 'abort').length, 0);
    response.resolve(jsonResponse({ data: [{ id: 'gpt-5' }] }));
    assert.equal((await survivor).upstreamId, 'gpt-5');
    assert.equal(getEventListeners(second.signal, 'abort').length, 0);
    assert.deepEqual(await listModels(copilot), [{ id: 'gpt-5' }]);
    assert.equal(calls, 1);
  } finally {
    response.resolve(jsonResponse({ data: [] }));
    clearModelsCache(copilot.identity);
    globalThis.fetch = originalFetch;
  }
});

test('all signal waiters cancelling aborts upstream, removes listeners, and cannot leak or overwrite a new refresh', async () => {
  const originalFetch = globalThis.fetch;
  const copilot = { identity: 'all-signal-cancel', accessToken: 'token', api: 'https://catalog.test' };
  // Deliberately ignore transport abort to exercise late completion and detached refresh cleanup.
  const responses = [deferred<Response>(), deferred<Response>()];
  const signals: AbortSignal[] = [];
  globalThis.fetch = async (_input, init) => {
    signals.push(init!.signal!);
    return responses[signals.length - 1]!.promise;
  };
  const first = new AbortController(), second = new AbortController(), third = new AbortController();
  try {
    const a = listModels(copilot, { signal: first.signal });
    const b = listModels(copilot, { signal: second.signal });
    assert.equal(signals.length, 1);
    const aRejected = assert.rejects(a, { name: 'AbortError' });
    const bRejected = assert.rejects(b, { name: 'AbortError' });
    first.abort();
    assert.equal(signals[0]!.aborted, false);
    second.abort();
    assert.equal(signals[0]!.aborted, true);
    // Start before the abandoned fetch completes: it must use a new upstream request.
    const replacement = listModels(copilot, { signal: third.signal });
    assert.equal(signals.length, 2);
    await Promise.all([aRejected, bRejected]);
    assert.equal(getEventListeners(first.signal, 'abort').length, 0);
    assert.equal(getEventListeners(second.signal, 'abort').length, 0);
    responses[0]!.resolve(jsonResponse({ data: [{ id: 'obsolete-model' }] }));
    await nextTurn();
    const joined = listModels(copilot);
    assert.equal(signals.length, 2, 'old completion must not clear the replacement refresh');
    responses[1]!.resolve(jsonResponse({ data: [{ id: 'current-model' }] }));
    assert.deepEqual(await replacement, [{ id: 'current-model' }]);
    assert.deepEqual(await joined, [{ id: 'current-model' }]);
    assert.equal(getEventListeners(third.signal, 'abort').length, 0);
    assert.deepEqual(await listModels(copilot), [{ id: 'current-model' }]);
    assert.equal(signals.length, 2);
  } finally {
    first.abort(); second.abort(); third.abort();
    for (const response of responses) response.resolve(jsonResponse({ data: [] }));
    clearModelsCache(copilot.identity);
    globalThis.fetch = originalFetch;
  }
});

test('direct and signal callers coalesce without allowing a signal caller to cancel the direct waiter', async () => {
  const originalFetch = globalThis.fetch;
  const copilot = { identity: 'mixed-waiters', accessToken: 'token', api: 'https://catalog.test' };
  const response = deferred<Response>();
  const controller = new AbortController();
  let calls = 0;
  let upstream: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) => { calls += 1; upstream = init?.signal ?? undefined; return response.promise; };
  try {
    const direct = listModels(copilot);
    const anotherDirect = listModels(copilot, { useCache: false });
    const cancellable = listModels(copilot, { signal: controller.signal });
    const rejected = assert.rejects(cancellable, { name: 'AbortError' });
    controller.abort();
    await rejected;
    assert.equal(upstream?.aborted, false);
    assert.equal(calls, 1);
    response.resolve(jsonResponse({ data: [{ id: 'gpt-5' }] }));
    assert.deepEqual(await direct, await anotherDirect);
    assert.equal(calls, 1);
    await assert.rejects(listModels(copilot, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls, 1, 'an already aborted caller must neither fetch nor return cached data');
  } finally {
    response.resolve(jsonResponse({ data: [] }));
    clearModelsCache(copilot.identity);
    globalThis.fetch = originalFetch;
  }
});

test('refreshes and snapshots are isolated by credential and endpoint, including late completion and invalidation', async () => {
  const originalFetch = globalThis.fetch;
  const old = { identity: 'credential-rotation', accessToken: 'old-token', api: 'https://catalog.test' };
  const current = { ...old, accessToken: 'new-token' };
  const otherApi = { ...current, api: 'https://other-catalog.test' };
  const pending: Array<ReturnType<typeof deferred<Response>>> = [];
  globalThis.fetch = async () => { const response = deferred<Response>(); pending.push(response); return response.promise; };
  try {
    const a = listModels(old, { signal: new AbortController().signal });
    const b = listModels(current, { signal: new AbortController().signal });
    const c = listModels(otherApi);
    assert.equal(pending.length, 3);
    pending[1]!.resolve(jsonResponse({ data: [{ id: 'new-model' }] }));
    pending[2]!.resolve(jsonResponse({ data: [{ id: 'other-api-model' }] }));
    assert.deepEqual(await b, [{ id: 'new-model' }]);
    assert.deepEqual(await c, [{ id: 'other-api-model' }]);
    pending[0]!.resolve(jsonResponse({ data: [{ id: 'old-model' }] }));
    assert.deepEqual(await a, [{ id: 'old-model' }]);
    assert.deepEqual(await listModels(otherApi), [{ id: 'other-api-model' }]);
    assert.equal(pending.length, 3, 'old completions cannot replace the latest endpoint snapshot');
    const currentAgain = listModels(current);
    assert.equal(pending.length, 4, 'switching credential/endpoint evicts the previous idle snapshot');
    pending[3]!.resolve(jsonResponse({ data: [{ id: 'new-model' }] }));
    assert.deepEqual(await currentAgain, [{ id: 'new-model' }]);
    clearModelsCache(old.identity);
    const refreshed = [listModels(old), listModels(current), listModels(otherApi)];
    assert.equal(pending.length, 7, 'identity invalidation clears every credential and endpoint');
    pending.slice(4).forEach((response, index) => response.resolve(jsonResponse({ data: [{ id: `fresh-${index}` }] })));
    await Promise.all(refreshed);
  } finally {
    for (const response of pending) response.resolve(jsonResponse({ data: [] }));
    clearModelsCache(old.identity);
    globalThis.fetch = originalFetch;
  }
});

test('credential rotation prunes old snapshots without aborting or duplicating live old refreshes', async () => {
  const originalFetch = globalThis.fetch;
  const old = { identity: 'prune-credentials', accessToken: 'old-token', api: 'https://catalog.test' };
  const current = { ...old, accessToken: 'new-token' };
  const pending: Array<ReturnType<typeof deferred<Response>>> = [];
  const signals: AbortSignal[] = [];
  globalThis.fetch = async (_input, init) => {
    const response = deferred<Response>();
    pending.push(response); signals.push(init!.signal!);
    return response.promise;
  };
  try {
    const oldWaiter = listModels(old);
    const newWaiter = listModels(current);
    const joinedOld = listModels(old);
    assert.equal(pending.length, 2, 'retired live refreshes remain joinable by the same credential');
    assert.equal(signals[0]!.aborted, false);
    assert.equal(signals[1]!.aborted, false);
    // Mark the new credential current again without another upstream request.
    const joinedNew = listModels(current);
    pending[1]!.resolve(jsonResponse({ data: [{ id: 'new-model' }] }));
    assert.deepEqual(await newWaiter, [{ id: 'new-model' }]);
    assert.deepEqual(await joinedNew, [{ id: 'new-model' }]);
    pending[0]!.resolve(jsonResponse({ data: [{ id: 'old-model' }] }));
    assert.deepEqual(await oldWaiter, [{ id: 'old-model' }]);
    assert.deepEqual(await joinedOld, [{ id: 'old-model' }]);
    assert.deepEqual(await listModels(current), [{ id: 'new-model' }]);
    const oldAgain = listModels(old);
    assert.equal(pending.length, 3, 'the completed retired refresh did not retain its snapshot');
    pending[2]!.resolve(jsonResponse({ data: [{ id: 'revalidated-old-model' }] }));
    await oldAgain;
  } finally {
    pending.forEach((response) => response.resolve(jsonResponse({ data: [] })));
    clearModelsCache(old.identity);
    globalThis.fetch = originalFetch;
  }
});

test('a new credential cannot fall back to the old credential stale snapshot after refresh failure', async () => {
  const originalFetch = globalThis.fetch;
  const old = { identity: 'credential-failure', accessToken: 'old-token', api: 'https://catalog.test' };
  try {
    globalThis.fetch = async () => jsonResponse({ data: [{ id: 'old-model' }] });
    await listModels(old);
    globalThis.fetch = async () => new Response('unavailable', { status: 500 });
    await assert.rejects(listModels({ ...old, accessToken: 'new-token' }), /List models failed with HTTP 500/);
    await assert.rejects(listModels(old), /List models failed with HTTP 500/, 'retired credentials cannot reuse a pruned snapshot');
  } finally { clearModelsCache(old.identity); globalThis.fetch = originalFetch; }
});

test('a cancelled waiter never falls back to stale data while a surviving waiter still can', async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  const copilot = { identity: 'cancel-stale-fallback', accessToken: 'token', api: 'https://catalog.test' };
  const response = deferred<Response>();
  const controller = new AbortController();
  try {
    globalThis.fetch = async () => jsonResponse({ data: [{ id: 'stale-model' }] });
    await listModels(copilot);
    Date.now = () => originalNow() + 61 * 60 * 1000;
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return response.promise; };
    const cancelled = listModels(copilot, { signal: controller.signal });
    const survivor = listModels(copilot, { signal: new AbortController().signal });
    const rejection = assert.rejects(cancelled, { name: 'AbortError' });
    controller.abort();
    await rejection;
    response.resolve(new Response('unavailable', { status: 500 }));
    assert.deepEqual(await survivor, [{ id: 'stale-model' }]);
    assert.equal(calls, 1);
  } finally {
    response.resolve(jsonResponse({ data: [] }));
    Date.now = originalNow;
    clearModelsCache(copilot.identity);
    globalThis.fetch = originalFetch;
  }
});

test('catalog refresh deadline releases waiters and permits retry even when transport ignores abort', async (t) => {
  const originalFetch = globalThis.fetch;
  const copilot = { identity: 'refresh-deadline', accessToken: 'token', api: 'https://catalog.test' };
  const response = deferred<Response>();
  const controller = new AbortController();
  let upstream: AbortSignal | undefined;
  let calls = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.fetch = async (_input, init) => {
    calls += 1; upstream = init?.signal ?? undefined;
    return calls === 1 ? response.promise : jsonResponse({ data: [{ id: 'retry-model' }] });
  };
  try {
    const a = listModels(copilot, { signal: controller.signal });
    const b = listModels(copilot);
    const failed = [assert.rejects(a, /refresh timed out/), assert.rejects(b, /refresh timed out/)];
    t.mock.timers.tick(30_000);
    await Promise.all(failed);
    assert.equal(upstream?.aborted, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.deepEqual(await listModels(copilot), [{ id: 'retry-model' }]);
    response.resolve(jsonResponse({ data: [{ id: 'late-model' }] }));
    await nextTurn();
    assert.deepEqual(await listModels(copilot), [{ id: 'retry-model' }]);
    assert.equal(calls, 2);
  } finally {
    response.resolve(jsonResponse({ data: [] }));
    t.mock.timers.reset();
    clearModelsCache(copilot.identity);
    globalThis.fetch = originalFetch;
  }
});

test('all waiters cancelling while reading a catalog body cancels the stream and leaves no refresh', async () => {
  const originalFetch = globalThis.fetch;
  const copilot = { identity: 'cancel-body', accessToken: 'token', api: 'https://catalog.test' };
  const reading = deferred<void>();
  const first = new AbortController(), second = new AbortController();
  let cancelled = 0;
  let calls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull() { reading.resolve(); },
    cancel() { cancelled += 1; },
  });
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1 ? new Response(body) : jsonResponse({ data: [{ id: 'retry-model' }] });
  };
  try {
    const a = listModels(copilot, { signal: first.signal });
    const b = listModels(copilot, { signal: second.signal });
    await reading.promise;
    const rejected = [assert.rejects(a, { name: 'AbortError' }), assert.rejects(b, { name: 'AbortError' })];
    first.abort();
    assert.equal(cancelled, 0);
    second.abort();
    await Promise.all(rejected);
    await nextTurn();
    assert.equal(cancelled, 1);
    assert.equal(body.locked, false);
    assert.deepEqual(await listModels(copilot), [{ id: 'retry-model' }]);
    assert.equal(calls, 2);
  } finally {
    first.abort(); second.abort();
    clearModelsCache(copilot.identity);
    globalThis.fetch = originalFetch;
  }
});

test('oversized catalog bodies are bounded, cancelled, and not cached', async () => {
  const originalFetch = globalThis.fetch;
  const copilot = { identity: 'oversized-catalog', accessToken: 'token', api: 'https://catalog.test' };
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); },
    cancel() { cancelled += 1; },
  });
  try {
    globalThis.fetch = async () => new Response(body);
    await assert.rejects(listModels(copilot), /response exceeds 8 MiB/);
    assert.equal(cancelled, 1);
    assert.equal(body.locked, false);
    globalThis.fetch = async () => jsonResponse({ data: [{ id: 'retry-model' }] });
    assert.deepEqual(await listModels(copilot), [{ id: 'retry-model' }]);
  } finally { clearModelsCache(copilot.identity); globalThis.fetch = originalFetch; }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
