import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { abortable } from './abort.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('resolves with the operation result and removes its listener', async () => {
  const controller = new AbortController();
  assert.equal(await abortable(Promise.resolve(42), controller.signal), 42);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('passes through the operation rejection and removes its listener', async () => {
  const controller = new AbortController();
  await assert.rejects(abortable(Promise.reject(new Error('boom')), controller.signal), /boom/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('rejects with the abort reason while the operation is pending', async () => {
  const controller = new AbortController();
  const operation = deferred<number>();
  const result = abortable(operation.promise, controller.signal);
  const reason = new Error('stop');
  controller.abort(reason);
  await assert.rejects(result, (error) => error === reason);
  operation.resolve(1);
  await operation.promise;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('rejects immediately when the signal is already aborted', async () => {
  const reason = new Error('already');
  const operation = deferred<number>();
  await assert.rejects(abortable(operation.promise, AbortSignal.abort(reason)), (error) => error === reason);
});

test('absorbs a late rejection of the abandoned operation', async () => {
  const unhandled: unknown[] = [];
  const record = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', record);
  try {
    const controller = new AbortController();
    const operation = deferred<number>();
    const result = abortable(operation.promise, controller.signal);
    controller.abort(new Error('stop'));
    await assert.rejects(result, /stop/);
    operation.reject(new Error('late'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', record);
  }
});
