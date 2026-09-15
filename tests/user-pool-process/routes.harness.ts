import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import type { TestContext } from 'node:test';
import { apiKey, bounded, caller, loopbackOrigin, model, mysqlGate } from './routes.safety.js';
import { mockServer } from './routes.mock.js';

type Replica = { pid: number; instance: string; proxy: string; control: string; child: ChildProcess };
export async function fixture(t: TestContext) {
  const supplied = mysqlGate(process.env); // Before spawning, listener creation or DB connection.
  const database = `ghcp_pool_test_${randomUUID().replaceAll('-', '')}`;
  assert.notEqual(`/${database}`, supplied.pathname);
  const dbUrl = new URL(supplied); dbUrl.pathname = `/${database}`;
  const adminUrl = new URL(supplied); adminUrl.pathname = '/';
  const key = randomBytes(32).toString('hex');
  const replicas: Replica[] = [];
  const children: Array<{ child: ChildProcess; log: string }> = [];
  const controllers: AbortController[] = [];
  const pending: Promise<unknown>[] = [];
  let admin: Connection | undefined;
  let mock: Awaited<ReturnType<typeof mockServer>> | undefined;
  let created = false;
  let closing: Promise<void> | undefined;
  function live() { assert.equal(closing, undefined, 'Fixture is closing'); t.signal.throwIfAborted(); }
  function track<T>(promise: Promise<T>): Promise<T> {
    void promise.catch(() => {}); pending.push(promise); return promise;
  }
  function close(): Promise<void> {
    return closing ??= (async () => {
      controllers.forEach(controller => controller.abort());
      const cleanupErrors: unknown[] = [];
      for (const state of children) {
        const { child } = state;
        try {
          if (child.exitCode === null && child.signalCode === null) {
            const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
            try {
              if (child.connected) await bounded(new Promise<void>((resolve, reject) => child.send({ type: 'shutdown' }, error => error ? reject(error) : resolve())), 'shutdown IPC', 1000);
              await bounded(exit, 'child graceful exit', 6000);
            } catch {
              child.kill('SIGKILL'); await bounded(exit, 'child forced exit', 3000);
            }
          }
          assert.equal(child.exitCode, 0, `Child ${child.pid} exited ${child.exitCode}/${child.signalCode}: ${state.log}`);
        } catch (error) { cleanupErrors.push(error); }
      }
      try { await mock?.close(); } catch (error) { cleanupErrors.push(error); }
      try { await bounded(Promise.allSettled(pending), 'client cleanup', 3000); } catch (error) { cleanupErrors.push(error); }
      // Never DROP while a child can still write. Report exact disposable DB on failure.
      const dead = children.every(({ child }) => child.exitCode !== null || child.signalCode !== null);
      try {
        if (created && dead) {
          await admin!.query({ sql: `DROP DATABASE \`${database}\``, timeout: 5000 });
          t.diagnostic(`Cleanup: both children exited; dropped ${database}`);
        } else if (created) cleanupErrors.push(new Error(`Manual cleanup required for ${database}; child did not exit`));
      } catch (error) { cleanupErrors.push(error); }
      try { if (admin) await bounded(admin.end(), 'admin end', 3000); } catch (error) { admin?.destroy(); cleanupErrors.push(error); }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `Fixture cleanup failed: ${database}`);
    })();
  }
  t.after(close); // Also covers setup failure; normal cases close in their finally.
  const { createConnection } = await import('mysql2/promise');
  live(); admin = await createConnection({ uri: adminUrl.toString(), connectTimeout: 3000 });
  live(); await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`, timeout: 5000 }); created = true;
  live(); mock = await mockServer();
  const upstream = mock;
  for (let i = 0; i < 2; i++) {
    live();
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path']) if (process.env[name]) env[name] = process.env[name];
    Object.assign(env, { NODE_ENV: 'test', MYSQL_POOL_PROCESS_ROUTES_TEST: '1', MYSQL_POOL_TEST_DISPOSABLE: '1',
      MYSQL_TEST_URL: dbUrl.toString(), ROUTES_CHILD: '1', ROUTES_MOCK_ORIGIN: upstream.origin, ROUTES_CONTROL_KEY: key,
      TSX_TSCONFIG_PATH: fileURLToPath(new URL('./tsconfig.routes.json', import.meta.url)) });
    const child = fork(fileURLToPath(new URL('./routes.child.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'], env, cwd: fileURLToPath(new URL('../../', import.meta.url)), silent: true,
    });
    const state = { child, log: '' }; children.push(state);
    const lifetime = setTimeout(() => { child.kill('SIGKILL'); }, 115000);
    lifetime.unref(); child.once('exit', () => clearTimeout(lifetime));
    child.on('error', error => { state.log = `${state.log}\n${error.message}`.slice(-6000); });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { state.log = (state.log + String(chunk)).slice(-6000); });
    const info = await bounded(new Promise<Omit<Replica, 'child'>>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Child startup exited ${code}: ${state.log}`)));
      child.once('message', message => {
        try {
          assert.ok(message && typeof message === 'object' && 'type' in message && message.type === 'ready');
          const ready = message as unknown as Omit<Replica, 'child'>;
          assert.equal(ready.pid, child.pid); assert.notEqual(ready.pid, process.pid);
          assert.match(ready.instance, /^[a-f0-9-]{36}$/);
          loopbackOrigin(ready.proxy); loopbackOrigin(ready.control);
          resolve(ready);
        } catch (error) { reject(error); }
      });
    }), 'child startup', 20000).catch(error => { throw new Error(`Child startup failed: ${state.log}`, { cause: error }); });
    replicas.push({ ...info, child });
    upstream.allowPid(info.pid);
  }
  assert.notEqual(replicas[0].pid, replicas[1].pid);
  assert.notEqual(replicas[0].instance, replicas[1].instance);
  assert.notEqual(replicas[0].proxy, replicas[1].proxy);
  assert.notEqual(replicas[0].control, replicas[1].control);
  t.diagnostic(`Independent child PIDs ${replicas.map(replica => replica.pid).join(', ')}; shared ${database}`);
  function control(index: number, command: 'state' | 'seed' | 'rotate-aba' | 'rotate-ab' | 'tick' | 'clear-cache') {
    live(); const controller = new AbortController(); controllers.push(controller);
    return track((async () => {
      const response = await fetch(`${replicas[index].control}/${command}`, {
        method: command === 'state' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.any([controller.signal, t.signal, AbortSignal.timeout(15000)]), redirect: 'error',
      });
      const text = await response.text(); assert.equal(response.status, 200, text);
      return JSON.parse(text) as { member: string; generation: number; contexts: Record<string, { requestId: string; joined: boolean; member: string }> };
    })());
  }
  // Prove capability/auth failures cannot seed, admit or call upstream.
  for (const replica of replicas) {
    const deniedControl = await fetch(`${replica.control}/seed`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000) });
    assert.equal(deniedControl.status, 403); await deniedControl.text();
    const deniedRoute = await fetch(`${replica.proxy}/v1/models`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    assert.equal(deniedRoute.status, 401); await deniedRoute.text();
  }
  assert.equal(upstream.calls.length, 0);
  const { member } = await control(0, 'seed');
  assert.match(member, /^[a-z]+\.[a-z]+[0-9]{2}$/);
  assert.equal(upstream.calls.filter(call => call.kind === 'Reply OK').length, 1);
  await Promise.all(replicas.map((_, i) => control(i, 'clear-cache')));
  let sequence = 0;
  function request(index: number, kind: 'GET' | 'HEAD' | 'mixed' | 'old-success' | 'old-unauthorized' | 'replacement' | 'must-not-admit', identity = caller) {
    live(); const id = `r${++sequence}`;
    const controller = new AbortController(); controllers.push(controller);
    const catalog = kind === 'GET' || kind === 'HEAD';
    const response = track(fetch(`${replicas[index].proxy}${catalog ? '/v1/models' : '/v1/messages'}`, {
      method: catalog ? kind : 'POST', signal: AbortSignal.any([controller.signal, t.signal, AbortSignal.timeout(30000)]), redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}`, 'X-User-Identity': identity, 'Content-Type': 'application/json', 'x-process-routes-id': id },
      body: catalog ? undefined : JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: kind }] }),
    }).then(async response => ({ status: response.status, text: await response.text() })));
    const outcome = response.then(value => ({ value }), error => ({ error }));
    return { id, index, controller, response, outcome };
  }
  // Main never invokes product storage/runtime. Only read-only observer SQL follows DDL.
  async function rows(table: 'user_pool_accounts' | 'user_pool_leases' | 'user_pool_holds' | 'user_pool_catalog_holds' | 'user_pool_events' | 'proxy_accounts') {
    live(); const [rows] = await admin!.query<RowDataPacket[]>({ sql: `SELECT * FROM \`${database}\`.\`${table}\``, timeout: 3000 }); return rows;
  }
  async function holds() {
    live();
    const [all] = await admin!.query<RowDataPacket[]>({ sql: `SELECT h.request_id, l.caller_id, l.member_identity, 'lease' AS kind
      FROM \`${database}\`.user_pool_holds h LEFT JOIN \`${database}\`.user_pool_leases l ON l.lease_id=h.lease_id
      UNION ALL SELECT request_id, caller_id, member_identity, 'catalog' AS kind FROM \`${database}\`.user_pool_catalog_holds`, timeout: 3000 });
    assert.ok(all.every(hold => hold.member_identity === member), 'No orphan hold or unexpected member');
    assert.ok(new Set(all.map(hold => hold.caller_id)).size <= 1, 'No overlapping callers own the single member');
    return all;
  }
  async function joined(requests: Array<{ id: string; index: number }>) {
    const states = await Promise.all([control(0, 'state'), control(1, 'state')]);
    return requests.every(request => states[request.index].contexts[request.id]?.joined);
  }
  return { replicas, mock: upstream, member, control, request, rows, holds, joined, close };
}
