import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import Database from 'better-sqlite3';
import type { LoginTaskDto, SsoUserDto } from '@ghcp/shared';
import { runMigrations } from '../db/migrations.js';
import type { ProxyAccountRecord } from '../db/storageTypes.js';
import { readPoolConfig } from './config.js';
import { realProvisioner } from './provisioner.js';
import { UserPoolStore } from './store.js';
import { PrewarmWorker, type PrewarmStore } from './worker.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let turn = 0; turn < 3000; turn++) {
    if (predicate()) return;
    await yieldTurn();
  }
  assert.ok(predicate(), message);
}

test('async worker drains downstream work past 2000 starters and atomically refills the freed Login slot',
  { timeout: 30000 }, async t => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    runMigrations(db);
    const options = readPoolConfig({ ACCOUNT_ROUTING_MODE: 'caller-lease',
      POOL_ACCOUNT_EMAIL_DOMAIN: 'scheduler.test', POOL_WARMUP_MODEL: 'synthetic',
      READY_IDLE_TARGET: '0', POOL_MAX_ACCOUNTS: '3000', POOL_LOGIN_MAX_PENDING: '5' });
    const store = new UserPoolStore(db, options);
    let now = store.now();
    store.now = () => now;
    const createdAt = new Date(now - 60000).toISOString();
    const identity = (ordinal: number) => `synthetic-scheduler-${String(ordinal).padStart(4, '0')}`;
    const tasks = new Map<string, LoginTaskDto>();
    const starters = new Set(Array.from({ length: 2000 }, (_, n) => identity(n)));
    const reservations = Array.from({ length: 5 }, (_, n) => identity(2000 + n));
    const warmups = Array.from({ length: 5 }, (_, n) => identity(2005 + n));
    const user = (id: string): SsoUserDto => ({ ssoUser: id, email: `${id}@scheduler.test`, role: 'user',
      ghLogin: `${id}_emu`, ghScimId: `scim-${id}`, emuStatus: 'active', copilotSeatStatus: 'assigned',
      createdAt, updatedAt: createdAt });
    const makeTask = (id: string, nonce: string): LoginTaskDto => ({ id: randomUUID(), identity: id,
      ssoUser: id, ghLogin: `${id}_emu`, oauthAttemptId: nonce, ssoType: 'custom', status: 'running',
      attempts: 1, createdAt });

    db.transaction(() => {
      const insertAccount = db.prepare(`INSERT INTO proxy_accounts
        (identity,sso_user,gh_login,copilot_oauth_token,copilot_oauth_status,copilot_oauth_attempt_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`);
      const insertMember = db.prepare(`INSERT INTO user_pool_accounts
        (identity,ordinal,state,stage,attempt_id,oauth_attempt_id,sso_created_at,task_id,retry_at,updated_at)
        VALUES(?,?,'provisioning',?,?,?,?,?,?,?)`);
      for (let n = 0; n < 2010; n++) {
        const id = identity(n), nonce = randomUUID();
        const stage = n < 2000 ? 'oauth-starting' : n === 2000 ? 'oauth-dispatch' : n < 2005 ? 'oauth-wait' : 'warmup';
        const task = n >= 2000 && n < 2005 ? makeTask(id, nonce) : undefined;
        if (task) tasks.set(task.id, task);
        insertAccount.run(id, id, `${id}_emu`, n >= 2005 ? `synthetic-token-${id}` : null,
          n >= 2005 ? 'valid' : task ? 'refreshing' : 'missing', task ? nonce : null, createdAt, createdAt);
        // Starters have the oldest due time. The recovered dispatch deliberately has
        // no task_id, although Login already accepted its correctly correlated POST.
        insertMember.run(id, n, stage, randomUUID(), nonce, createdAt,
          stage === 'oauth-wait' ? task!.id : null, now - (n < 2000 ? 20000 : 10000), now - 10000);
      }
    })();

    const occupied = () => (db.prepare(`SELECT COUNT(*) n FROM user_pool_accounts
      WHERE stage IN ('oauth-dispatch','oauth-wait')`).get() as { n: number }).n;
    let peakOccupied = occupied(), activePending = 0, peakPending = 0;
    const later = async <T>(operation: () => T): Promise<T> => {
      await yieldTurn();
      const result = operation();
      peakOccupied = Math.max(peakOccupied, occupied());
      return result;
    };
    // Await real store operations; never mock pending selection, checkpoint fences,
    // credential generation, owner election, or the final capacity transaction.
    const asyncStore: PrewarmStore = {
      now: () => later(() => store.now()),
      claimOwner: owner => later(() => store.claimOwner(owner)),
      renewOwner: owner => later(() => store.renewOwner(owner)),
      releaseOwner: owner => later(() => store.releaseOwner(owner)),
      reclaim: () => later(() => store.reclaim()),
      settings: () => later(() => store.settings()),
      reserveDeficit: owner => later(() => store.reserveDeficit(owner)),
      async pending(excluded) {
        peakPending = Math.max(peakPending, ++activePending);
        try { return await later(() => store.pending(excluded)); }
        finally { activePending--; }
      },
      hasHolds: id => later(() => store.hasHolds(id)),
      inventory: id => later(() => store.inventory(id)),
      update: (...args) => later(() => store.update(...args)),
      fail: (...args) => later(() => store.fail(...args)),
      event: (...args) => later(() => store.event(...args)),
      mutateWorkerCredential: (...args) => later(() => store.mutateWorkerCredential(...args)),
      claimLoginDispatch: (...args) => later(() => store.claimLoginDispatch(...args)),
    };
    const credentialsGate = deferred();
    const credentialsRequested = new Set<string>(), starterRequests: string[] = [];
    const polled = new Set<string>(), warmed = new Set<string>(), posted: LoginTaskDto[] = [];
    const unexpected: string[] = [];
    const json = (body: unknown) => new Response(JSON.stringify(body));
    const adapter = realProvisioner(asyncStore, options, {
      async getAccount(id): Promise<ProxyAccountRecord | undefined> {
        await yieldTurn();
        const account = db.prepare('SELECT * FROM proxy_accounts WHERE identity=?').get(id) as {
          identity: string; sso_user: string; gh_login: string; copilot_oauth_status: ProxyAccountRecord['copilotOauthStatus'];
          copilot_oauth_token: string | null; copilot_oauth_attempt_id: string | null; copilot_oauth_updated_at: string | null;
        } | undefined;
        return account && { identity: id, ssoUser: account.sso_user, ghLogin: account.gh_login,
          copilotOauthStatus: account.copilot_oauth_status, copilotOauthToken: account.copilot_oauth_token ?? undefined,
          copilotOauthAttemptId: account.copilot_oauth_attempt_id ?? undefined,
          copilotOauthUpdatedAt: account.copilot_oauth_updated_at ?? undefined, createdAt, updatedAt: createdAt };
      },
      async fetch(input, init) {
        await yieldTurn();
        const url = new URL(String(input)), method = init?.method ?? 'GET';
        if (url.pathname.startsWith('/api/users/')) {
          const id = decodeURIComponent(url.pathname.split('/')[3]!);
          if (starters.has(id)) starterRequests.push(id);
          if (url.pathname === `/api/users/${id}` && method === 'GET') return json(user(id));
          if (url.pathname === `/api/users/${id}/login-credentials` && method === 'POST') {
            assert.deepEqual(JSON.parse(String(init?.body)), { expectedCreatedAt: createdAt, expectedEmail: `${id}@scheduler.test` });
            credentialsRequested.add(id);
            // Hold all five preparations until the scheduler has selected them with
            // only ONE persistent slot free. The final claims must admit just one.
            await credentialsGate.promise;
            return json({ user: user(id), passwordForLogin: 'synthetic-password' });
          }
        }
        if (url.pathname === '/api/tasks' && method === 'POST') {
          const body = JSON.parse(String(init?.body)) as Record<string, string>;
          const row = store.inventory(body.identity!)!;
          assert.equal(row.stage, 'oauth-dispatch');
          assert.equal(body.oauthAttemptId, row.oauth_attempt_id);
          assert.equal(body.ssoUser, row.identity);
          assert.equal(body.ghLogin, `${row.identity}_emu`);
          assert.equal(body.ssoPassword, 'synthetic-password');
          assert.equal(body.ssoType, 'custom');
          assert.ok(!posted.some(task => task.identity === row.identity), 'no duplicate Login POST');
          const task = makeTask(row.identity, body.oauthAttemptId!);
          tasks.set(task.id, task); posted.push(task);
          return json(task);
        }
        if (url.pathname === '/api/tasks' && method === 'GET') {
          const items = [...tasks.values()].filter(task => task.identity === url.searchParams.get('q'));
          for (const task of items) polled.add(task.identity);
          return json({ items, total: items.length, page: 1, pageSize: 100 });
        }
        if (url.pathname.startsWith('/api/tasks/') && method === 'GET') {
          const task = tasks.get(url.pathname.slice('/api/tasks/'.length));
          assert.ok(task, 'task lookup must use its persisted identifier');
          polled.add(task.identity);
          return json(task);
        }
        unexpected.push(`${method} ${url.pathname}`);
        throw new Error('Unexpected synthetic service request');
      },
      async resolveModel(_auth, _path, model) {
        await yieldTurn();
        assert.equal(model, options.warmupModel);
        return { requestedId: model, canonicalId: model, upstreamId: model,
          model: { id: model }, supportedPaths: ['/v1/messages'] };
      },
      async executeRequest(request) {
        await yieldTurn();
        assert.ok(request.body);
        // Each successful model call must be using an actual fixture credential.
        const token = Object.entries(request.headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
        assert.ok(token && token.startsWith('Bearer synthetic-token-'));
        warmed.add(token.slice('Bearer synthetic-token-'.length));
        return json({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }] });
      },
    });
    let peakActive = 0;
    const active = new Set<string>();
    const worker = new PrewarmWorker(asyncStore, { ...adapter, async step(row, context) {
      assert.ok(!active.has(row.identity), 'overlapping ticks must not run the same account twice');
      active.add(row.identity); peakActive = Math.max(peakActive, active.size);
      try { return await adapter.step(row, context); }
      finally { active.delete(row.identity); }
    } }, options.pollMs, 5);
    t.after(async () => { credentialsGate.resolve(); await worker.stop(); db.close(); });
    const storm = () => Promise.all(Array.from({ length: 20 }, () => worker.tick()));

    await worker.start();
    await storm();
    await waitFor(() => warmups.every(id => store.inventory(id)!.state === 'ready')
      && reservations.every(id => store.inventory(id)!.stage === 'oauth-wait' && store.inventory(id)!.retry_at > now),
    'downstream work must finish/poll without traversing 2000 blocked starters');
    assert.equal(starterRequests.length, 0, 'full persistent slots must skip starters BEFORE SSO/credential work');
    assert.ok(reservations.every(id => polled.has(id)));
    assert.ok(warmups.every(id => warmed.has(id)));
    assert.equal(store.counts().ready_idle, 5);
    assert.equal(occupied(), 5);
    assert.equal(posted.length, 0);

    // Simulate the actual callback fence: only the matching refreshing nonce may
    // write the credential. SQLite's production trigger increments generation.
    const completed = [...tasks.values()].find(task => task.identity === reservations[0])!;
    const generation = store.inventory(completed.identity)!.generation;
    now += options.pollMs;
    const timestamp = new Date(now).toISOString();
    assert.equal(db.prepare(`UPDATE proxy_accounts SET copilot_oauth_status='valid',copilot_oauth_token=?,
      copilot_oauth_attempt_id=NULL,copilot_oauth_updated_at=?,updated_at=?
      WHERE identity=? AND sso_user=? AND copilot_oauth_status='refreshing' AND copilot_oauth_attempt_id=?`)
      .run(`synthetic-token-${completed.identity}`, timestamp, timestamp,
        completed.identity, completed.ssoUser, completed.oauthAttemptId).changes, 1);
    assert.equal(store.inventory(completed.identity)!.generation, generation + 1);
    completed.status = 'success';
    const racingTicks = storm();
    await waitFor(() => credentialsRequested.size === 5, 'five asynchronous starters must compete for the one freed slot');
    assert.equal(occupied(), 4);
    await waitFor(() => store.inventory(completed.identity)!.state === 'ready', 'successful Login must progress through real warmup');
    assert.ok(warmed.has(completed.identity));
    credentialsGate.resolve();
    await racingTicks;
    await waitFor(() => posted.length === 1 && credentialsRequested.size === 5
      && [...credentialsRequested].every(id => store.inventory(id)!.retry_at > now),
    'one starter dispatches, while losing claims back off without posting');
    await storm();

    assert.equal(store.counts().ready_idle, 6);
    assert.equal(posted.length, 1);
    assert.equal(occupied(), 5);
    assert.equal(peakOccupied, 5, 'advisory selection cannot bypass the final atomic limit');
    assert.equal(peakActive, 5, 'exercise every lane without exceeding configured concurrency');
    assert.equal(peakPending, 1, 'overlapping ticks serialize asynchronous selection and its fairness counter');
    assert.deepEqual(unexpected, []);
    for (const id of credentialsRequested) {
      const row = store.inventory(id)!;
      assert.equal(row.state, 'provisioning');
      assert.equal(row.attempts, 0, 'a rejected capacity claim is not a provisioning failure');
      assert.equal(row.stage, id === posted[0]!.identity ? 'oauth-wait' : 'oauth-starting');
    }
  });
