import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModelIdIndex,
  ModelIdCollisionError,
  resolveModelId,
  toCanonicalModelId,
  withCanonicalModelId,
  withCanonicalModelIds,
} from './modelIds.js';

test('canonicalizes dotted Claude versions without a model whitelist', () => {
  for (const [input, expected] of [
    ['claude-haiku-4.5', 'claude-haiku-4-5'],
    ['claude-opus-4.6', 'claude-opus-4-6'],
    ['claude-opus-4.7-high', 'claude-opus-4-7-high'],
    ['claude-opus-4.8', 'claude-opus-4-8'],
    ['claude-opus-5.1', 'claude-opus-5-1'],
    ['claude-opus-5.2', 'claude-opus-5-2'],
    ['claude-opus-5.3', 'claude-opus-5-3'],
    ['claude-opus-6.1', 'claude-opus-6-1'],
    ['claude-sonnet-7.3', 'claude-sonnet-7-3'],
    ['claude-haiku-10.2', 'claude-haiku-10-2'],
    ['claude-sonnet-5.2-1m-internal', 'claude-sonnet-5-2-1m-internal'],
    ['claude-opus-5', 'claude-opus-5'],
    ['claude-opus-4-8', 'claude-opus-4-8'],
  ] as const) {
    assert.equal(toCanonicalModelId(input), expected, input);
    assert.equal(toCanonicalModelId(expected), expected, `${input} must be idempotent`);
  }
});

test('leaves every non-Claude model byte-for-byte unchanged', () => {
  for (const id of ['gpt-4.1', 'gpt-5.6-sol', 'gemini-3.8-flash', 'o4-mini', 'CLAUDE-opus-4.8']) {
    assert.equal(toCanonicalModelId(id), id);
  }
});

test('resolves canonical, dotted, and dated Claude aliases through the live catalog', () => {
  const model = { id: 'claude-opus-5.2', name: 'Future Opus' };
  const index = buildModelIdIndex([model, { id: 'gpt-4.1' }]);

  for (const requestedId of [
    'claude-opus-5.2',
    'claude-opus-5-2',
    'claude-opus-5-2-20260101',
  ]) {
    assert.deepEqual(resolveModelId(index, requestedId), {
      requestedId,
      canonicalId: 'claude-opus-5-2',
      upstreamId: 'claude-opus-5.2',
      model,
    });
  }
  assert.equal(resolveModelId(index, 'claude-opus-5-4'), undefined);
  assert.equal(resolveModelId(index, 'claude-opus-5-2-xhigh'), undefined);
  assert.equal(resolveModelId(index, 'gpt-4-1'), undefined);
  assert.equal(resolveModelId(index, 'gpt-4.1')?.upstreamId, 'gpt-4.1');
  assert.equal(resolveModelId(index, 'gpt-4.1-high'), undefined);
});

test('keeps live snapshots distinct while allowing dated aliases for a live base model', () => {
  const snapshots = [
    { id: 'claude-3-5-sonnet-20240620' },
    { id: 'claude-3-5-sonnet-20241022' },
    { id: 'claude-3-5-sonnet' },
    { id: 'claude-opus-5.2' },
  ];
  const index = buildModelIdIndex(snapshots);
  assert.equal(toCanonicalModelId(snapshots[0].id), snapshots[0].id);
  assert.equal(toCanonicalModelId(snapshots[1].id), snapshots[1].id);
  assert.equal(resolveModelId(index, snapshots[0].id)?.upstreamId, snapshots[0].id);
  assert.equal(resolveModelId(index, snapshots[1].id)?.upstreamId, snapshots[1].id);
  assert.equal(resolveModelId(index, 'claude-opus-5-2-20260101')?.upstreamId, 'claude-opus-5.2');
  assert.equal(resolveModelId(index, 'claude-3-5-sonnet-20250101')?.upstreamId, 'claude-3-5-sonnet');
});

test('fails closed when live IDs collapse to one canonical ID', () => {
  assert.throws(
    () => buildModelIdIndex([{ id: 'claude-opus-5.2' }, { id: 'claude-opus-5-2' }]),
    (error: unknown) => {
      assert.ok(error instanceof ModelIdCollisionError);
      assert.equal(error.canonicalId, 'claude-opus-5-2');
      assert.deepEqual(error.upstreamIds, ['claude-opus-5.2', 'claude-opus-5-2']);
      return true;
    },
  );
});

test('canonicalizes catalog copies without mutating upstream metadata', () => {
  const raw = {
    id: 'claude-opus-5.2',
    version: 'claude-opus-5.2',
    name: 'claude-opus-5.2',
    display_name: 'Future Opus',
  };
  const canonical = withCanonicalModelId(raw);
  assert.deepEqual(canonical, {
    ...raw,
    id: 'claude-opus-5-2',
  });
  assert.deepEqual(raw, {
    id: 'claude-opus-5.2',
    version: 'claude-opus-5.2',
    name: 'claude-opus-5.2',
    display_name: 'Future Opus',
  });
});

test('rejects duplicate and ambiguous catalog rows', () => {
  const duplicate = { id: 'claude-opus-5.2', capabilities: { endpoints: ['/v1/messages'] } };
  assert.throws(
    () => withCanonicalModelIds([duplicate, { ...duplicate, capabilities: { endpoints: ['/v1/messages'] } }]),
    ModelIdCollisionError,
  );
  assert.throws(
    () => withCanonicalModelIds([{ id: 'claude-opus-5.2' }, { id: 'claude-opus-5-2' }]),
    ModelIdCollisionError,
  );
});
