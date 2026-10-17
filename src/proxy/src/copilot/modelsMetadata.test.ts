import assert from 'node:assert/strict';
import test from 'node:test';
import { clearModelsCache, CopilotApiError, listModelsWithMetadata } from './copilotClient.js';

const API = 'https://models.example.test';

function catalogResponse(): Response {
  return new Response(JSON.stringify({ data: [{ id: 'synthetic-model' }] }), { status: 200 });
}

test('catalog metadata distinguishes fresh, cached, forced and stale without inventing fetch times', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const auth = { identity: 'synthetic-models-metadata', accessToken: 'synthetic-secret', api: API };
  let now = 1_800_000_000_000;
  let calls = 0;
  Date.now = () => now;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), `${API}/models`);
    calls++;
    return catalogResponse();
  };
  try {
    const fresh = await listModelsWithMetadata(auth);
    assert.equal(fresh.cacheStatus, 'fresh');
    assert.equal(fresh.fetchedAt, now);

    now += 1000;
    const cached = await listModelsWithMetadata(auth);
    assert.equal(cached.cacheStatus, 'cached');
    assert.equal(cached.fetchedAt, fresh.fetchedAt);
    assert.equal(calls, 1);

    const forced = await listModelsWithMetadata(auth, { useCache: false });
    assert.equal(forced.cacheStatus, 'fresh');
    assert.equal(forced.fetchedAt, now);
    assert.equal(calls, 2);

    // Past the cache TTL with a failing upstream: the old snapshot is served and labelled stale.
    now += 3_600_001;
    globalThis.fetch = async () => new Response('synthetic failure', { status: 500 });
    const stale = await listModelsWithMetadata(auth);
    assert.equal(stale.cacheStatus, 'stale');
    assert.equal(stale.fetchedAt, forced.fetchedAt);

    await assert.rejects(
      listModelsWithMetadata(auth, { useCache: false }),
      (error: unknown) => error instanceof CopilotApiError && error.status === 500,
    );
    for (const status of [401, 403, 429]) {
      globalThis.fetch = async () => new Response('synthetic failure', { status });
      await assert.rejects(
        listModelsWithMetadata(auth),
        (error: unknown) => error instanceof CopilotApiError && error.status === status,
      );
    }
  } finally {
    clearModelsCache(auth.identity);
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

for (const status of [401, 403]) {
  test(`authorization rejection ${status} removes the still-fresh snapshot`, async () => {
    const originalFetch = globalThis.fetch;
    const auth = { identity: `synthetic-admin-rejected-${status}`, accessToken: 'synthetic-private-token', api: API };
    let calls = 0;
    try {
      globalThis.fetch = async () => {
        calls++;
        return catalogResponse();
      };
      await listModelsWithMetadata(auth);

      globalThis.fetch = async () => {
        calls++;
        return new Response('rejected', { status });
      };
      const rejected = (error: unknown) => error instanceof CopilotApiError && error.status === status;
      await assert.rejects(listModelsWithMetadata(auth, { useCache: false }), rejected);
      await assert.rejects(listModelsWithMetadata(auth), rejected);
      assert.equal(calls, 3, 'a normal lookup must not reuse a snapshot whose credential was rejected');
    } finally {
      clearModelsCache(auth.identity);
      globalThis.fetch = originalFetch;
    }
  });
}
