import assert from 'node:assert/strict';
import test from 'node:test';
import { cancelLoginTask } from './login.js';

test('cancel only reports success when the authority confirms cancellation', async t => {
  for (const outcome of ['cancelled', 'already-succeeded', 'already-failed', 'unknown'] as const) {
    const task = { id: 'synthetic-task', status: outcome === 'cancelled' ? 'cancelled' : 'uncertain' };
    const mock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ task, outcome }), {
      status: outcome === 'unknown' ? 202 : 200, headers: { 'Content-Type': 'application/json' },
    }));
    if (outcome === 'cancelled') assert.deepEqual(await cancelLoginTask('11111111-2222-4333-8444-555555555555', task.id), task);
    else await assert.rejects(cancelLoginTask('11111111-2222-4333-8444-555555555555', task.id), /not confirmed|completed before cancellation/);
    mock.mock.restore();
  }
});
