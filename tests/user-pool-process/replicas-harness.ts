import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { apiKey, bounded, gate, model, origin, osKeys, replicaCount } from './replicas-safety.js';
import { startMock } from './replicas-mock.js';

export interface Replica { child: ChildProcess; pid: number; instance: string; proxy: string; control: string; killed: boolean; }
export interface State { pid: number; owners: string[]; scheduler: { scope: string; state: string; ownershipAcquisitions: number }; }
const dbNow = "(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000)";
export async function fixture(t: TestContext, requested: 3 | 5) {
  const supplied = gate(process.env); // Before imports, fork, listener or MySQL connection.
  const count = replicaCount(String(requested));
  const database = `ghcp_pool_test_${randomUUID().replaceAll('-', '')}`;
  assert.notEqual(supplied.pathname, `/${database}`);
  const db = new URL(supplied); db.pathname = `/${database}`;
  const adminUrl = new URL(supplied); adminUrl.pathname = '/';
  const key = randomBytes(32).toString('hex');
  const replicas: Replica[] = [];
  const children: Array<{ child: ChildProcess; log: string; killed: boolean }> = [];
  const pending: Promise<unknown>[] = [];
  const abort = new AbortController();
  let admin: Connection | undefined;
  let lock: Connection | undefined;
  let mock: Awaited<ReturnType<typeof startMock>> | undefined;
  let created = false;
  let closing: Promise<void> | undefined;
  function live() { assert.equal(closing, undefined, 'Fixture closing'); t.signal.throwIfAborted(); }
  function track<T>(p: Promise<T>): Promise<T> { void p.catch(() => {}); pending.push(p); return p; }
  function close(): Promise<void> {
    return closing ??= (async () => {
      abort.abort(); const errors: unknown[] = [];
      // Dedicated lock socket destruction releases its named lock even on failure.
      lock?.destroy(); lock = undefined;
      await Promise.all(children.map(async state => {
        const child = state.child;
        try {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
            try {
              if (child.connected) child.send({ type: 'shutdown' }, () => {});
              await bounded(exited, 'graceful child exit', 6500);
            } catch { child.kill('SIGKILL'); await bounded(exited, 'forced child exit', 3000); }
          }
          if (state.killed) assert.equal(child.signalCode, 'SIGKILL');
          else assert.equal(child.exitCode, 0, `Unexpected child exit ${child.exitCode}/${child.signalCode}; ${state.log}`);
        } catch (error) { errors.push(error); }
      }));
      try { await mock?.close(); } catch (error) { errors.push(error); }
      try { await bounded(Promise.allSettled(pending), 'HTTP client drain', 3000); } catch (error) { errors.push(error); }
      const dead = children.every(({ child }) => child.exitCode !== null || child.signalCode !== null);
      try {
        if (created && dead) {
          await admin!.query({ sql: `DROP DATABASE \`${database}\``, timeout: 5000 });
          t.diagnostic(`Cleanup: all ${count} owned children exited; dropped ${database}`);
        } else if (created) errors.push(new Error(`Manual cleanup required for ${database}; child still alive`));
      } catch (error) { errors.push(error); }
      try { if (admin) await bounded(admin.end(), 'admin close', 3000); } catch (error) { admin?.destroy(); errors.push(error); }
      if (errors.length) throw new AggregateError(errors, `Replica cleanup failed: ${database}`);
    })();
  }
  t.after(close);
  const { createConnection } = await import('mysql2/promise');
  live(); admin = await createConnection({ uri: adminUrl.toString(), connectTimeout: 3000 });
  live(); await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`, timeout: 5000 }); created = true;
  function control<T = Record<string, unknown>>(replica: Replica, command: string, body?: unknown): Promise<T> {
    live(); return track((async () => {
      assert.equal(replica.killed, false);
      const response = await fetch(`${replica.control}/${command}`, {
        method: command === 'state' ? 'GET' : 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.any([abort.signal, t.signal, AbortSignal.timeout(12000)]), body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text(); assert.equal(response.status, 200, `Control ${command}: ${text}`); return JSON.parse(text) as T;
    })());
  }
  live(); mock = await startMock(async task => {
    const replica = replicas.find(replica => !replica.killed); assert.ok(replica);
    await control(replica, 'oauth-callback', { identity: task.identity, nonce: task.oauthAttemptId });
  });
  const upstream = mock;
  for (let index = 0; index < count; index++) {
    live(); const env: NodeJS.ProcessEnv = {};
    for (const name of osKeys) if (process.env[name]) env[name] = process.env[name];
    Object.assign(env, { NODE_ENV: 'test', MYSQL_POOL_REPLICAS_TEST: '1', MYSQL_POOL_TEST_DISPOSABLE: '1', MYSQL_TEST_URL: db.toString(),
      REPLICAS_CHILD: '1', REPLICAS_COUNT: String(count), REPLICAS_MOCK_ORIGIN: upstream.origin, REPLICAS_CONTROL_KEY: key,
      TSX_TSCONFIG_PATH: fileURLToPath(new URL('./replicas-tsconfig.json', import.meta.url)) });
    const child = fork(fileURLToPath(new URL('./replicas-child.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'], env, cwd: fileURLToPath(new URL('../../', import.meta.url)), silent: true,
    });
    const state = { child, log: '', killed: false }; children.push(state);
    const ceiling = setTimeout(() => child.kill('SIGKILL'), 195000); ceiling.unref(); child.once('exit', () => clearTimeout(ceiling));
    // Only retain sanitized tail; never expose supplied database credentials or raw SQL errors.
    child.on('error', () => { state.log = 'child_process_error'; });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => {
      let value = String(chunk).replace(/mysql:\/\/\S+/g, '[redacted-mysql]');
      if (db.password) value = value.replaceAll(decodeURIComponent(db.password), '[redacted]');
      state.log = (state.log + value).slice(-1500);
    });
    const info = await bounded(new Promise<Omit<Replica, 'child' | 'killed'>>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Child exited during initialization')));
      child.once('message', message => {
        try {
          assert.ok(message && typeof message === 'object' && 'type' in message && message.type === 'ready', 'Child initialization failed');
          const info = message as unknown as Omit<Replica, 'child' | 'killed'>;
          assert.equal(info.pid, child.pid); assert.notEqual(info.pid, process.pid); assert.match(info.instance, /^[a-f0-9-]{36}$/);
          origin(info.proxy); origin(info.control); resolve(info);
        } catch (error) { reject(error); }
      });
    }), 'replica startup', 20000);
    replicas.push({ ...info, child, killed: false }); upstream.allowPid(info.pid);
  }
  for (const field of ['pid', 'instance', 'proxy', 'control'] as const) assert.equal(new Set(replicas.map(r => r[field])).size, count);
  t.diagnostic(`Independent ${count} Node route/worker children: ${replicas.map(r => r.pid).join(', ')}; sibling ${database}`);
  // Auth failures happen before scheduler start, so the zero-upstream assertion is deterministic.
  for (const r of replicas) {
    for (const [url, status, method] of [[`${r.proxy}/v1/models`, 401, 'GET'], [`${r.control}/start`, 403, 'POST']] as const) {
      const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.any([t.signal, abort.signal, AbortSignal.timeout(3000)]) });
      assert.equal(response.status, status); await response.text();
    }
  }
  assert.equal(upstream.calls.length, 0);
  await Promise.all(replicas.map(r => control(r, 'start')));
  // Parent never imports production runtime. Observer SQL is read-only, except
  // dedicated database DDL and one documented session-scoped contention lock.
  async function rows(table: 'user_pool_accounts' | 'user_pool_leases' | 'user_pool_holds' | 'user_pool_catalog_holds' | 'user_pool_events') {
    live(); const [rows] = await admin!.query<RowDataPacket[]>({ sql: `SELECT * FROM \`${database}\`.\`${table}\``, timeout: 3000 }); return rows;
  }
  async function owner() {
    live(); const [rows] = await admin!.query<RowDataPacket[]>({ sql: `SELECT owner, owner_until, ${dbNow} AS db_now,
      (owner IS NOT NULL AND owner_until>${dbNow}) AS valid FROM \`${database}\`.user_pool_settings WHERE id=1`, timeout: 3000 });
    assert.equal(rows.length, 1); return { owner: String(rows[0].owner), until: Number(rows[0].owner_until), now: Number(rows[0].db_now), valid: Number(rows[0].valid) === 1 };
  }
  async function holds() { return [...await rows('user_pool_holds'), ...await rows('user_pool_catalog_holds')]; }
  async function readyIdle() {
    live(); const [rows] = await admin!.query<RowDataPacket[]>({ sql: `SELECT p.identity FROM \`${database}\`.user_pool_accounts p
      JOIN \`${database}\`.proxy_accounts a ON a.identity=p.identity
      WHERE p.state='ready' AND p.verified_at IS NOT NULL AND a.copilot_oauth_status='valid' AND LENGTH(a.copilot_oauth_token)>0
      AND NOT EXISTS (SELECT 1 FROM \`${database}\`.user_pool_leases l WHERE l.member_identity=p.identity)
      AND NOT EXISTS (SELECT 1 FROM \`${database}\`.user_pool_catalog_holds h WHERE h.member_identity=p.identity)`, timeout: 3000 });
    return rows.map(row => String(row.identity));
  }
  function request(replica: Replica, identity: string, kind: string, ms = 18000) {
    live(); assert.equal(replica.killed, false);
    const start = performance.now();
    return track(fetch(`${replica.proxy}/v1/messages`, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}`, 'X-User-Identity': identity, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 8, stream: false, messages: [{ role: 'user', content: kind }] }),
      signal: AbortSignal.any([abort.signal, t.signal, AbortSignal.timeout(ms)]),
    }).then(async response => ({ status: response.status, text: await response.text(), ms: performance.now() - start, pid: replica.pid })));
  }
  async function kill(replica: Replica) {
    live(); assert.ok(replicas.includes(replica)); assert.equal(replica.killed, false);
    const observed = await owner();
    assert.ok(observed.valid); const state = await control<State>(replica, 'state'); assert.ok(state.owners.includes(observed.owner));
    const exited = new Promise<void>(resolve => replica.child.once('exit', () => resolve()));
    replica.killed = true; children.find(state => state.child === replica.child)!.killed = true;
    assert.equal(replica.child.kill('SIGKILL'), true); await bounded(exited, 'actual owner SIGKILL', 3000);
    assert.equal(replica.child.signalCode, 'SIGKILL');
  }
  async function holdCaller(identity: string) {
    live(); assert.equal(lock, undefined);
    lock = await createConnection({ uri: db.toString(), connectTimeout: 3000 });
    const name = createHash('sha256').update(JSON.stringify([database, identity])).digest('hex');
    const [rows] = await lock.query<RowDataPacket[]>({ sql: 'SELECT GET_LOCK(?, 0) AS acquired', values: [name], timeout: 3000 });
    assert.equal(Number(rows[0].acquired), 1);
    return async () => {
      if (!lock) return;
      try {
        const [rows] = await lock.query<RowDataPacket[]>({ sql: 'SELECT RELEASE_LOCK(?) AS released', values: [name], timeout: 3000 });
        assert.equal(Number(rows[0].released), 1);
      } finally { lock.destroy(); lock = undefined; }
    };
  }
  return { database, replicas, mock: upstream, control, rows, owner, holds, readyIdle, request, kill, holdCaller, close };
}
