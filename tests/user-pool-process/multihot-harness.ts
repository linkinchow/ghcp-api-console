import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { apiKey, bounded, model, origin, osKeys } from './replicas-safety.js';
import { startMock } from './replicas-mock.js';
import { count, deadline, gate, hotCount } from './multihot-safety.js';

export interface Snapshot {
  pid: number; connectionLimit: number; queueLimit: number; waitForConnections: boolean; samples: number;
  current: { nativeQueued: number; connections: number; free: number; active: number; queued: number; retainedTickets: number; scopes: number };
  maximum: { nativeQueued: number; connections: number; active: number; queued: number; retainedTickets: number };
}
export interface Replica { child: ChildProcess; pid: number; instance: string; proxy: string; control: string }
export async function fixture(t: TestContext) {
  const supplied = gate(process.env); const end = deadline(process.env);
  const database = `ghcp_pool_test_${randomUUID().replaceAll('-', '')}`;
  assert.notEqual(supplied.pathname, `/${database}`);
  const db = new URL(supplied); db.pathname = `/${database}`;
  const adminUrl = new URL(supplied); adminUrl.pathname = '/';
  const key = randomBytes(32).toString('hex');
  const replicas: Replica[] = []; const children: ChildProcess[] = [];
  const blockers: Array<{ connection: Connection; name: string; id: number }> = [];
  const pending: Promise<unknown>[] = []; const abort = new AbortController();
  let admin: Connection | undefined; let mock: Awaited<ReturnType<typeof startMock>> | undefined;
  let created = false; let closing: Promise<void> | undefined;
  const live = () => { assert.equal(closing, undefined, 'Fixture closing'); t.signal.throwIfAborted(); assert.ok(Date.now() < end); };
  const track = <T>(p: Promise<T>) => { void p.catch(() => {}); assert.ok(pending.length < 300); pending.push(p); return p; };
  async function query(sql: string, values: unknown[] = []) {
    live(); const [rows] = await admin!.query<RowDataPacket[]>({ sql, values, timeout: 2000 }); return rows;
  }
  function close(): Promise<void> {
    return closing ??= (async () => {
      abort.abort(); const errors: string[] = [];
      for (const { connection } of blockers) connection.destroy();
      await Promise.all(children.map(async child => {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
          try {
            if (child.connected) child.send({ type: 'shutdown' }, () => {});
            await bounded(exited, 'child graceful close', 5500);
          } catch {
            child.kill('SIGKILL');
            try { await bounded(exited, 'child forced close', 1500); } catch { errors.push('child_still_live'); }
          }
        }
        if (child.exitCode !== 0) errors.push('child_exit_failed');
      }));
      try { await mock?.close(); } catch { errors.push('mock_close_failed'); }
      try { await bounded(Promise.allSettled(pending), 'HTTP drain', 1000); } catch { errors.push('http_drain_failed'); }
      if (created && children.every(child => child.exitCode !== null || child.signalCode !== null)) {
        try {
          await admin!.query({ sql: `DROP DATABASE \`${database}\``, timeout: 2000 });
          t.diagnostic(`Cleanup: all ${children.length} owned children exited; dropped sibling ${database}; ${blockers.length} named-lock sockets destroyed`);
        } catch { errors.push('database_drop_failed'); }
      } else if (created) errors.push('database_retained_live_child');
      try { if (admin) await bounded(admin.end(), 'observer close', 1000); } catch { admin?.destroy(); errors.push('observer_close_failed'); }
      assert.deepEqual(errors, [], `Manual cleanup may be required for ${database}`);
    })();
  }
  t.after(close);
  const { createConnection } = await import('mysql2/promise');
  live(); admin = await createConnection({ uri: adminUrl.toString(), connectTimeout: 2000 });
  live(); await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`, timeout: 2000 }); created = true;
  function control<T = Record<string, unknown>>(replica: Replica, command: string, body?: unknown): Promise<T> {
    live(); return track((async () => {
      const response = await fetch(`${replica.control}/${command}`, { method: command === 'state' ? 'GET' : 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.any([abort.signal, t.signal, AbortSignal.timeout(8000)]), body: body === undefined ? undefined : JSON.stringify(body) });
      assert.equal(response.status, 200, `Control ${command} failed`); return await response.json() as T;
    })());
  }
  mock = await startMock(async task => {
    assert.ok(replicas[0]); await control(replicas[0], 'oauth-callback', { identity: task.identity, nonce: task.oauthAttemptId });
  });
  const upstream = mock;
  for (let index = 0; index < count; index++) {
    live(); const env: NodeJS.ProcessEnv = {};
    for (const name of osKeys) if (process.env[name]) env[name] = process.env[name];
    Object.assign(env, { NODE_ENV: 'test', MYSQL_POOL_MULTIHOT_TEST: '1', MYSQL_POOL_REPLICAS_TEST: '1', MYSQL_POOL_TEST_DISPOSABLE: '1',
      MYSQL_TEST_URL: db.toString(), MULTIHOT_RUNNER: '1', MULTIHOT_DEADLINE_AT: String(end),
      REPLICAS_CHILD: '1', REPLICAS_COUNT: String(count), REPLICAS_MOCK_ORIGIN: upstream.origin, REPLICAS_CONTROL_KEY: key,
      TSX_TSCONFIG_PATH: fileURLToPath(new URL('./multihot-tsconfig.json', import.meta.url)) });
    const child = fork(fileURLToPath(new URL('./multihot-child.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'], env, cwd: fileURLToPath(new URL('../../', import.meta.url)), silent: true,
    });
    children.push(child);
    // Drain but never print product stdout/stderr (may contain raw SQL or credentials).
    child.stdout?.resume(); child.stderr?.resume();
    child.on('error', () => {});
    if (child.pid) process.send?.({ type: 'multihot-child-started', pid: child.pid });
    child.once('exit', () => process.send?.({ type: 'multihot-child-exited', pid: child.pid }));
    let info: Omit<Replica, 'child'> | undefined; let instrumented = false;
    await bounded(new Promise<void>((resolve, reject) => {
      const cleanup = () => { child.off('message', message); child.off('exit', failed); child.off('error', failed); };
      const failed = () => { cleanup(); reject(new Error('Replica initialization failed (logs suppressed)')); };
      const message = (value: unknown) => {
        try {
          assert.ok(value && typeof value === 'object' && 'type' in value);
          if (value.type === 'ready') {
            info = value as unknown as Omit<Replica, 'child'>;
            assert.equal(info.pid, child.pid); assert.notEqual(info.pid, process.pid);
            assert.match(info.instance, /^[a-f0-9-]{36}$/); origin(info.proxy); origin(info.control);
          } else if (value.type === 'multihot-instrumented') instrumented = true;
          else if (value.type === 'fatal') { failed(); return; }
          if (info && instrumented) { cleanup(); resolve(); }
        } catch { failed(); }
      };
      child.on('message', message); child.once('exit', failed); child.once('error', failed);
    }), 'replica startup', Math.min(15000, Math.max(1, end - Date.now() - 15000)));
    replicas.push({ ...info!, child }); upstream.allowPid(info!.pid);
  }
  for (const field of ['pid', 'instance', 'proxy', 'control'] as const) assert.equal(new Set(replicas.map(r => r[field])).size, count);
  assert.equal(upstream.calls.length, 0);
  await Promise.all(replicas.map(r => control(r, 'start')));
  t.diagnostic(`Five independent route/worker children: ${replicas.map(r => r.pid).join(', ')}; sibling ${database}; at most 20 product + 4 fixture DB connections`);
  const rows = (table: 'user_pool_accounts' | 'user_pool_leases' | 'user_pool_holds' | 'user_pool_catalog_holds') => query(`SELECT * FROM \`${database}\`.\`${table}\``);
  const holds = async () => [...await rows('user_pool_holds'), ...await rows('user_pool_catalog_holds')];
  async function readyIdle() {
    return query(`SELECT p.identity FROM \`${database}\`.user_pool_accounts p JOIN \`${database}\`.proxy_accounts a ON a.identity=p.identity
      WHERE p.state='ready' AND p.verified_at IS NOT NULL AND a.copilot_oauth_status='valid' AND LENGTH(a.copilot_oauth_token)>0
      AND NOT EXISTS (SELECT 1 FROM \`${database}\`.user_pool_leases l WHERE l.member_identity=p.identity)
      AND NOT EXISTS (SELECT 1 FROM \`${database}\`.user_pool_catalog_holds h WHERE h.member_identity=p.identity)`);
  }
  function request(replica: Replica, identity: string, kind: string) {
    live(); const start = performance.now();
    return track(fetch(`${replica.proxy}/v1/messages`, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}`, 'X-User-Identity': identity, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 8, stream: false, messages: [{ role: 'user', content: kind }] }),
      signal: AbortSignal.any([abort.signal, t.signal, AbortSignal.timeout(8000)]),
    }).then(async response => ({ pid: replica.pid, kind, status: response.status, text: await response.text(),
      contentType: response.headers.get('content-type'), retryAfter: response.headers.get('retry-after'), ms: performance.now() - start })));
  }
  async function snapshot(replica: Replica): Promise<Snapshot> {
    live();
    const message = new Promise<Snapshot>((resolve, reject) => {
      const cleanup = () => { replica.child.off('message', receive); replica.child.off('exit', failed); };
      const failed = () => { cleanup(); reject(new Error('Snapshot child exited')); };
      const receive = (value: unknown) => {
        if (value && typeof value === 'object' && 'type' in value && value.type === 'multihot-snapshot') {
          cleanup(); resolve((value as unknown as { snapshot: Snapshot }).snapshot);
        }
      };
      replica.child.on('message', receive); replica.child.once('exit', failed);
      replica.child.send({ type: 'multihot-snapshot' }, error => { if (error) failed(); });
    });
    const result = await bounded(message, 'pool snapshot', 2000); assert.equal(result.pid, replica.pid); return result;
  }
  const sessions = () => query('SELECT ID AS id, INFO AS statement FROM information_schema.PROCESSLIST WHERE DB=?', [database]);
  async function holdCallers(identities: string[]) {
    live(); assert.equal(blockers.length, 0); assert.equal(identities.length, hotCount); assert.equal(new Set(identities).size, hotCount);
    for (const identity of identities) {
      live(); const connection = await createConnection({ uri: db.toString(), connectTimeout: 2000 });
      const name = createHash('sha256').update(JSON.stringify([database, identity])).digest('hex');
      const blocker = { connection, name, id: connection.threadId }; blockers.push(blocker);
      const [rows] = await connection.query<RowDataPacket[]>({ sql: 'SELECT GET_LOCK(?, 0) AS acquired', values: [name], timeout: 2000 });
      assert.equal(Number(rows[0].acquired), 1);
    }
    const started = performance.now();
    return {
      started, blockers,
      release: async () => {
        for (const blocker of blockers) {
          try {
            const [rows] = await blocker.connection.query<RowDataPacket[]>({ sql: 'SELECT RELEASE_LOCK(?) AS released', values: [blocker.name], timeout: 2000 });
            assert.equal(Number(rows[0].released), 1);
          } finally { blocker.connection.destroy(); }
        }
      },
    };
  }
  async function lockOwners() {
    const owners: Array<number | null> = [];
    for (const blocker of blockers) { const rows = await query('SELECT IS_USED_LOCK(?) AS owner', [blocker.name]); owners.push(rows[0].owner === null ? null : Number(rows[0].owner)); }
    return owners;
  }
  return { database, replicas, mock: upstream, rows, holds, readyIdle, request, snapshot, sessions, holdCallers, lockOwners, close };
}
