import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_ENTERPRISE_ID, type EnterpriseId } from '@ghcp/shared';
import type { CreateTaskInput, LoginTaskRecord } from './tasksRepo.js';
import { LoginQueue } from '../tasks/queue.js';
import type { LoginTaskRequest } from '../tasks/runner.js';

const OTHER_ENTERPRISE = 'contoso-eu' as EnterpriseId;
const UNFINISHED = ['pending', 'running', 'cancelling'];

function newTask(enterpriseId: EnterpriseId, id: string, input: CreateTaskInput): LoginTaskRecord {
  return {
    id,
    enterpriseId,
    ...input,
    status: 'pending',
    stage: 'queued',
    attempts: 0,
    createdAt: new Date().toISOString(),
  };
}

test('queue responds immediately to increased concurrency and honors decreases', async () => {
  let concurrency = 1;
  let taskNumber = 0;
  const tasks = new Map<string, LoginTaskRecord>();
  const started: string[] = [];
  const complete = new Map<string, () => void>();
  const queue = new LoginQueue({
    getConcurrency: () => concurrency,
    createTask: (enterpriseId, input) => {
      const task = newTask(enterpriseId, `task-${++taskNumber}`, input);
      tasks.set(task.id, task);
      return task;
    },
    getTask: (_enterpriseId, id) => tasks.get(id),
    markCancelled: (_enterpriseId, id) => tasks.get(id),
    runLoginTask: async (_task, payload) => {
      started.push(payload.taskId);
      await new Promise<void>((resolve) => complete.set(payload.taskId, resolve));
    },
    markCopilotOauthFailed: async () => {},
  });

  const ids = Array.from({ length: 4 }, (_, index) => queue.enqueue(DEFAULT_ENTERPRISE_ID, request(index)).id);
  assert.deepEqual(started, [ids[0]]);

  concurrency = 3;
  queue.onRuntimeSettingsUpdated();
  assert.deepEqual(started, ids.slice(0, 3));

  concurrency = 1;
  queue.onRuntimeSettingsUpdated();
  complete.get(ids[0])!();
  await settleQueue();
  assert.deepEqual(started, ids.slice(0, 3));
  complete.get(ids[1])!();
  await settleQueue();
  assert.deepEqual(started, ids.slice(0, 3));
  complete.get(ids[2])!();
  await settleQueue();
  assert.deepEqual(started, ids);
  complete.get(ids[3])!();
  await settleQueue();
});

test('the queue is one global FIFO; runs and snapshots keep each task in its own enterprise', async () => {
  const tasks = new Map<string, LoginTaskRecord>();
  const runs: Array<{ enterpriseId: string; taskId: string }> = [];
  const queue = new LoginQueue({
    getConcurrency: () => 1,
    createTask: (enterpriseId, input) => {
      const task = newTask(enterpriseId, input.identity, input);
      tasks.set(task.id, task);
      return task;
    },
    getTask: (enterpriseId, id) => {
      const task = tasks.get(id);
      return task?.enterpriseId === enterpriseId ? task : undefined;
    },
    listUnfinishedTasks: (enterpriseId) => [...tasks.values()].filter((task) => task.enterpriseId === enterpriseId),
    runLoginTask: async (task, payload) => {
      runs.push({ enterpriseId: payload.enterpriseId, taskId: task.id });
      await new Promise<void>(() => undefined);
    },
    markCopilotOauthFailed: async () => {},
  });
  queue.enqueue(DEFAULT_ENTERPRISE_ID, request(0));
  queue.enqueue(OTHER_ENTERPRISE, request(1));
  queue.enqueue(DEFAULT_ENTERPRISE_ID, request(2));
  assert.deepEqual(runs, [{ enterpriseId: DEFAULT_ENTERPRISE_ID, taskId: 'identity-0' }]);
  const own = queue.snapshot(DEFAULT_ENTERPRISE_ID);
  assert.deepEqual(own.active, ['identity-0']);
  assert.deepEqual(own.pending, ['identity-2']);
  const positions = own.items.map((item) => [item.taskId, item.position]);
  assert.deepEqual(positions, [['identity-0', undefined], ['identity-2', 2]]);
  const other = queue.snapshot(OTHER_ENTERPRISE);
  assert.deepEqual(other.active, []);
  assert.deepEqual(other.pending, ['identity-1']);
  assert.deepEqual(other.items.map((item) => [item.taskId, item.position]), [['identity-1', 1]]);
  assert.equal(queue.cancel(OTHER_ENTERPRISE, 'identity-0'), undefined, 'A task of another enterprise is not found');
});

