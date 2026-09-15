import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { LoginTaskDto, SsoUserDto } from '@ghcp/shared';
import { SqliteStorage } from '../db/sqliteStorage.js';
import { readPoolConfig } from './config.js';
import { realProvisioner } from './provisioner.js';
import { PrewarmWorker, type PrewarmStore } from './worker.js';

for (const fault of ['before-write', 'after-write-before-ack'] as const) {
  test(`terminal Login callback failure (${fault}) recovers with one new OAuth attempt, not new identities`,
    { timeout: 15000 }, async t => {
      const storage = new SqliteStorage(':memory:', 100);
      let worker: PrewarmWorker | undefined;
      t.after(async () => { await worker?.stop(); await storage.close(); });
      await storage.initialize();
      const options = readPoolConfig({ ACCOUNT_ROUTING_MODE: 'caller-lease',
        POOL_ACCOUNT_EMAIL_DOMAIN: 'recovery.test', POOL_WARMUP_MODEL: 'synthetic',
        READY_IDLE_TARGET: '1', POOL_MAX_ACCOUNTS: '1', POOL_LOGIN_MAX_PENDING: '1' });
      const store = storage.userPool(options);
      let now = store.now(), monotonicNow = 0;
      store.now = () => now;
      const later = async <T>(operation: () => T): Promise<T> => {
        await yieldTurn();
        return operation();
      };
      // Use the same asynchronous SQLite boundary as scheduling.worker.test.ts.
      // All selection, owner, dispatch and checkpoint transactions remain real.
      const asyncStore: PrewarmStore = {
        now: () => later(() => store.now()),
        claimOwner: owner => later(() => store.claimOwner(owner)),
        renewOwner: owner => later(() => store.renewOwner(owner)),
        releaseOwner: owner => later(() => store.releaseOwner(owner)),
        reclaim: () => later(() => store.reclaim()),
        settings: () => later(() => store.settings()),
        reserveDeficit: owner => later(() => store.reserveDeficit(owner)),
        pending: excluded => later(() => store.pending(excluded)),
        hasHolds: id => later(() => store.hasHolds(id)),
        inventory: id => later(() => store.inventory(id)),
        update: (...args) => later(() => store.update(...args)),
        fail: (...args) => later(() => store.fail(...args)),
        event: (...args) => later(() => store.event(...args)),
        mutateWorkerCredential: (...args) => later(() => store.mutateWorkerCredential(...args)),
        claimLoginDispatch: (...args) => later(() => store.claimLoginDispatch(...args)),
        listLoginReservations: () => later(() => store.listLoginReservations()),
        releaseLoginReservation: (...args) => later(() => store.releaseLoginReservation(...args)),
      };
      const tasks = new Map<string, LoginTaskDto>();
      const posted: LoginTaskDto[] = [];
      const postsPerAttempt = new Map<string, number>();
      const effects = { sso: 0, scim: 0, seat: 0, credentials: 0 };
      const unexpected: string[] = [];
      const warmed: string[] = [];
      let user: SsoUserDto | undefined;
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      const adapter = realProvisioner(asyncStore, options, {
        async getAccount(id) {
          await yieldTurn();
          return storage.getAccount(id);
        },
        async fetch(input, init) {
          await yieldTurn();
          const url = new URL(String(input)), method = init?.method ?? 'GET';
          const body = () => JSON.parse(String(init?.body));
          if (url.pathname === '/api/users' && method === 'POST') {
            const request = body() as { ssoUser: string };
            assert.equal(++effects.sso, 1, 'recovery must not recreate the SSO user');
            assert.equal(store.inventory(request.ssoUser)!.stage, 'sso-creating');
            assert.deepEqual(request, { ssoUser: request.ssoUser,
              email: `${request.ssoUser}@recovery.test`, role: 'user', poolManaged: true });
            user = { ssoUser: request.ssoUser, email: `${request.ssoUser}@recovery.test`, role: 'user',
              emuStatus: 'not_synced', copilotSeatStatus: 'unassigned',
              createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
            return json(user);
          }
          if (url.pathname === '/api/users/batch' && method === 'POST') {
            assert.ok(user);
            assert.equal(++effects.scim, 1, 'recovery must not recreate the SCIM identity');
            assert.equal(store.inventory(user.ssoUser)!.stage, 'scim-syncing');
            assert.deepEqual(body(), { operation: 'sync_emu', ssoUsers: [user.ssoUser],
              assignCopilotSeat: false, createOnly: true });
            user = { ...user, ghLogin: `${user.ssoUser}_emu`, ghScimId: 'synthetic-scim-original', emuStatus: 'active' };
            return json({ rows: [{ ssoUser: user.ssoUser, status: 'success', user }] });
          }
          if (url.pathname.startsWith('/api/users/')) {
            const id = decodeURIComponent(url.pathname.split('/')[3]!);
            if (url.pathname === `/api/users/${id}` && method === 'GET') {
              return user?.ssoUser === id ? json(user) : json({ error: 'not_found' }, 404);
            }
            assert.ok(user && user.ssoUser === id, 'only the original SSO identity is known');
            if (url.pathname === `/api/users/${id}/copilot-seat` && method === 'POST') {
              assert.equal(++effects.seat, 1, 'recovery must not reassign the Copilot seat');
              assert.equal(store.inventory(id)!.stage, 'seat-assigning');
              assert.deepEqual(body(), {});
              user = { ...user, copilotSeatStatus: 'assigned' };
              return json(user);
            }
            if (url.pathname === `/api/users/${id}/login-credentials` && method === 'POST') {
              effects.credentials++;
              assert.deepEqual(body(), { expectedCreatedAt: user.createdAt, expectedEmail: user.email });
              return json({ user, passwordForLogin: 'synthetic-password' });
            }
          }
          if (url.pathname === '/api/tasks' && method === 'POST') {
            assert.ok(user);
            const request = body() as { identity: string; oauthAttemptId: string };
            const row = store.inventory(request.identity)!;
            assert.equal(row.stage, 'oauth-dispatch', 'Login POST requires the real persisted dispatch claim');
            assert.ok(row.oauth_attempt_id);
            assert.deepEqual(request, { identity: user.ssoUser, ssoUser: user.ssoUser, ghLogin: user.ghLogin,
              oauthAttemptId: row.oauth_attempt_id, ssoType: 'custom', ssoPassword: 'synthetic-password' });
            const count = (postsPerAttempt.get(request.oauthAttemptId) ?? 0) + 1;
            postsPerAttempt.set(request.oauthAttemptId, count);
            assert.equal(count, 1, 'Login does not deduplicate: never POST the same oauthAttemptId twice');
            const account = await storage.getAccount(row.identity);
            assert.equal(account?.copilotOauthAttemptId, row.oauth_attempt_id);
            assert.equal(account?.copilotOauthStatus, 'refreshing');
            const task: LoginTaskDto = { id: `synthetic-task-${posted.length + 1}`, identity: row.identity,
              ssoUser: row.identity, ghLogin: user.ghLogin, oauthAttemptId: request.oauthAttemptId,
              ssoType: 'custom', status: 'running', attempts: 1, createdAt: new Date(now).toISOString() };
            tasks.set(task.id, task); posted.push(task);
            return json(task);
          }
          if (url.pathname === '/api/tasks' && method === 'GET') {
            const items = [...tasks.values()].filter(task => task.identity === url.searchParams.get('q'));
            return json({ items, total: items.length, page: 1, pageSize: 100 });
          }
          if (url.pathname.startsWith('/api/tasks/') && method === 'GET') {
            const task = tasks.get(decodeURIComponent(url.pathname.slice('/api/tasks/'.length)));
            assert.ok(task, 'task polling must use a previously accepted Login task');
            return json(task);
          }
          unexpected.push(`${method} ${url.pathname}`);
          throw new Error('Unexpected synthetic service request');
        },
        async resolveModel(auth, path, model) {
          await yieldTurn();
          assert.equal(auth.accessToken, 'synthetic-replacement-token', 'never warm up the failed attempt');
          assert.equal(path, '/v1/messages');
          assert.equal(model, options.warmupModel);
          return { requestedId: model, canonicalId: model, upstreamId: model,
            model: { id: model }, supportedPaths: ['/v1/messages'] };
        },
        async executeRequest(request) {
          await yieldTurn();
          assert.ok(user);
          const row = store.inventory(user.ssoUser)!;
          assert.equal(row.stage, 'warmup');
          assert.equal(row.state, 'provisioning', 'the member is not ready before successful warmup');
          assert.equal(row.verified_at, null);
          const token = Object.entries(request.headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
          assert.equal(token, 'Bearer synthetic-replacement-token');
          assert.ok(request.body);
          warmed.push(token);
          return json({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }] });
        },
      });
      worker = new PrewarmWorker(asyncStore, adapter, options.pollMs, 1, () => monotonicNow);
      const tick = async () => {
        await Promise.all([worker!.tick(), worker!.tick(), worker!.tick()]);
        await worker!.waitForObservations();
        assert.ok(worker!.isActive(), 'clock advancement must not expire worker ownership');
      };
      const until = async (predicate: () => boolean, message: string) => {
        for (let turn = 0; turn < 30 && !predicate(); turn++) await tick();
        assert.ok(predicate(), message);
      };
      // Drive the real scheduler explicitly instead of starting periodic timers. Advance
      // both clocks in <=5s increments, renewing through real ticks before the 30s TTL.
      // No global Date/timer mocks, sleeps, owner edits or retry_at rewrites are needed.
      const advanceTo = async (target: number) => {
        assert.ok(target >= now);
        while (now < target) {
          const elapsed = Math.min(5000, target - now);
          now += elapsed; monotonicNow += elapsed;
          await tick();
        }
      };
      await until(() => posted.length === 1 && store.inventory(posted[0]!.identity)!.stage === 'oauth-wait',
        'initial provisioning must create the identities and dispatch Login');
      const first = posted[0]!;
      const identity = first.identity;
      const original = store.inventory(identity)!;
      const originalUser = { ...user! };
      assert.deepEqual(effects, { sso: 1, scim: 1, seat: 1, credentials: 1 });
      assert.equal(original.attempts, 0);
      await tick(); // Observe running, establishing the next real poll deadline.
      assert.equal(store.inventory(identity)!.retry_at, now + options.pollMs);
      assert.equal(posted.length, 1, 'an outstanding attempt cannot be redispatched');

      // Model Login runner ordering: write callback, then mark success. Either transport
      // failure instead makes the accepted task terminal failed, even if Proxy committed.
      const callbackError = new Error(`synthetic callback transport lost ${fault}`);
      const beforeCallback = await storage.getAccount(identity);
      const beforeGeneration = store.inventory(identity)!.generation;
      await assert.rejects(async () => {
        try {
          await yieldTurn();
          if (fault === 'before-write') throw callbackError;
          assert.ok(await storage.saveCopilotOauthToken(identity, first.oauthAttemptId!,
            'synthetic-unacknowledged-token', first.ghLogin));
          throw callbackError;
        } catch (error) {
          first.status = 'failed';
          first.finishedAt = new Date(now).toISOString();
          first.failureReason = 'synthetic callback transport failure';
          throw error;
        }
      }, error => error === callbackError);
      assert.equal(first.status, 'failed');
      if (fault === 'before-write') {
        assert.deepEqual(await storage.getAccount(identity), beforeCallback);
        assert.equal(beforeCallback?.copilotOauthToken, undefined);
        assert.equal(store.inventory(identity)!.generation, beforeGeneration);
      } else {
        const saved = await storage.getAccount(identity);
        assert.equal(saved?.copilotOauthToken, 'synthetic-unacknowledged-token');
        assert.equal(saved?.copilotOauthStatus, 'valid');
        assert.equal(saved?.copilotOauthAttemptId, undefined);
        assert.equal(store.inventory(identity)!.generation, beforeGeneration + 1, 'actual callback fires the credential fence');
      }
      await advanceTo(store.inventory(identity)!.retry_at);
      await until(() => store.inventory(identity)!.state === 'failed', 'terminal Login failure must enter repair backoff');
      const failed = store.inventory(identity)!;
      assert.equal(failed.stage, 'synced', 'only a definitively failed Login task permits a new OAuth attempt');
      assert.equal(failed.attempts, 1, 'one Login failure charges one provisioning failure, not terminal exhaustion');
      assert.equal(failed.last_error, 'oauth_login_failed');
      assert.equal(failed.task_id, null);
      assert.equal(failed.oauth_attempt_id, null);
      assert.equal(failed.retry_at, now + 30000);
      assert.equal(store.counts().ready_idle, 0, 'a persisted but unacknowledged token is not ready capacity');
      assert.deepEqual(warmed, []);
      await advanceTo(failed.retry_at - 1);
      await tick();
      assert.deepEqual(store.inventory(identity), failed, 'the real pending query must respect backoff');
      assert.equal(posted.length, 1);
      assert.equal(effects.credentials, 1, 'backoff must not even request another login password');
      await advanceTo(failed.retry_at);
      await until(() => posted.length === 2 && store.inventory(identity)!.stage === 'oauth-wait',
        'after backoff the original member must dispatch a fresh OAuth attempt');
      const replacement = posted[1]!;
      assert.notEqual(replacement.oauthAttemptId, first.oauthAttemptId);
      assert.equal(replacement.identity, identity);
      assert.equal(replacement.ssoUser, first.ssoUser);
      assert.equal(replacement.ghLogin, first.ghLogin);
      assert.equal(first.status, 'failed', 'recovery does not reopen the old terminal task');
      assert.equal(store.inventory(identity)!.attempt_id, original.attempt_id);
      assert.equal(store.inventory(identity)!.sso_created_at, original.sso_created_at);

      const rejectOldCallbacks = async () => {
        const account = await storage.getAccount(identity);
        const row = store.inventory(identity)!;
        // These are the production SQLite methods called by the internal callback API,
        // not SQL approximations: stale success must not overwrite and failure must not revoke.
        assert.equal(await storage.saveCopilotOauthToken(identity, first.oauthAttemptId!,
          'synthetic-stale-token', first.ghLogin), undefined, 'reject stale success callback');
        assert.equal(await storage.failCopilotOauthAuthorization(identity, first.oauthAttemptId!), false,
          'reject stale failure callback');
        assert.deepEqual(await storage.getAccount(identity), account);
        assert.deepEqual(store.inventory(identity), row, 'stale callbacks must not alter generation or verification');
      };
      await rejectOldCallbacks(); // Fence the old nonce while the replacement is still refreshing.
      const replacementGeneration = store.inventory(identity)!.generation;
      const saved = await storage.saveCopilotOauthToken(identity, replacement.oauthAttemptId!,
        'synthetic-replacement-token', replacement.ghLogin);
      assert.equal(saved?.copilotOauthStatus, 'valid');
      assert.equal(saved?.copilotOauthAttemptId, undefined);
      assert.equal(store.inventory(identity)!.generation, replacementGeneration + 1);
      replacement.status = 'success';
      replacement.finishedAt = new Date(now).toISOString();
      await until(() => store.inventory(identity)!.stage === 'warmup', 'successful replacement must pass through warmup');
      assert.equal(store.counts().ready_idle, 0);
      await until(() => store.inventory(identity)!.state === 'ready', 'the repaired member must eventually become ready');
      const ready = store.inventory(identity)!;
      assert.equal(ready.stage, 'ready');
      assert.equal(ready.verified_at, now);
      assert.equal(ready.attempts, 0);
      assert.equal(ready.last_error, null);
      assert.equal(ready.ordinal, original.ordinal);
      await rejectOldCallbacks(); // Also preserve the final credential and successful verification.
      await tick();
      assert.equal((await storage.getAccount(identity))?.copilotOauthToken, 'synthetic-replacement-token');
      assert.deepEqual(warmed, ['Bearer synthetic-replacement-token']);
      assert.deepEqual(effects, { sso: 1, scim: 1, seat: 1, credentials: 2 });
      assert.deepEqual(user, originalUser, 'SSO creation marker, SCIM identity and assigned seat all survive repair');
      assert.equal(store.counts().total, 1);
      assert.equal(store.counts().ready_idle, 1);
      assert.equal((await storage.listAccounts()).total, 1);
      assert.equal(posted.length, 2);
      assert.deepEqual([...postsPerAttempt.values()], [1, 1]);
      const events = store.events() as { action: string; identity: string; detail: string | null }[];
      assert.equal(events.filter(event => event.action === 'name_reserved').length, 1);
      assert.equal(events.filter(event => event.action === 'account_ready' && event.identity === identity).length, 1);
      assert.deepEqual(events.filter(event => event.action === 'provision_failed').map(event => event.detail), ['oauth_login_failed']);
      assert.deepEqual(unexpected, []);
    });
}
