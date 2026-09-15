import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedAdmission } from './admission.js';

test('aborted admission rejects promptly and cleans a late committed hold exactly once', async () => {
  const controller = new AbortController();
  let resolve!: (value: string) => void;
  const operation = new Promise<string>(done => { resolve = done; });
  const cleaned: string[] = [];
  const pending = boundedAdmission(() => operation, controller.signal, async value => { cleaned.push(value); });
  await Promise.resolve(); // Admission has started; preserve coverage of a genuinely late commit.
  controller.abort();
  await assert.rejects(pending, { code: 'pool_request_timeout' });
  resolve('late-hold');
  await new Promise<void>(done => setImmediate(done));
  assert.deepEqual(cleaned, ['late-hold']);
});

test('cancellation before deferred start never invokes admission or hold cleanup', async () => {
  const controller = new AbortController();
  let started = false;
  let cleaned = false;
  const pending = boundedAdmission(() => { started = true; return 'unexpected hold'; }, controller.signal,
    async () => { cleaned = true; });
  controller.abort();
  await assert.rejects(pending, { code: 'pool_request_timeout' });
  await new Promise<void>(done => setImmediate(done));
  assert.equal(started, false);
  assert.equal(cleaned, false);
});

test('successful admission is returned without cleanup and errors do not become unhandled', async () => {
  const controller = new AbortController();
  let cleanup = 0;
  assert.equal(await boundedAdmission(() => 'held', controller.signal, async () => { cleanup++; }), 'held');
  controller.abort();
  assert.equal(cleanup, 0);
  const next = new AbortController();
  await assert.rejects(boundedAdmission(() => Promise.reject(new Error('database unavailable')), next.signal, async () => {}), /database unavailable/);
});
