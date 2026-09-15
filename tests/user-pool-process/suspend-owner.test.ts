import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Connection, Pool, RowDataPacket } from 'mysql2/promise';
import { CREATED_AT, options, siblingUrl } from './worker-common.js';
import { WorkerMock } from './worker-mock.js';
import { BASELINE, bounded, pause, pollUntil, suspendEnvironment, suspendGate, type SuspendMessage } from './suspend-common.js';

type Exit = { code: number | null; signal: NodeJS.Signals | null };
class SuspendedWorker {
  readonly child: ChildProcess;
  readonly messages: SuspendMessage[] = [];
  readonly exit: Promise<Exit>;
  exited?: Exit;
  private failed = false;
  private readonly watchdog: ReturnType<typeof setTimeout>;
  constructor(url: URL, database: string, origin: string, role: 'old' | 'successor', private readonly signal: AbortSignal) {
    signal.throwIfAborted();
    this.child = fork(fileURLToPath(new URL('./suspend-child.ts', import.meta.url)), [], {
      cwd: fileURLToPath(new URL('.', import.meta.url)), execArgv: ['--import', 'tsx'],
      env: suspendEnvironment(url, database, origin, role), stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.child.on('message', message => {
      if (this.messages.length >= 5000) { this.failed = true; return; }
      this.messages.push(message as SuspendMessage);
    });
    this.exit = new Promise(resolve => {
      this.child.once('error', () => {
        this.failed = true;
        if (!this.child.pid) { this.exited = { code: 1, signal: null }; resolve(this.exited); }
      });
      this.child.once('exit', (code, signal) => {
        this.exited = { code, signal }; clearTimeout(this.watchdog); resolve(this.exited);
      });
    });
    // Parent-side timer remains runnable while the child's entire event loop is stopped.
    this.watchdog = setTimeout(() => { void this.kill().catch(() => { this.failed = true; }); }, 110000);
  }
  message(kind: SuspendMessage['kind'], timeout = 12000, since = 0): Promise<SuspendMessage> {
    return pollUntil(`child ${kind}`, () => {
      assert.equal(this.failed, false, 'Child process failure (details suppressed)');
      assert.equal(this.messages.some(message => message.kind === 'fatal'), false, 'Child assertion failed (details suppressed)');
      const found = this.messages.slice(since).find(message => message.kind === kind);
      if (!found) assert.equal(this.exited, undefined, 'Child exited before evidence arrived');
      if (found) assert.equal(found.pid, this.child.pid);
      return found;
    }, this.signal, timeout);
  }
  send(kind: string): void { this.child.send({ kind }, error => { if (error) this.failed = true; }); }
  async kill(): Promise<Exit> {
    if (!this.exited) {
      // Always continue before termination, including partial setup/timeouts/interrupts.
      // Only the ChildProcess we created is targeted; never PID lookup or process groups.
      this.child.kill('SIGCONT');
      this.child.kill('SIGKILL');
    }
    const exit = await bounded('confirmed child exit', this.exit, 10000);
    clearTimeout(this.watchdog);
    return exit;
  }
  async stop(): Promise<void> {
    if (this.exited) return;
    this.child.kill('SIGCONT');
    this.send('stop');
    try {
      await this.message('stopped');
      assert.equal((await bounded('graceful child exit', this.exit, 10000)).code, 0);
    } finally { if (!this.exited) await this.kill(); }
  }
}

const selected = suspendGate(process.env);
test('SIGSTOP expires real owner TTL; SIGCONT checkpoint is SQL/local fenced; successor finishes same Login task', {
  skip: selected ? false : 'UNRUN: Linux + MYSQL_POOL_SUSPEND_TEST=1 and existing disposable MySQL opt-ins required',
  timeout: 140000,
}, async t => {
  // The documented launcher strips everything except fixture values before imports.
  assert.equal(process.env.DOTENV_CONFIG_PATH, '/dev/null');
  for (const key of ['SSO_BASE_URL', 'LOGIN_BASE_URL', 'COPILOT_API_BASE_URL']) assert.equal(process.env[key], 'http://127.0.0.1:0');
  for (const key of ['NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'GH_TOKEN', 'GITHUB_TOKEN']) assert.equal(process.env[key], undefined);
  const [{ createPool }, { MysqlStorage }] = await Promise.all([
    import('mysql2/promise'), import('../../src/proxy/src/db/mysqlStorage.js'),
  ]);
  const { database, url, admin: adminUrl } = siblingUrl(selected!);
  const admin = createPool({ uri: adminUrl.toString(), connectionLimit: 1, connectTimeout: 5000 });
  const sockets = new Set<Connection>();
  const track = (connection: Connection) => { sockets.add(connection); };
  admin.on('connection', track);
  let pool: Pool | undefined, created = false, mockStarted = false;
  const children: SuspendedWorker[] = [];
  const mock = new WorkerMock();
  let cleaning: Promise<void> | undefined;
  const cleanup = () => cleaning ??= (async () => {
    const failures: unknown[] = [];
    const attempt = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { failures.push(error); } };
    await Promise.all(children.map(child => attempt(() => child.kill())));
    if (mockStarted) await attempt(() => bounded('mock close', mock.close(), 5000));
    for (const socket of sockets) socket.destroy();
    if (pool) await attempt(() => bounded('pool close', pool!.end(), 5000));
    if (created && children.every(child => child.exited)) {
      await attempt(() => bounded('sibling DROP', admin.query({ sql: `DROP DATABASE \`${database}\``, timeout: 10000 }), 12000));
    } else if (created) failures.push(new Error('Child exit unconfirmed; refusing DROP'));
    for (const socket of sockets) socket.destroy();
    await attempt(() => bounded('admin close', admin.end(), 5000));
    if (failures.length) throw new Error(`Suspend cleanup incomplete; inspect disposable sibling ${database} (${failures.length} steps)`);
  })();
  const interrupted = () => { void cleanup().then(() => process.exit(1), () => process.exit(1)); };
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  t.after(async () => {
    try { await cleanup(); }
    finally { process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted); }
  });
  const wait = <T>(label: string, predicate: () => Promise<T | undefined | false> | T | undefined | false, timeout = 12000) =>
    pollUntil(label, predicate, t.signal, timeout);
  try {
    t.diagnostic(`sourceBaseline=${BASELINE}; disposable sibling=${database}; parentPid=${process.pid}`);
    // The caller's marker database is NEVER selected, migrated or dropped.
    await bounded('sibling CREATE', admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`, timeout: 10000 }), 12000);
    created = true;
    t.signal.throwIfAborted();
    pool = createPool({ uri: url.toString(), connectionLimit: 6, connectTimeout: 5000,
      timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
    pool.on('connection', track);
    const storage = new MysqlStorage(pool, 2);
    await bounded('fixture migration', storage.initialize(), 20000);
    const store = await bounded('fixture store init', storage.userPool(options), 20000);
    t.signal.throwIfAborted();
    const seed = await bounded('seed reserve', store.reserve(), 20000);
    t.signal.throwIfAborted();
    assert.ok(seed);
    await bounded('seed credential', storage.createAccount({ identity: seed.identity, ssoUser: seed.identity, ghLogin: `${seed.identity}_synthetic` }), 20000);
    t.signal.throwIfAborted();
    assert.equal(await bounded('seed inventory', store.update(seed.identity, { stage: 'synced', sso_created_at: CREATED_AT }), 20000), true);
    t.signal.throwIfAborted();
    // END parent data writes. Below: bounded SELECTs only (apart from teardown DROP).
    const select = async (sql: string) => {
      assert.match(sql, /^SELECT /);
      return (await bounded('parent observation', pool!.query<RowDataPacket[]>({ sql, timeout: 5000 }), 6000))[0];
    };
    const inventory = async () => {
      const rows = await select('SELECT * FROM user_pool_accounts');
      assert.equal(rows.length, 1); return rows[0];
    };
    const account = async () => {
      const rows = await select('SELECT * FROM proxy_accounts');
      assert.equal(rows.length, 1); return rows[0];
    };
    const ownerRow = async () => {
      const rows = await select('SELECT owner, owner_until, ' +
        "TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000 AS db_now FROM user_pool_settings WHERE id=1");
      return { owner: rows[0].owner as string | null, until: Number(rows[0].owner_until), now: Number(rows[0].db_now) };
    };
    await bounded('mock listen', mock.start(), 5000); mockStarted = true;
    mock.reset(seed.identity, 0);
    const old = new SuspendedWorker(url, database, mock.origin, 'old', t.signal); children.push(old);
    const boot = await old.message('boot');
    assert.notEqual(boot.pid, process.pid);
    const claim = await old.message('claim');
    const held = await old.message('checkpoint-held');
    assert.equal(held.owner, claim.owner);
    assert.equal(mock.taskPosts, 1);
    const task = mock.tasks[0];
    const intent = await inventory();
    const originalAccount = await account();
    assert.equal(intent.stage, 'oauth-dispatch'); assert.equal(intent.state, 'provisioning');
    assert.equal(intent.task_id, null); assert.equal(intent.oauth_attempt_id, task.oauthAttemptId);
    assert.equal(held.taskId, task.id); assert.equal(held.nonce, task.oauthAttemptId);
    assert.equal(held.attempt, intent.attempt_id); assert.equal(held.generation, Number(intent.generation));
    assert.equal(originalAccount.copilot_oauth_attempt_id, task.oauthAttemptId);
    assert.equal((await ownerRow()).owner, claim.owner);
    assert.equal(old.child.kill('SIGSTOP'), true);
    // Linux procfs confirms OS suspension, not merely signal-request acceptance.
    await wait('kernel stopped state', async () => {
      const stat = await bounded('procfs stopped observation', readFile(`/proc/${old.child.pid}/stat`, 'utf8'), 2000);
      return stat.slice(stat.lastIndexOf(')') + 2).startsWith('T') || undefined;
    });
    const stopped = await ownerRow();
    const stoppedAt = performance.now();
    assert.equal(stopped.owner, claim.owner);
    assert.ok(stopped.until - stopped.now > 25000 && stopped.until - stopped.now <= 30000,
      'Actual production 30s owner TTL, not shortened or mutated');
    const successor = new SuspendedWorker(url, database, mock.origin, 'successor', t.signal); children.push(successor);
    const nextBoot = await successor.message('boot');
    assert.notEqual(nextBoot.pid, boot.pid); assert.notEqual(nextBoot.pid, process.pid);
    await successor.message('standby');
    assert.equal((await ownerRow()).owner, claim.owner, 'Successor cannot steal unexpired lease');
    const nextClaim = await successor.message('claim', 45000);
    const takeoverWaitMs = Math.round(performance.now() - stoppedAt);
    assert.notEqual(nextClaim.owner, claim.owner);
    assert.ok(nextClaim.dbNow! >= stopped.until);
    assert.ok(takeoverWaitMs >= stopped.until - stopped.now - 1000, 'Natural expiry consumes wall time');
    const adopted = await successor.message('checkpoint-held');
    assert.equal(adopted.owner, nextClaim.owner); assert.equal(adopted.taskId, task.id);
    assert.equal(adopted.nonce, held.nonce); assert.equal(adopted.attempt, held.attempt); assert.equal(adopted.generation, held.generation);
    assert.ok(mock.requests.some(request => request.method === 'GET' && request.path === '/api/tasks'));
    assert.deepEqual(await inventory(), intent, 'Successor checkpoint held so the old row fence STILL matches');
    assert.deepEqual(await account(), originalAccount);
    assert.equal((await ownerRow()).owner, nextClaim.owner);
    assert.equal(old.exited, undefined);
    assert.equal(old.child.kill('SIGCONT'), true);
    old.send('resume-old');
    const resumed = await old.message('resumed');
    const rejected = await old.message('checkpoint-result');
    assert.equal(rejected.owner, claim.owner); assert.equal(rejected.sameFence, true);
    assert.equal(rejected.accepted, false); assert.equal(rejected.unchanged, true);
    const fenced = await old.message('local-fenced');
    for (const evidence of [resumed, fenced]) {
      assert.equal(evidence.active, false);
      assert.equal(evidence.snapshot?.state, 'standby');
      assert.equal(evidence.snapshot?.ownershipAcquisitions, 1);
      assert.equal(evidence.snapshot?.ownershipLosses, 1);
      assert.equal(evidence.snapshot?.lastOwnershipLoss?.reason, 'local_tenure_expired');
      assert.equal(evidence.steps, held.steps); assert.equal(evidence.httpCalls, held.httpCalls); assert.equal(evidence.updates, held.updates);
    }
    assert.deepEqual(await inventory(), intent, 'Resumed in-flight SQL checkpoint made no inventory write');
    assert.deepEqual(await account(), originalAccount, 'Old tenure made no credential write');
    assert.equal(mock.taskPosts, 1); assert.equal(mock.warmups, 0);
    successor.send('release-successor');
    assert.equal((await successor.message('checkpoint-result')).accepted, true);
    await wait('successor task checkpoint', async () => (await inventory()).task_id === task.id);
    successor.send('complete');
    const callback = await successor.message('callback');
    assert.equal(callback.nonce, task.oauthAttemptId);
    task.status = 'success';
    const ready = await wait('successor real warmup ready', async () => {
      const row = await inventory(); return row.state === 'ready' ? row : undefined;
    });
    assert.equal(ready.stage, 'ready'); assert.equal(ready.attempt_id, intent.attempt_id);
    assert.equal(ready.oauth_attempt_id, task.oauthAttemptId); assert.equal(ready.task_id, task.id);
    assert.equal(Number(ready.attempts), 0); assert.equal(ready.last_error, null); assert.ok(ready.verified_at);
    const finalAccount = await account();
    assert.equal(finalAccount.copilot_oauth_status, 'valid'); assert.equal(finalAccount.copilot_oauth_attempt_id, null);
    // More than one ordinary tick; old stays alive as standby, not killed to force success.
    for (let cycle = 0; cycle < 4; cycle++) {
      await pause(options.pollMs);
      assert.deepEqual(await inventory(), ready); assert.deepEqual(await account(), finalAccount);
      const since = old.messages.length; old.send('status');
      const status = await old.message('status', 12000, since);
      assert.equal(status.active, false); assert.equal(status.steps, held.steps);
      assert.equal(status.httpCalls, held.httpCalls); assert.equal(status.updates, held.updates);
      assert.equal(status.snapshot?.ownershipAcquisitions, 1); assert.equal(status.snapshot?.ownershipLosses, 1);
    }
    const since = successor.messages.length; successor.send('status');
    assert.equal((await successor.message('status', 12000, since)).active, true);
    const finalOwner = await ownerRow();
    assert.equal(finalOwner.owner, nextClaim.owner); assert.ok(finalOwner.until > finalOwner.now);
    assert.equal(mock.taskPosts, 1); assert.equal(mock.tasks.length, 1);
    assert.equal(mock.requests.filter(request => request.method === 'POST' && request.path === '/api/tasks').length, 1);
    assert.equal(mock.requests.filter(request => request.method === 'POST' && request.path.endsWith('/login-credentials')).length, 1);
    assert.equal(mock.modelGets, 1); assert.equal(mock.warmups, 1); assert.deepEqual(mock.errors, []);
    t.diagnostic(JSON.stringify({ sourceBaseline: BASELINE, parentPid: process.pid, stoppedPid: boot.pid, successorPid: nextBoot.pid,
      originalOwner: claim.owner, successorOwner: nextClaim.owner, expiredAt: stopped.until, claimedAt: nextClaim.dbNow, takeoverWaitMs,
      originalTask: task.id, originalNonce: task.oauthAttemptId, sqlFence: rejected, localFence: fenced.snapshot,
      taskPosts: mock.taskPosts, warmups: mock.warmups, callbackLayer: 'synthetic successor repository callback; not HTTP route',
      finalState: ready.state, http: mock.requests.filter(request => request.path.startsWith('/api/tasks')) }));
    await old.stop(); await successor.stop();
  } finally { await cleanup(); }
});
