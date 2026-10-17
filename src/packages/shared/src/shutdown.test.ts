import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS, installGracefulShutdown, readShutdownTimeoutMs } from './shutdown.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function recorder() {
  const events: string[] = [];
  const exitCodes: number[] = [];
  return { events, exitCodes, exit: (code: number) => { exitCodes.push(code); } };
}

test('lets an in-flight request finish before releasing resources and exiting 0', async () => {
  const { events, exitCodes, exit } = recorder();
  let finishRequest!: () => void;
  const server = createServer((_req, res) => {
    finishRequest = () => res.end('done');
  });
  const url = await listen(server);
  const response = fetch(url).then(async (r) => { events.push(`response:${await r.text()}`); });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const shutdown = installGracefulShutdown({
    server, service: 'test', signals: [], timeoutMs: 5_000, exit,
    onShutdownStart: () => { events.push('start'); },
    release: () => { events.push('release'); },
  }).shutdown('SIGTERM');
  setTimeout(() => finishRequest(), 20);
  await Promise.all([shutdown, response]);

  assert.deepEqual(events, ['start', 'response:done', 'release']);
  assert.deepEqual(exitCodes, [0]);
});

test('closes connections that outlive the timeout, such as an open SSE stream', async () => {
  const { events, exitCodes, exit } = recorder();
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: ping\n\n');
  });
  const url = await listen(server);
  const stream = await fetch(url);
  const streamEnded = stream.text().then(() => 'ended', () => 'aborted');

  await installGracefulShutdown({
    server, service: 'test', signals: [], timeoutMs: 50, exit,
    release: () => { events.push('release'); },
  }).shutdown('SIGTERM');

  assert.ok(['ended', 'aborted'].includes(await streamEnded));
  assert.deepEqual(events, ['release']);
  assert.deepEqual(exitCodes, [0]);
});

test('a second signal exits 1 immediately without waiting for the drain', async () => {
  const { exitCodes, exit } = recorder();
  const server = createServer(() => { /* never responds */ });
  const url = await listen(server);
  const pending = fetch(url).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const handle = installGracefulShutdown({ server, service: 'test', signals: [], timeoutMs: 100, exit });
  const first = handle.shutdown('SIGTERM');
  void handle.shutdown('SIGTERM');
  assert.deepEqual(exitCodes, [1]);

  await first;
  await pending;
  assert.deepEqual(exitCodes, [1, 0]);
});

test('a failing release still exits, with code 1', async () => {
  const { exitCodes, exit } = recorder();
  const server = createServer();
  await listen(server);

  await installGracefulShutdown({
    server, service: 'test', signals: [], timeoutMs: 1_000, exit,
    release: () => { throw new Error('storage close failed'); },
  }).shutdown('SIGTERM');

  assert.deepEqual(exitCodes, [1]);
});

test('signal handlers are installed and removable', () => {
  const server = createServer();
  const before = process.listenerCount('SIGTERM');
  const handle = installGracefulShutdown({ server, service: 'test', timeoutMs: 1_000, exit: () => {} });
  assert.equal(process.listenerCount('SIGTERM'), before + 1);
  handle.dispose();
  assert.equal(process.listenerCount('SIGTERM'), before);
});

test('SHUTDOWN_TIMEOUT_MS defaults to 25 s and rejects invalid values', () => {
  assert.equal(readShutdownTimeoutMs({}), DEFAULT_SHUTDOWN_TIMEOUT_MS);
  assert.equal(readShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: ' 8000 ' }), 8000);
  assert.equal(readShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '0' }), 0);
  for (const value of ['-1', '1.5', 'soon']) {
    assert.throws(() => readShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: value }), /SHUTDOWN_TIMEOUT_MS/);
  }
});
