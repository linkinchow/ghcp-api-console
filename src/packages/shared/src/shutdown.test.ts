import assert from 'node:assert/strict';
import { Agent, createServer, request, type IncomingMessage, type Server } from 'node:http';
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
  let received!: () => void;
  const requestReceived = new Promise<void>((resolve) => { received = resolve; });
  const server = createServer((_req, res) => {
    // Server-side order: the response is closed with the connection right after it is written, so the client may
    // read it only after `release` ran; what must hold is that the response was complete before resources go.
    res.once('finish', () => { events.push('response:finished'); });
    finishRequest = () => res.end('done');
    received();
  });
  const url = await listen(server);
  let body = '';
  const response = fetch(url).then(async (r) => { body = await r.text(); });
  // In flight means the server has the request; a fixed delay raced with connection setup under load.
  await requestReceived;

  const shutdown = installGracefulShutdown({
    server, service: 'test', signals: [], timeoutMs: 5_000, exit,
    onShutdownStart: () => { events.push('start'); },
    release: () => { events.push('release'); },
  }).shutdown('SIGTERM');
  setTimeout(() => finishRequest(), 20);
  await Promise.all([shutdown, response]);

  assert.deepEqual(events, ['start', 'response:finished', 'release']);
  assert.equal(body, 'done');
  assert.deepEqual(exitCodes, [0]);
});

/** A keep-alive GET whose connection the test can observe; resolves once headers arrive. */
function keepAliveGet(url: string, agent: Agent): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    request(url, { agent }, resolve).on('error', reject).end();
  });
}

test('a keep-alive connection busy at shutdown is closed after its response, not at the timeout', async () => {
  const { exitCodes, exit } = recorder();
  let finishRequest!: () => void;
  let received!: () => void;
  const requestReceived = new Promise<void>((resolve) => { received = resolve; });
  const server = createServer((_req, res) => {
    finishRequest = () => res.end('done');
    received();
  });
  const url = await listen(server);
  const handle = installGracefulShutdown({ server, service: 'test', signals: [], timeoutMs: 5_000, exit });
  const agent = new Agent({ keepAlive: true });
  const pending = keepAliveGet(url, agent);
  await requestReceived;

  const started = Date.now();
  const shutdown = handle.shutdown('SIGTERM');
  finishRequest();
  const response = await pending;
  const socketClosed = new Promise((resolve) => response.socket.once('close', resolve));
  response.resume();
  await Promise.all([shutdown, socketClosed]);

  assert.equal(response.headers.connection, 'close');
  assert.ok(Date.now() - started < 1_000, 'drained without waiting for the timeout');
  assert.deepEqual(exitCodes, [0]);
  agent.destroy();
});

test('a streaming response already sent at shutdown ends its connection when it finishes', async () => {
  const { exitCodes, exit } = recorder();
  let finishStream!: () => void;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: ping\n\n');
    finishStream = () => res.end('event: done\n\n');
  });
  const url = await listen(server);
  const handle = installGracefulShutdown({ server, service: 'test', signals: [], timeoutMs: 5_000, exit });
  const agent = new Agent({ keepAlive: true });
  const response = await keepAliveGet(url, agent);
  const socketClosed = new Promise((resolve) => response.socket.once('close', resolve));
  response.resume();

  const started = Date.now();
  const shutdown = handle.shutdown('SIGTERM');
  setTimeout(() => finishStream(), 20);
  await Promise.all([shutdown, socketClosed]);

  assert.notEqual(response.headers.connection, 'close', 'headers were sent before shutdown');
  assert.ok(Date.now() - started < 1_000, 'drained without waiting for the timeout');
  assert.deepEqual(exitCodes, [0]);
  agent.destroy();
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
