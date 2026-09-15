import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Connection, Pool, RowDataPacket } from 'mysql2/promise';
import { childEnvironment, CREATED_AT, OAUTH_TOKEN, optedIn, options, siblingUrl, type WorkerMessage } from './worker-common.js';
import { WorkerMock } from './worker-mock.js';

type Exit = { code: number | null; signal: NodeJS.Signals | null };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function bounded<T>(label: string, operation: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}
async function pollUntil<T>(label: string, predicate: () => Promise<T | undefined | false> | T | undefined | false,
  timeout = 12000, signal?: AbortSignal): Promise<T> {
  const until = performance.now() + timeout;
  while (performance.now() < until) {
    signal?.throwIfAborted();
    const value = await predicate();
    signal?.throwIfAborted();
    if (value !== undefined && value !== false) return value;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
class WorkerProcess {
  readonly child: ChildProcess;
  readonly messages: WorkerMessage[] = [];
  readonly exit: Promise<Exit>;
  exited?: Exit;
  private spawnFailed = false;
  constructor(url: URL, database: string, holdCheckpoint: boolean, mockOrigin: string, private readonly signal: AbortSignal) {
    signal.throwIfAborted();
    this.child = fork(fileURLToPath(new URL('./worker-child.ts', import.meta.url)), [], {
      cwd: fileURLToPath(new URL('.', import.meta.url)), execArgv: ['--import', 'tsx'],
      env: childEnvironment(url, database, holdCheckpoint, mockOrigin), stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.child.on('message', message => { this.messages.push(message as WorkerMessage); });
    this.exit = new Promise(resolve => {
      this.child.once('error', () => {
        this.spawnFailed = true;
        if (!this.child.pid) { this.exited = { code: 1, signal: null }; resolve(this.exited); }
      });
      this.child.once('exit', (code, signal) => { this.exited = { code, signal }; resolve(this.exited); });
    });
  }
  message(kind: WorkerMessage['kind'], timeout = 12000): Promise<WorkerMessage> {
    return pollUntil(`child ${kind}`, () => {
      assert.equal(this.spawnFailed, false, 'Child process error (details suppressed)');
      assert.equal(this.messages.some(message => message.kind === 'fatal'), false, 'Child initialization failed (details suppressed)');
      const found = this.messages.find(message => message.kind === kind);
      if (!found) assert.equal(this.exited, undefined, 'Child exited before expected message');
      return found;
    }, timeout, this.signal);
  }
  async kill(): Promise<Exit> {
    // Never use PID lookup, process groups, pkill, taskkill, or process.kill.
    if (!this.exited) assert.equal(this.child.kill('SIGKILL'), true, 'OS termination request accepted');
    const result = await bounded('child exit', this.exit, 10000);
    assert.ok(this.exited, 'Real exit event observed, not merely child.killed');
    return result;
  }
  async stop(): Promise<void> {
    if (this.exited) return;
    this.child.send({ kind: 'stop' });
    try {
      await this.message('stopped');
      await bounded('clean child exit', this.exit, 10000);
      assert.equal(this.exited!.code, 0);
    } finally { if (!this.exited) await this.kill(); }
  }
}

const selected = optedIn(process.env);
test('prepared independent-process worker owner-death acceptance', {
  skip: selected ? false : 'UNRUN: MYSQL_POOL_PROCESS_TEST=1 plus disposable loopback MySQL required',
  timeout: 240000,
}, async t => {
  const { createPool } = await import('mysql2/promise');
  const { MysqlStorage } = await import('../../src/proxy/src/db/mysqlStorage.js');
  const { database, url, admin: adminUrl } = siblingUrl(selected!);
  const admin = createPool({ uri: adminUrl.toString(), connectionLimit: 1, connectTimeout: 5000 });
  // Track only connections created by this fixture so timeout teardown can destroy them.
  const sockets = new Set<Connection>();
  const track = (connection: Connection) => { sockets.add(connection); };
  admin.on('connection', track);
  let pool: Pool | undefined;
  let created = false;
  let mockStarted = false;
  const children: WorkerProcess[] = [];
  const mock = new WorkerMock();
  let cleaning: Promise<void> | undefined;
  const cleanup = () => cleaning ??= (async () => {
    const failures: unknown[] = [];
    const attempt = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { failures.push(error); } };
    // Complete independent cleanup steps even when one fails. Never DROP with live workers.
    await Promise.all(children.filter(child => !child.exited).map(child => attempt(() => child.kill())));
    if (mockStarted) await attempt(() => bounded('mock close', mock.close(), 5000));
    for (const socket of sockets) socket.destroy();
    if (pool) await attempt(() => bounded('pool close', pool!.end(), 5000));
    if (created && children.every(child => child.exited)) {
      await attempt(() => bounded('sibling DROP', admin.query({ sql: `DROP DATABASE \`${database}\``, timeout: 10000 }), 12000));
    } else if (created) failures.push(new Error(`Cleanup left ${database}: child exit unconfirmed`));
    for (const socket of sockets) socket.destroy();
    await attempt(() => bounded('admin close', admin.end(), 5000));
    if (failures.length) throw new Error(`Worker cleanup incomplete (${failures.length} steps); inspect sibling ${database}`);
  })();
  t.after(cleanup);
  try {
    // Never selects, migrates, truncates or drops the URL's marker database.
    t.diagnostic(`disposable sibling=${database}; parentPid=${process.pid}`);
    await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`, timeout: 10000 });
    created = true;
    t.signal.throwIfAborted();
    pool = createPool({ uri: url.toString(), connectionLimit: 6, connectTimeout: 5000,
      timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
    pool.on('connection', track);
    const storage = new MysqlStorage(pool, 2);
    await storage.initialize();
    const store = await storage.userPool(options);
    t.signal.throwIfAborted();
    const ownerRow = async () => {
      const [rows] = await pool!.query<RowDataPacket[]>({ sql: 'SELECT owner, owner_until, '
        + "TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000 AS db_now "
        + 'FROM user_pool_settings WHERE id=1', timeout: 5000 });
      return { owner: rows[0].owner as string | null, until: Number(rows[0].owner_until), now: Number(rows[0].db_now) };
    };
    const slotCount = async () => {
      const [rows] = await pool!.query<RowDataPacket[]>({ sql: "SELECT COUNT(*) AS n FROM user_pool_accounts WHERE stage IN ('oauth-dispatch','oauth-wait')", timeout: 5000 });
      return Number(rows[0].n);
    };
    await mock.start(); mockStarted = true;
    for (const stalled of [false, true]) {
      let caseComplete = false;
      await t.test(stalled ? 'aged Login task retains slot; late repository callback cannot resume failed worker' :
        'accepted Login POST survives owner SIGKILL and successor adopts original nonce', { timeout: 100000 }, async sub => {
        const waitFor = <T>(label: string, predicate: () => Promise<T | undefined | false> | T | undefined | false, timeout = 12000) =>
          pollUntil(label, predicate, timeout, sub.signal);
        const caseChildren: WorkerProcess[] = [];
        sub.after(async () => { await Promise.all(caseChildren.filter(child => !child.exited).map(child => child.kill())); });
        sub.signal.throwIfAborted();
        // Reset only synthetic inventory between cases, after both children have exited.
        // In particular: NO owner/owner_until writes and NO accelerated SQL clock.
        assert.equal((await ownerRow()).owner, null);
        await pool!.query({ sql: 'DELETE FROM user_pool_events', timeout: 5000 });
        await pool!.query({ sql: 'DELETE FROM user_pool_accounts', timeout: 5000 });
        await pool!.query({ sql: 'DELETE FROM proxy_accounts', timeout: 5000 });
        const seed = await store.reserve();
        assert.ok(seed);
        await storage.createAccount({ identity: seed.identity, ssoUser: seed.identity, ghLogin: `${seed.identity}_synthetic` });
        assert.equal(await store.update(seed.identity, { stage: 'synced', sso_created_at: CREATED_AT }), true);
        mock.reset(seed.identity, stalled ? 16 * 60000 : 0);
        const owner = new WorkerProcess(url, database, true, mock.origin, sub.signal);
        children.push(owner); caseChildren.push(owner);
        const boot = await owner.message('boot');
        assert.equal(boot.pid, owner.child.pid);
        assert.notEqual(boot.pid, process.pid);
        const firstClaim = await owner.message('claim');
        assert.match(firstClaim.owner ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
        const checkpoint = await owner.message('checkpoint-held');
        assert.equal(checkpoint.pid, boot.pid);
        assert.equal(checkpoint.owner, firstClaim.owner);
        assert.equal(mock.taskPosts, 1);
        const originalTask = mock.tasks[0];
        const intent = (await store.inventory(seed.identity))!;
        assert.equal(intent.stage, 'oauth-dispatch');
        assert.equal(intent.state, 'provisioning');
        assert.equal(intent.task_id, null, 'Accepted task ID was not checkpointed');
        assert.equal(intent.oauth_attempt_id, originalTask.oauthAttemptId);
        assert.equal(checkpoint.nonce, originalTask.oauthAttemptId);
        assert.equal(checkpoint.taskId, originalTask.id);
        assert.equal(checkpoint.attempt, intent.attempt_id);
        assert.equal(checkpoint.generation, intent.generation);
        assert.equal(await slotCount(), 1);
        assert.equal((await storage.getAccount(seed.identity))!.copilotOauthAttemptId, originalTask.oauthAttemptId);
        assert.equal((await ownerRow()).owner, firstClaim.owner);
        const killed = await owner.kill();
        assert.ok(killed.signal === 'SIGKILL' || process.platform === 'win32' && killed.code !== 0,
          'Abrupt OS termination, not worker.stop/releaseOwner');
        const afterDeath = await ownerRow();
        const deathAt = performance.now();
        assert.equal(afterDeath.owner, firstClaim.owner, 'Dead child left real owner lease intact');
        assert.ok(afterDeath.until - afterDeath.now > 25000 && afterDeath.until - afterDeath.now <= 30000,
          'Actual 30-second owner TTL remains, not a shortened fixture lease');
        assert.equal(mock.tasks.length, 1, 'Parent HTTP state survived the worker exit');
        assert.equal(mock.tasks[0], originalTask);
        const deathFence = await store.inventory(seed.identity);
        assert.deepEqual(deathFence, intent, 'Killed checkpoint made no late inventory write');
        const successor = new WorkerProcess(url, database, false, mock.origin, sub.signal);
        children.push(successor); caseChildren.push(successor);
        const nextBoot = await successor.message('boot');
        assert.equal(nextBoot.pid, successor.child.pid);
        assert.notEqual(nextBoot.pid, boot.pid);
        assert.notEqual(nextBoot.pid, process.pid);
        await successor.message('standby');
        assert.equal((await ownerRow()).owner, firstClaim.owner, 'Standby did not steal live lease');
        const nextClaim = await successor.message('claim', 45000);
        assert.match(nextClaim.owner ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
        assert.notEqual(nextClaim.owner, firstClaim.owner);
        assert.ok(nextClaim.dbNow! >= afterDeath.until, 'Successor waited for actual DB lease expiry');
        const takeoverWaitMs = Math.round(performance.now() - deathAt);
        assert.ok(takeoverWaitMs >= afterDeath.until - afterDeath.now - 1000, 'Lease wait consumed real wall time');
        assert.equal((await ownerRow()).owner, nextClaim.owner);
        await waitFor('successor recovery task query', () => mock.requests.some(request =>
          request.method === 'GET' && request.path === '/api/tasks' && new URLSearchParams(request.query).get('q') === seed.identity));
        await waitFor('original task checkpoint', async () => (await store.inventory(seed.identity))?.task_id === originalTask.id);
        const adopted = (await store.inventory(seed.identity))!;
        assert.equal(adopted.oauth_attempt_id, originalTask.oauthAttemptId);
        assert.equal(adopted.attempt_id, intent.attempt_id, 'Worker ownership changes do not replace provisioning attempt');
        assert.equal(mock.taskPosts, 1, 'No recovery POST');
        assert.equal(await slotCount(), 1);
        // Repository callback nonce fence (not HTTP route acceptance; no production debug API).
        const beforeWrong = await storage.getAccount(seed.identity);
        assert.equal(await storage.saveCopilotOauthToken(seed.identity, randomUUID(), OAUTH_TOKEN, originalTask.ghLogin), undefined);
        assert.deepEqual(await storage.getAccount(seed.identity), beforeWrong);
        if (stalled) {
          await waitFor('terminal stalled-task failure', async () => {
            const row = await store.inventory(seed.identity);
            return row?.state === 'failed' && row.last_error === 'oauth_task_stalled' && row.attempts === 3 ? row : undefined;
          });
          const exhausted = (await store.inventory(seed.identity))!;
          assert.equal(exhausted.stage, 'oauth-wait');
          assert.equal(exhausted.oauth_attempt_id, originalTask.oauthAttemptId);
          assert.equal(await slotCount(), 1);
          assert.equal(mock.warmups, 0);
          // Hold an old running-task observation outside the worker. A late valid
          // callback must not revive provisioning while this retained HTTP response drains.
          mock.holdTaskGet();
          await waitFor('held terminal observation GET', () => mock.taskGetHeld);
          const heldMessages = successor.messages.length;
          assert.ok(await storage.saveCopilotOauthToken(seed.identity, originalTask.oauthAttemptId, OAUTH_TOKEN, originalTask.ghLogin));
          originalTask.status = 'success';
          const afterCallback = (await store.inventory(seed.identity))!;
          assert.deepEqual(afterCallback, { ...exhausted, generation: exhausted.generation + 1, verified_at: null },
            'Repository callback changes credential fence only; retains failed/3/error/task/nonce');
          assert.equal(await slotCount(), 1, 'Callback alone cannot release Login reservation');
          // Arm the next hold BEFORE draining the old response: a fresh success cannot
          // mask a stale completion or an unintended automatic warmup.
          mock.releaseTaskGet(true);
          await waitFor('old-generation observation drained', () => successor.messages.slice(heldMessages).some(message =>
            message.kind === 'observation-finished' && message.identity === seed.identity && message.generation === exhausted.generation));
          await waitFor('fresh success observation held', () => mock.taskGetHeld);
          assert.deepEqual(await store.inventory(seed.identity), afterCallback, 'Stale observation made no inventory write');
          assert.equal(await slotCount(), 1);
          assert.equal(mock.warmups, 0);
          assert.equal(mock.taskPosts, 1);
          mock.releaseTaskGet();
          await waitFor('fresh observation releases slot without retry', async () => {
            const row = await store.inventory(seed.identity);
            return row?.stage === 'warmup' && row.oauth_attempt_id === null ? row : undefined;
          });
          const final = (await store.inventory(seed.identity))!;
          assert.equal(final.state, 'failed');
          assert.equal(final.attempts, 3);
          assert.equal(final.last_error, 'oauth_task_stalled');
          assert.equal(final.task_id, null);
          assert.equal(final.attempt_id, intent.attempt_id);
          assert.equal(final.generation, afterCallback.generation + 1, 'Only the fresh slot release advanced generation');
          assert.equal(mock.warmups, 0, 'Success observation releases capacity, never auto-warms exhausted member');
        } else {
          assert.ok(await storage.saveCopilotOauthToken(seed.identity, originalTask.oauthAttemptId, OAUTH_TOKEN, originalTask.ghLogin));
          originalTask.status = 'success';
          const ready = await waitFor('real successor warmup ready', async () => {
            const row = await store.inventory(seed.identity);
            return row?.state === 'ready' ? row : undefined;
          });
          assert.equal(ready.stage, 'ready');
          assert.equal(ready.attempt_id, intent.attempt_id);
          assert.equal(ready.oauth_attempt_id, originalTask.oauthAttemptId);
          assert.equal(ready.task_id, originalTask.id);
          assert.ok(ready.generation > intent.generation);
          assert.ok(ready.verified_at);
          assert.equal(mock.modelGets, 1);
          assert.equal(mock.warmups, 1);
        }
        const settledAccount = await storage.getAccount(seed.identity);
        assert.equal(settledAccount!.copilotOauthStatus, 'valid');
        assert.equal(settledAccount!.copilotOauthAttemptId, undefined);
        assert.equal(await storage.saveCopilotOauthToken(seed.identity, originalTask.oauthAttemptId, 'stale-synthetic-token', originalTask.ghLogin), undefined);
        assert.deepEqual(await storage.getAccount(seed.identity), settledAccount, 'Repeated callback nonce cannot overwrite credentials');
        assert.equal(await slotCount(), 0);
        // Observe additional ordinary scheduling cycles, not only the first final write.
        const settledInventory = await store.inventory(seed.identity);
        for (let cycle = 0; cycle < 3; cycle++) {
          await pause(options.pollMs);
          assert.deepEqual(await store.inventory(seed.identity), settledInventory);
          assert.equal(mock.warmups, stalled ? 0 : 1);
          assert.equal(mock.taskPosts, 1);
        }
        assert.equal(mock.taskPosts, 1);
        assert.equal(mock.tasks.length, 1);
        assert.equal(mock.requests.filter(request => request.method === 'POST' && request.path === '/api/tasks').length, 1);
        assert.deepEqual(mock.errors, []);
        const beforeStatus = successor.messages.length;
        successor.child.send({ kind: 'status' });
        await waitFor('fresh owner active', () => successor.messages.slice(beforeStatus).some(message => message.kind === 'status' && message.active));
        const finalOwner = await ownerRow();
        assert.equal(finalOwner.owner, nextClaim.owner);
        assert.ok(finalOwner.until > finalOwner.now);
        sub.diagnostic(JSON.stringify({ parentPid: process.pid, killedPid: boot.pid, killed,
          successorPid: nextBoot.pid, originalOwner: firstClaim.owner, finalOwner: nextClaim.owner,
          expiredAt: afterDeath.until, claimedAt: nextClaim.dbNow, takeoverWaitMs, mockOrigin: mock.origin,
          callbackLayer: 'repository nonce fence (not HTTP callback)', nonce: originalTask.oauthAttemptId,
          taskId: originalTask.id, taskPosts: mock.taskPosts, taskGets: mock.taskGets, warmups: mock.warmups,
          finalState: (await store.inventory(seed.identity))!.state,
          http: mock.requests.filter(request => request.path.startsWith('/api/tasks')) }));
        await successor.stop();
        caseComplete = true;
      });
      // A failed case stops the suite; do not reset while cleanup or a late body runs.
      if (!caseComplete || t.signal.aborted) break;
    }
  } finally { await cleanup(); }
});
