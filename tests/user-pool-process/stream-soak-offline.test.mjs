import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { enabled, frame, gate, options, Ring, SseReader } from './stream-soak-safety.ts';

const valid = { MYSQL_POOL_STREAM_SOAK_TEST: '1', MYSQL_POOL_TEST_DISPOSABLE: '1',
  MYSQL_TEST_URL: 'mysql://root:synthetic@127.0.0.1:3306/ghcp_pool_test_marker' };
test('stream soak options enforce finite half-hour budget and modest lanes', () => {
  assert.deepEqual(options([]), { duration: 60, stream: 30, concurrency: 3, replicas: 3, checkpoint: 10, report: undefined });
  assert.equal(options(['--duration-seconds', '1800', '--replicas', '5', '--concurrency', '5']).duration, 1800);
  for (const args of [['--duration-seconds', '1801'], ['--duration-seconds', '86400'], ['--duration-seconds', '0'],
    ['--duration-seconds', '60.0'], ['--duration-seconds', '060'], ['--duration-seconds', '59'], ['--stream-seconds', '61'],
    ['--stream-seconds', '9'], ['--concurrency', '6'], ['--concurrency', '4'], ['--replicas', '4'], ['--checkpoint-seconds', '1'],
    ['--duration-seconds'], ['--duration-seconds', '60', '--duration-seconds', '60'], ['--endpoint', 'http://example.test'],
    ['--stream-seconds', '60'], ['--report', 'output.log'], ['--continuous', 'true']]) assert.throws(() => options(args), /REFUSED/);
});
test('stream soak synthetic/disposable DB guards', () => {
  assert.equal(enabled({}), false); assert.equal(enabled(valid), true); assert.throws(() => gate({}), /REFUSED/);
  for (const patch of [{ MYSQL_POOL_STREAM_SOAK_TEST: '' }, { MYSQL_POOL_TEST_DISPOSABLE: '' }, { MYSQL_TEST_URL: '' },
    { MYSQL_TEST_URL: 'mysql://root:x@192.0.2.1/ghcp_pool_test_marker' }, { MYSQL_TEST_URL: 'mysql://root:x@localhost/production' },
    { MYSQL_TEST_URL: 'mysql://root:x@127.0.0.1/ghcp_pool_test_marker?ssl=true' }]) assert.throws(() => gate({ ...valid, ...patch }), /REFUSED/);
});
test('bounded sample ring discards history; SSE accepts fragmented terminal and rejects partial/errors/oversize', () => {
  const ring = new Ring(3); for (let i = 0; i < 100000; i++) ring.add(i); assert.deepEqual(ring.snapshot(), [99997, 99998, 99999]);
  const wire = frame({ type: 'message_start' }) + frame({ type: 'content_block_delta' }) + frame({ type: 'message_stop' });
  const parsed = new SseReader();
  for (const byte of Buffer.from(wire)) parsed.add(Uint8Array.of(byte)); parsed.finish(); assert.equal(parsed.deltas, 1);
  const partial = new SseReader(); partial.add(Buffer.from(frame({ type: 'message_start' }))); assert.throws(() => partial.finish());
  assert.throws(() => new SseReader().add(Buffer.from(frame({ type: 'error', error: 'busy' }))));
  assert.throws(() => new SseReader().add(Buffer.alloc(9000)));
});
test('first abort evidence preserves initiating event, keeps ring16 and never retains raw log fields', async () => {
  const { FirstAbortTrace, logTokens } = await import('./stream-soak-harness.ts');
  const trace = new FirstAbortTrace();
  const raw = '2026-09-15T00:00:00Z [proxy:diagnostics] ERROR upstream-stream-failed: private-message {"token":"SECRET","url":"mysql://PRIVATE"}\n';
  const tokens = logTokens(raw);
  assert.deepEqual(tokens, [{ level: 'ERROR', event: 'upstream-stream-failed' }]);
  trace.record('child-log', { pid: 123, ...tokens[0], elapsedMs: 12000 });
  for (let index = 0; index < 40; index++) trace.record('sampler', { error: new Error('SECRET generic delay abort'), elapsedMs: 12001 + index });
  trace.record('workload', { error: new Error('SECRET generic delay abort') });
  const snapshot = trace.snapshot(); assert.equal(snapshot.recent.length, 16);
  assert.deepEqual(snapshot.first, { source: 'child-log', elapsedMs: 12000, pid: 123, level: 'ERROR', event: 'upstream-stream-failed' });
  assert.ok(!JSON.stringify(snapshot).includes('SECRET')); assert.ok(!JSON.stringify(snapshot).includes('PRIVATE'));
  assert.deepEqual(logTokens('[proxy:x] WARN secret-custom-event: token=SECRET'), [{ level: 'WARN', event: 'unrecognized-event' }]);
  assert.deepEqual(logTokens('[proxy:x] ERROR '), [{ level: 'ERROR', event: 'unrecognized-event' }]);
  assert.throws(() => trace.record('unsafe-channel'));
});

