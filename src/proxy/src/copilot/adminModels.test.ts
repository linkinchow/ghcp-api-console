import assert from 'node:assert/strict';
import test from 'node:test';
import { toAdminModels } from './adminModels.js';

test('admin catalog keeps every canonical model and exposes only allow-listed metadata', () => {
  const data = toAdminModels([
    {
      id: 'claude-sonnet-4.6',
      name: '<img src=x>',
      secret: 'never-return',
      api_key: 'never-return',
      capabilities: {
        family: 'claude',
        endpoints: ['/v1/messages'],
        limits: { max_context_window_tokens: 200000, max_output_tokens: 64000, token: 'never-return' },
        supports: { vision: true, streaming: false, reasoning_effort: ['low', 'high'], token: 'never-return' },
      },
      policy: { state: 'enabled', token: 'never-return' },
    },
    {
      id: 'gpt-synthetic',
      supported_endpoints: ['/responses'],
      capabilities: { limits: { max_context_window_tokens: '1000', max_output_tokens: -1 } },
    },
  ]);

  assert.equal(data.length, 2);
  const [claude, gpt] = data;
  assert.equal(claude!.id, 'claude-sonnet-4-6');
  assert.equal(claude!.upstreamId, 'claude-sonnet-4.6');
  assert.equal(claude!.name, '<img src=x>', 'names are data; the Console renders them as text');
  assert.deepEqual(claude!.supportedPaths, ['/v1/messages']);
  assert.equal(claude!.contextWindow, 200000);
  assert.equal(claude!.maxOutputTokens, 64000);

  // Non-numeric or negative limits are unknown, not zero.
  assert.deepEqual(gpt!.supportedPaths, ['/responses']);
  assert.equal(gpt!.contextWindow, undefined);
  assert.equal(gpt!.maxOutputTokens, undefined);

  assert.equal(JSON.stringify(data).includes('never-return'), false);
});

test('an empty catalog stays empty and canonical ID collisions are not silently merged', () => {
  assert.deepEqual(toAdminModels([]), []);
  assert.throws(() => toAdminModels([{ id: 'claude-opus-4.6' }, { id: 'claude-opus-4-6' }]), /Multiple Copilot model IDs/);
});