function request(index: number): LoginTaskRequest {
  return {
    identity: `identity-${index}`,
    ssoUser: `user-${index}`,
    ssoPassword: 'secret',
    ghLogin: `github-${index}`,
    oauthAttemptId: `attempt-${index}`,
    ssoType: 'custom',
  };
}

async function settleQueue(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

for (const outcome of ['cancelled', 'success'] as const) {
  const title = 'cancellation aborts execution but waits for resource release; '
    + `a run that still finishes keeps its ${outcome}`;
  test(title, async () => {
    const tasks = new Map<string, LoginTaskRecord>();
    const releasedAtProxy: string[] = [];
    let release: (() => void) | undefined;
    let aborted = false;
    const queue = new LoginQueue({
      getConcurrency: () => 1,
      createTask(enterpriseId, input) {
        const task = newTask(enterpriseId, input.identity, input);
        tasks.set(task.id, task);
        return task;
      },
      getTask: (_enterpriseId, id) => tasks.get(id),
      listUnfinishedTasks: () => [...tasks.values()].filter((task) => UNFINISHED.includes(task.status)),
      requestCancellation(_enterpriseId, id) {
        const task = tasks.get(id);
        if (task && (task.status === 'pending' || task.status === 'running')) task.status = 'cancelling';
        return task;
      },
      markCancelled(_enterpriseId, id) {
        const task = tasks.get(id)!;
        task.status = 'cancelled';
        return task;
      },
      markCopilotOauthFailed: async (enterpriseId, identity, attemptId) => {
        releasedAtProxy.push(`${enterpriseId}/${identity}:${attemptId}`);
      },
      runLoginTask: async (task, payload) => {
        task.status = 'running';
        payload.signal!.addEventListener('abort', () => { aborted = true; }, { once: true });
        await new Promise<void>((resolve) => { release = resolve; });
        // The token write was already in flight when the abort arrived and it landed.
        if (outcome === 'success') task.status = 'success';
      },
    });
    const active = queue.enqueue(DEFAULT_ENTERPRISE_ID, request(0));
    const waiting = queue.enqueue(OTHER_ENTERPRISE, request(1));
    queue.cancel(OTHER_ENTERPRISE, waiting.id);
    queue.cancel(DEFAULT_ENTERPRISE_ID, active.id);
    await settleQueue();
    assert.equal(aborted, true);
    assert.equal(waiting.status, 'cancelled');
    assert.deepEqual(releasedAtProxy, ['contoso-eu/identity-1:attempt-1'], 'A waiting task is released immediately');
    assert.equal(active.status, 'cancelling');
    assert.equal(queue.snapshot(DEFAULT_ENTERPRISE_ID).active.length, 1);
    assert.deepEqual(queue.snapshot(DEFAULT_ENTERPRISE_ID).pending, []);
    release!();
    await settleQueue();
    await settleQueue();
    assert.equal(active.status, outcome);
    assert.equal(queue.snapshot(DEFAULT_ENTERPRISE_ID).active.length, 0);
    const expected = outcome === 'cancelled'
      ? ['contoso-eu/identity-1:attempt-1', 'default/identity-0:attempt-0']
      : ['contoso-eu/identity-1:attempt-1'];
    assert.deepEqual(releasedAtProxy, expected, 'Proxy is told to drop the attempt only when the run did not finish');
  });
}
