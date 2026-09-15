import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bounded, createdAt, domain, internalKey, model, password, token } from './replicas-safety.js';

export interface Task {
  id: string; identity: string; ssoUser: string; ghLogin: string; oauthAttemptId: string;
  ssoType: 'custom'; status: 'running' | 'success'; createdAt: string; pid: number;
}
export interface WireCall { pid: number; kind: string; identity: string; at: number; }
export async function startMock(complete: (task: Task) => Promise<void>) {
  const pids = new Set<number>();
  const users = new Map<string, ReturnType<typeof user>>();
  const tasks: Task[] = [];
  const calls: WireCall[] = [];
  const failures: string[] = [];
  const heldBusiness = new Map<string, ServerResponse[]>();
  const completions = new Map<string, Promise<void>>();
  let armPost = false;
  let heldPost: { task: Task; res: ServerResponse } | undefined;
  let closed = false;
  const reply = (res: ServerResponse, body: unknown, status = 200) => {
    if (!res.destroyed && !res.writableEnded) res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  };
  const success = () => ({ id: 'synthetic-replicas-result', type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  function user(identity: string) {
    return { ssoUser: identity, email: `${identity}@${domain}`, role: 'user', createdAt,
      emuStatus: 'active', ghLogin: `${identity}_synthetic`, ghScimId: `synthetic-${identity}`, copilotSeatStatus: 'assigned' };
  }
  async function finish(task: Task) {
    if (!completions.has(task.id)) completions.set(task.id, (async () => {
      await complete(task); task.status = 'success';
    })());
    await completions.get(task.id);
  }
  const server = createServer((req, res) => {
    void (async () => {
      assert.equal(closed, false); assert.equal(req.socket.remoteAddress, '127.0.0.1');
      const pid = Number(req.headers['x-replicas-pid']); assert.ok(pids.has(pid));
      const url = new URL(req.url!, 'http://127.0.0.1');
      const path = url.pathname;
      let text = '';
      for await (const chunk of req) { text += String(chunk); assert.ok(Buffer.byteLength(text) < 16384); }
      const body = text ? JSON.parse(text) : {};
      assert.ok(calls.length < 3000, 'Bounded mock ledger');
      if (path.startsWith('/api/')) assert.equal(req.headers['x-internal-token'], internalKey);
      const member = path.split('/')[3];
      if (req.method === 'GET' && /^\/api\/users\/[a-z]+\.[a-z]+[0-9]{2}$/.test(path)) {
        reply(res, users.get(member) ?? {}, users.has(member) ? 200 : 404); return;
      }
      if (req.method === 'POST' && path === '/api/users') {
        assert.match(body.ssoUser, /^[a-z]+\.[a-z]+[0-9]{2}$/);
        assert.equal(body.email, `${body.ssoUser}@${domain}`); assert.equal(body.role, 'user'); assert.equal(body.poolManaged, true);
        calls.push({ pid, kind: 'user-post', identity: body.ssoUser, at: performance.now() });
        assert.equal(users.has(body.ssoUser), false, 'Duplicate user POST is not deduplicated');
        assert.ok(users.size < 20, 'Synthetic account cap');
        const value = user(body.ssoUser); users.set(body.ssoUser, value); reply(res, value, 201); return;
      }
      if (req.method === 'POST' && /^\/api\/users\/[a-z]+\.[a-z]+[0-9]{2}\/login-credentials$/.test(path)) {
        assert.ok(users.has(member)); assert.equal(body.expectedEmail, users.get(member)!.email); assert.equal(body.expectedCreatedAt, createdAt);
        reply(res, { user: users.get(member), passwordForLogin: password }); return;
      }
      if (req.method === 'POST' && path === '/api/tasks') {
        assert.ok(users.has(body.identity)); assert.equal(body.ssoUser, body.identity);
        assert.equal(body.ghLogin, users.get(body.identity)!.ghLogin); assert.equal(body.ssoPassword, password); assert.equal(body.ssoType, 'custom');
        assert.match(body.oauthAttemptId, /^[a-f0-9-]{36}$/);
        calls.push({ pid, kind: 'task-post', identity: body.identity, at: performance.now() });
        assert.equal(tasks.some(task => task.identity === body.identity), false, 'Duplicate Login POST is not deduplicated');
        const task: Task = { id: randomUUID(), identity: body.identity, ssoUser: body.identity, ghLogin: body.ghLogin,
          oauthAttemptId: body.oauthAttemptId, ssoType: 'custom', status: 'running', createdAt: new Date().toISOString(), pid };
        tasks.push(task);
        if (armPost) { armPost = false; assert.equal(heldPost, undefined); heldPost = { task, res }; return; }
        await finish(task); reply(res, task, 202); return;
      }
      if (req.method === 'GET' && path === '/api/tasks') {
        assert.deepEqual([...url.searchParams.keys()].sort(), ['page', 'pageSize', 'q']);
        assert.equal(url.searchParams.get('page'), '1'); assert.equal(url.searchParams.get('pageSize'), '100');
        const identity = url.searchParams.get('q')!; assert.ok(users.has(identity));
        const items = tasks.filter(task => task.identity === identity);
        calls.push({ pid, kind: 'task-search', identity, at: performance.now() });
        for (const task of items) await finish(task);
        reply(res, { items, total: items.length, page: 1, pageSize: 100 }); return;
      }
      if (req.method === 'GET' && /^\/api\/tasks\/[a-f0-9-]{36}$/.test(path)) {
        const task = tasks.find(task => task.id === member); assert.ok(task); await finish(task); reply(res, task); return;
      }
      const bearer = String(req.headers.authorization);
      const identity = [...users.keys()].find(identity => bearer === `Bearer ${token(identity)}`); assert.ok(identity);
      if (req.method === 'GET' && path === '/models') {
        calls.push({ pid, kind: 'models', identity, at: performance.now() });
        reply(res, { data: [{ id: model, capabilities: { type: 'chat', endpoints: ['/v1/messages'] } }] }); return;
      }
      assert.equal(req.method, 'POST'); assert.equal(path, '/v1/messages'); assert.equal(body.model, model);
      const kind = String(body.messages?.[0]?.content); assert.match(kind, /^(Reply OK|business-[a-z0-9-]+)$/);
      calls.push({ pid, kind, identity, at: performance.now() });
      const held = heldBusiness.get(kind);
      if (held) held.push(res); else reply(res, success());
    })().catch(() => {
      failures.push('mock_rejected_unexpected_traffic');
      if (!res.headersSent) reply(res, { error: 'Synthetic fixture rejected traffic' }, 500); else res.destroy();
    });
  });
  server.requestTimeout = 20000; server.headersTimeout = 5000;
  server.listen(0, '127.0.0.1'); await bounded(once(server, 'listening'), 'mock listen');
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, failures, tasks,
    allowPid: (pid: number) => { assert.ok(Number.isSafeInteger(pid) && pid > 0); pids.add(pid); },
    hold: (kind: string) => { assert.equal(heldBusiness.has(kind), false); heldBusiness.set(kind, []); },
    release: (kind: string, expected: number) => {
      const responses = heldBusiness.get(kind)!; assert.equal(responses.length, expected); heldBusiness.delete(kind);
      for (const res of responses) { assert.equal(res.destroyed, false); reply(res, success()); }
    },
    armLoginPost: () => { assert.equal(heldPost, undefined); armPost = true; },
    heldTask: () => heldPost?.task,
    close: async () => {
      closed = true; server.closeAllConnections();
      await bounded(new Promise<void>(resolve => server.close(() => resolve())), 'mock close', 3000);
      await bounded(Promise.allSettled([...completions.values()]), 'mock callbacks', 3000);
    },
  };
}
