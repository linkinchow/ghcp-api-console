import assert from 'node:assert/strict';
import test from 'node:test';
import {
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
