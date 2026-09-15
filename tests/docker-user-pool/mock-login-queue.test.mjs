import assert from 'node:assert/strict';
import test from 'node:test';
import { MockLoginQueue } from './mock-login-queue.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
for (const concurrency of [1, 5]) test(`mock Login enforces ${concurrency} active authorizations`, async () => {
  const releases = [], completed = [];
  const queue = new MockLoginQueue({ concurrency, complete: task => new Promise(resolve => {
    releases.push(() => { task.status = 'success'; completed.push(task.id); resolve(); });
  }) });
  const tasks = Array.from({ length: 10 }, (_, id) => ({ id }));
  tasks.forEach(task => queue.enqueue(task)); await tick();
  assert.equal(queue.snapshot().active, concurrency); assert.equal(queue.snapshot().pending, 10 - concurrency);
  while (completed.length < 10) { releases.splice(0).forEach(resolve => resolve()); await tick(); }
  assert.deepEqual([...completed].sort((a,b)=>a-b), tasks.map(task=>task.id));
  assert.equal(queue.snapshot().peakActive, concurrency); assert.equal(queue.snapshot().active, 0);
  assert.equal(queue.snapshot().finished, 10); assert.equal(queue.snapshot().failed, 0);
});
test('mock Login validates bounds, limits retained tasks and records completion failure', async () => {
  assert.throws(() => new MockLoginQueue({ concurrency: 0, complete() {} }));
  assert.throws(() => new MockLoginQueue({ delayMs: 30001, complete() {} }));
  const queue = new MockLoginQueue({ maxTasks: 1, complete: async () => { throw Error('synthetic'); } });
  const task={id:1}; queue.enqueue(task); assert.throws(()=>queue.enqueue({id:2}));await tick();
  assert.equal(queue.snapshot().failed,1);assert.equal(task.status,'failed');assert.equal(queue.snapshot().active,0);
});
