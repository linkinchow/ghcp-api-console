// Independent local wire double, NOT the Login service or a browser. Control is IPC only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { childGate, CHILD_MS, INTERNAL_TOKEN, PASSWORD, type Proof, type Task } from './login-network-common.js';

childGate(); // Before timers, listeners or any network side effect.
const send = (proof: Omit<Proof, 'pid'>) => process.send?.({ ...proof, pid: process.pid });
process.on('disconnect', () => process.exit(2));
setTimeout(() => process.exit(3), CHILD_MS).unref();
let tasks: Task[] = [];
let stallGets = false;
let holdPost = false;
let calls = 0;
const pending = new Map<string, ServerResponse>();
const json = (res: ServerResponse, body: unknown, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
};
const server = createServer((req, res) => {
  void (async () => {
    assert.ok(++calls <= 1500, 'Bounded Login HTTP ledger');
    const url = new URL(req.url!, 'http://127.0.0.1');
    assert.equal(req.headers['x-internal-token'], INTERNAL_TOKEN);
    const id = randomUUID();
    const start = performance.now();
    send({ kind: 'http', id, method: req.method, path: url.pathname, at: start });
    if (req.method === 'POST' && url.pathname === '/api/tasks') {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes <= 16384); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.ssoUser, body.identity);
      assert.equal(body.ghLogin, `${body.identity}_synthetic`);
      assert.equal(body.ssoType, 'custom'); assert.equal(body.ssoPassword, PASSWORD);
      assert.match(body.oauthAttemptId, /^[a-f0-9-]{36}$/);
      assert.ok(tasks.length < 4);
      const task: Task = { id: randomUUID(), identity: body.identity, ssoUser: body.ssoUser,
        ghLogin: body.ghLogin, oauthAttemptId: body.oauthAttemptId, ssoType: 'custom',
        status: 'running', createdAt: new Date().toISOString() };
      // No deduplication: a replay creates a second identity and MUST fail the test.
      tasks.push(task);
      send({ kind: 'accepted', id, task });
      if (holdPost) return; // Keep the actual POST socket open until this process is killed.
      return json(res, task, 202);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/tasks')) {
      const list = url.pathname === '/api/tasks';
      if (list) {
        assert.equal(url.searchParams.get('page'), '1'); assert.equal(url.searchParams.get('pageSize'), '100');
      }
      const found = tasks.filter(task => list ? task.identity === url.searchParams.get('q') : url.pathname === `/api/tasks/${task.id}`);
      assert.equal(found.length, 1, 'One preserved accepted task');
      send({ kind: 'get-start', id, task: { ...found[0] }, at: start });
      if (stallGets) {
        pending.set(id, res);
        // Do not write headers/body, do not 503, do not resolve a promise sentinel.
        // A real client AbortSignal timeout must close this connected HTTP socket.
        res.once('close', () => {
          pending.delete(id);
          send({ kind: 'get-abort', id, at: performance.now(), elapsedMs: performance.now() - start,
            headersSent: res.headersSent });
        });
        return;
      }
      return json(res, list ? { items: found, total: found.length, page: 1, pageSize: 100 } : found[0]);
    }
    throw new Error('Unexpected local Login route');
  })().catch(() => { send({ kind: 'fatal' }); res.destroy(); });
});
// No synthetic server timeout is allowed to win the measured client timeout.
server.timeout = 0; server.requestTimeout = 0; server.headersTimeout = 0;
let initialized = false;
process.on('message', (message: { kind: string; id?: string; tasks?: Task[]; port?: number; stallGets?: boolean; holdPost?: boolean; taskId?: string }) => {
  void (async () => {
    if (message.kind === 'init') {
      assert.equal(initialized, false); initialized = true;
      tasks = message.tasks ?? []; assert.ok(tasks.length <= 4);
      stallGets = Boolean(message.stallGets); holdPost = Boolean(message.holdPost);
      assert.ok(Number.isInteger(message.port) && message.port! >= 0 && message.port! <= 65535);
      server.once('error', () => { send({ kind: 'fatal' }); process.exit(1); });
      server.listen(message.port!, '127.0.0.1', () => {
        const address = server.address(); assert.ok(address && typeof address !== 'string');
        send({ kind: 'listening', origin: `http://127.0.0.1:${address.port}`, tasks });
      });
    } else if (message.kind === 'mode') {
      // Only affects FUTURE GETs. Never release an already stalled socket early.
      stallGets = Boolean(message.stallGets); send({ kind: 'ack', id: message.id });
    } else if (message.kind === 'success') {
      const task = tasks.find(task => task.id === message.taskId); assert.ok(task);
      task.status = 'success'; send({ kind: 'ack', id: message.id, task });
    } else if (message.kind === 'snapshot') {
      send({ kind: 'snapshot', id: message.id, tasks, snapshot: { calls, pending: pending.size } });
    } else throw new Error('Unexpected IPC command');
  })().catch(() => { send({ kind: 'fatal' }); process.exit(1); });
});