test('expected cancel matches exact request/PID, native abort and one paired log only', async () => {
  const { ExpectedCancelLogs } = await import('./stream-soak-harness.ts');
  const id = 'stream-soak-0-6-cancel';
  const metadata = { pid: 123, requestId: id, armed: true, upstreamAborted: true, downstreamClosed: true };
  const valid = new ExpectedCancelLogs(); valid.arm(123, id); valid.beginAbort(123, id); valid.wire(123); valid.metadata(metadata);
  assert.equal(valid.matched(123, id), true); valid.finish(123, id); assert.equal(valid.count, 1); valid.assertDrained();
  const reversed = new ExpectedCancelLogs(); reversed.arm(123, id); reversed.beginAbort(123, id); reversed.metadata(metadata); reversed.wire(123);
  assert.equal(reversed.matched(123, id), true); reversed.finish(123, id); reversed.assertDrained();
  for (const patch of [{ pid: 124 }, { requestId: 'stream-soak-0-7-cancel' }, { armed: false }, { upstreamAborted: false }, { downstreamClosed: false }]) {
    const log = new ExpectedCancelLogs(); log.arm(123, id); log.beginAbort(123, id); assert.throws(() => log.metadata({ ...metadata, ...patch }));
  }
  assert.throws(() => new ExpectedCancelLogs().metadata(metadata), /Unregistered/);
  const notAborted = new ExpectedCancelLogs(); notAborted.arm(123, id); assert.throws(() => notAborted.metadata(metadata), /Parent has not issued/);
  const duplicate = new ExpectedCancelLogs(); duplicate.arm(123, id); duplicate.beginAbort(123, id); duplicate.metadata(metadata);
  assert.throws(() => duplicate.metadata(metadata), /Duplicate/);
  const unmatched = new ExpectedCancelLogs(); unmatched.arm(123, id); unmatched.wire(123); assert.throws(() => unmatched.assertDrained());
  const bound = new ExpectedCancelLogs(); for (let i = 0; i < 5; i++) bound.arm(100 + i, `stream-soak-${i}-1-cancel`);
  assert.throws(() => bound.arm(200, 'stream-soak-0-2-cancel'));
});

test('runner/child/harness refuse absent unsafe or oversized input before any side effect', async () => {
  let attempts = 0; const restore = []; const deny = () => { attempts++; throw new Error('Side effect sentinel'); };
  for (const [object, keys] of [[net, ['connect', 'createConnection', 'createServer']], [net.Socket.prototype, ['connect']],
    [http, ['createServer', 'request', 'get']], [https, ['request', 'get']],
    [childProcess, ['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync']], [globalThis, ['fetch']]]) {
    for (const key of keys) { restore.push([object, key, object[key]]); object[key] = deny; }
  }
  syncBuiltinESMExports();
  const names = Object.keys(valid); const saved = Object.fromEntries(names.map(name => [name, process.env[name]])); const argv = process.argv;
  try {
    process.argv = ['node', 'stream-soak-run.mjs']; for (const name of names) delete process.env[name];
    for (const file of ['stream-soak-child.ts', 'stream-soak-run.mjs']) await assert.rejects(import(`./${file}?guard=absent`), /REFUSED/);
    const { runSoak } = await import('./stream-soak-harness.ts'); await assert.rejects(runSoak(options([])), /REFUSED/);
    Object.assign(process.env, valid); process.argv = ['node', 'stream-soak-run.mjs', '--duration-seconds', '1801'];
    await assert.rejects(import('./stream-soak-run.mjs?guard=duration'), /REFUSED/);
    await assert.rejects(runSoak({ ...options([]), duration: 1801 }), /REFUSED/);
    process.env.MYSQL_TEST_URL = 'mysql://root:x@192.0.2.1/ghcp_pool_test_x'; process.argv = ['node', 'stream-soak-run.mjs'];
    for (const file of ['stream-soak-child.ts', 'stream-soak-run.mjs', 'stream-soak-mysql.test.ts']) await assert.rejects(import(`./${file}?guard=remote`), /REFUSED/);
    await assert.rejects(runSoak(options([])), /REFUSED/); assert.equal(attempts, 0);
  } finally {
    process.argv = argv;
    for (const [object, key, value] of restore) object[key] = value; syncBuiltinESMExports();
    for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  }
});
