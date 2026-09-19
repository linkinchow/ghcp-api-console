import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection, Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

// The reusable upgrade harness lives outside the Proxy build root. Its module
// itself has type-only imports, so loading it does not load any driver/schema.
interface TestHarness { connection: Connection; openConnection(): Promise<Connection> }
const { readEnterpriseMysqlTestGate, withEnterpriseMysqlTestSchema } = await import(
  new URL('../../../../upgrade/multi-enterprise-pool/mysqlHarness.ts', import.meta.url).href,
) as {
  readEnterpriseMysqlTestGate(): { enabled: boolean };
  withEnterpriseMysqlTestSchema(gate: { enabled: boolean }, run: (harness: TestHarness) => Promise<void>): Promise<void>;
};

// No driver/schema/runtime import before this explicit dedicated-schema gate.
// MYSQL_URL/MYSQL_TEST_URL and deployment .env are never read. No database
// creation, Docker, cloud resources, or HTTP is performed by these tests.
const gate = readEnterpriseMysqlTestGate();
test('phase4 opt-in MySQL 8 pool races on preprovided empty loopback schema', {
  skip: gate.enabled ? false : 'No explicit dedicated MySQL schema authorization; real MySQL not executed.',
}, async t => withEnterpriseMysqlTestSchema(gate, async harness => {
  const [{ randomUUID, createHash }, { MysqlPoolStore }, { normalizePoolConfig }, { initEnterpriseMysqlV4 },
    { enterpriseProfileIdentityHashV4 }, { enterpriseRegistryHashV3 }, { registryV3, A, B, poolOptionsV3 }] = await Promise.all([
    import('node:crypto'), import('./mysqlStore.js'), import('./config.js'), import('@ghcp/shared/enterpriseMysqlV4'),
    import('@ghcp/shared/enterpriseRuntimeV4'), import('@ghcp/shared/enterpriseRuntimeV3'),
    import('./mysqlPhase4.fixture.js'),
  ]);
  const reg = registryV3();
  const options = normalizePoolConfig({ enabled: true, accountDomain: reg.profiles[0].accountDomain, idleTarget: 3,
    maxAccounts: 10, leaseSeconds: 600, provisionalSeconds: 30, pollMs: 1000,
    retryAfterSeconds: 1, warmupModel: 'synthetic-no-http', requestTimeoutMs: 120000 });
  const { idleTarget: _i, maxAccounts: _m, leaseSeconds: _l, enabled: _e, callerDomain: _d, ...invariants } = options;
  const fingerprint = createHash('sha256').update(JSON.stringify(Object.entries(invariants).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  const init = poolOptionsV3();
  init.pool.fingerprint = fingerprint;
  await initEnterpriseMysqlV4(harness.connection, 'proxy', reg, init);
  const sql = harness.connection;
  const pool = {
    // Pool-level calls are used by initialize/now as well as transactional calls.
    // Keep query and execute separate: execute must exercise server preparation.
    async query(...args: unknown[]) {
      const connection = await harness.openConnection();
      try { return await Reflect.apply(connection.query, connection, args); }
      finally { await connection.end(); }
    },
    async execute(...args: unknown[]) {
      const connection = await harness.openConnection();
      try { return await Reflect.apply(connection.execute, connection, args); }
      finally { await connection.end(); }
    },
    async getConnection() {
      const connection = await harness.openConnection();
      let released = false;
      return new Proxy(connection, { get(target, key) {
        if (key === 'release') return () => {
          if (!released) { released = true; void connection.end().catch(() => connection.destroy()); }
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } }) as unknown as PoolConnection;
    },
  } as unknown as Pool;
  const first = new MysqlPoolStore(pool, options, reg), second = new MysqlPoolStore(pool, options, reg);
  await Promise.all([first.initialize(), second.initialize()]);
  const caller = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
  async function reset(target = 3) {
    for (const table of ['user_pool_holds', 'user_pool_catalog_holds', 'user_pool_catalog_cooldowns', 'user_pool_leases',
      'user_pool_accounts', 'user_pool_events', 'proxy_authorization_attempts', 'proxy_accounts']) await sql.query(`DELETE FROM ${table}`);
    await sql.query('UPDATE user_pool_settings SET version=1,paused=0,idle_target=?,owner=NULL,owner_until=0,next_ordinal=0 WHERE id=1', [target]);
    await sql.query('UPDATE enterprise_profiles SET max_accounts=5');
    const now = await first.now();
    for (const profile of reg.profiles) {
      const binding = { enterpriseId: profile.id, enterpriseRevision: profile.revision,
        profileIdentitySha256: enterpriseProfileIdentityHashV4(profile), registryRevision: reg.registryRevision,
        registrySha256: enterpriseRegistryHashV3(reg), legacyEnterpriseId: reg.legacyEnterpriseId };
      const probe = { ...binding, probeVersion: 1, schemaVersion: 3, contractVersion: 2,
        capability: 'enterprise-isolation-legacy-pool', ready: true, blockers: [] };
      const evidence = { ...binding, version: 1, checkedAt: now, sso: { ...probe, component: 'sso' }, login: { ...probe, component: 'login' } };
      await sql.query(`UPDATE enterprise_pool_policy SET state='active',policy_version=1,validation_kind='local_service_readiness_v1',
        validation_evidence_json=?,validated_at=?,updated_at=? WHERE enterprise_id=?`, [JSON.stringify(evidence), now, now, profile.id]);
    }
  }
  async function ready(n: number) {
    const identities: string[] = [];
    for (let i = 0; i < n; i++) {
      const row = await first.reserve(); assert.ok(row); identities.push(row.identity);
      await sql.query("UPDATE proxy_accounts SET copilot_oauth_token=?,copilot_oauth_status='valid' WHERE identity=?", [`synthetic-${row.identity}`, row.identity]);
      await first.update(row.identity, { state: 'ready', stage: 'ready', verified_at: await first.now() });
    }
    return identities;
  }
  await t.test('contract-2 confirmed cancellation releases exact reservations with real generation/CAS fences', async () => {
    const [{ realProvisioner }, { accountName }] = await Promise.all([import('./provisioner.js'), import('./names.js')]);
    await reset(1);
    const row = (await first.reserve())!;
    const owner = randomUUID(); assert.equal(await first.claimOwner(owner), true);
    const nonce = randomUUID(), taskId = randomUUID(), ghLogin = 'synthetic-cancel-user';
    await sql.query('UPDATE proxy_accounts SET gh_login=? WHERE identity=?', [ghLogin, row.identity]);
    await first.update(row.identity, { state: 'disabled', stage: 'oauth-wait', oauth_attempt_id: nonce, task_id: taskId,
      attempts: 1, last_error: 'sso_http_503' });
    const [accounts] = await sql.query<RowDataPacket[]>('SELECT account_incarnation FROM proxy_accounts WHERE identity=?', [row.identity]);
    const incarnation = String(accounts[0].account_incarnation);
    const task = { id: taskId, bindingVersion: 2, enterpriseId: row.enterprise_id, enterpriseRevision: row.enterprise_revision,
      accountIncarnation: incarnation, expectedGhLogin: ghLogin, identity: row.identity, ssoUser: row.identity, ghLogin,
      oauthAttemptId: nonce, ssoType: 'custom', status: 'cancelled', attempts: 1, createdAt: new Date().toISOString() };
    const adapter = realProvisioner(first, options, {
      enterpriseProfile: id => reg.profiles.find(profile => profile.id === id)!,
      getAccount: async () => ({ enterpriseId: row.enterprise_id, accountIncarnation: incarnation, identity: row.identity,
        ssoUser: row.identity, ghLogin, copilotOauthStatus: 'missing', createdAt: task.createdAt, updatedAt: task.createdAt }),
      fetch: async (_input, init) => { assert.equal(init?.method, 'GET'); return Response.json(task); },
    });
    const context = { signal: new AbortController().signal, assertCurrent: () => {} };
    let fence = (await first.inventory(row.identity))!;
    for (const status of ['cancel_requested', 'uncertain']) {
      task.status = status;
      assert.equal(await adapter.reconcileLoginReservation!(fence, context), undefined);
      assert.equal((await first.listLoginReservations()).length, 1);
    }
    task.status = 'cancelled'; task.accountIncarnation = randomUUID();
    await assert.rejects(adapter.reconcileLoginReservation!(fence, context), /oauth_task_mismatch/);
    task.accountIncarnation = incarnation;
    const outcome = await adapter.reconcileLoginReservation!(fence, context); assert.equal(outcome, 'failed');
    assert.equal(await first.releaseLoginReservation(row.identity, fence, 'stale-owner', outcome!), false);
    await sql.query("UPDATE proxy_accounts SET copilot_oauth_token='synthetic-generation-replacement' WHERE identity=?", [row.identity]);
    assert.equal(await first.releaseLoginReservation(row.identity, fence, owner, outcome!), false, 'old generation cannot release');
    fence = (await first.inventory(row.identity))!;
    assert.equal(await first.releaseLoginReservation(row.identity, fence, owner, outcome!), true);
    const released = (await first.inventory(row.identity))!;
    assert.equal(released.identity, accountName(0));
    assert.equal(released.state, 'disabled'); assert.equal(released.attempts, 1);
    assert.equal(released.last_error, 'sso_http_503'); assert.equal(released.stage, 'synced');
    assert.equal(released.task_id, null); assert.equal(released.oauth_attempt_id, null);
    assert.equal(released.generation, fence.generation + 1); assert.equal((await first.listLoginReservations()).length, 0);
    assert.equal(await first.releaseLoginReservation(row.identity, fence, owner, outcome!), false);
    await first.releaseOwner(owner);
  });
  await t.test('global name catalog never repeats across enterprises, concurrent stores or restart', async () => {
    const { accountName, NAME_CAPACITY } = await import('./names.js');
    await reset(4);
    const owner = randomUUID(); assert.equal(await first.claimOwner(owner), true);
    await sql.query(`INSERT INTO proxy_accounts(enterprise_id,account_incarnation,identity,sso_user,copilot_oauth_status,created_at,updated_at)
      VALUES(?,?,?,?,'missing',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [B, randomUUID(), 'synthetic-direct-collision', accountName(0).toUpperCase()]);
    // No owner passed for this intentionally concurrent reserve pair: both still
    // serialize the same settings/cursor row and preserve one global name space.
    const reserved = await Promise.all([first.reserve(), second.reserve()]);
    assert.ok(reserved.every(Boolean)); assert.equal(new Set(reserved.map(row => row!.identity)).size, 2);
    assert.equal(new Set(reserved.map(row => row!.enterprise_id)).size, 2);
    const restarted = new MysqlPoolStore(pool, options, reg); await restarted.initialize();
    assert.equal(await restarted.reserveDeficit(owner), 2);
    const [rows] = await sql.query<RowDataPacket[]>(`SELECT p.identity,p.ordinal,a.enterprise_id FROM user_pool_accounts p
      JOIN proxy_accounts a ON a.identity=p.identity ORDER BY p.ordinal`);
    assert.deepEqual(rows.map(row => Number(row.ordinal)), [1, 2, 3, 4]);
    assert.deepEqual(rows.map(row => row.identity), [1, 2, 3, 4].map(accountName));
    assert.equal(new Set(rows.map(row => row.identity)).size, 4);
    assert.equal((await first.accounts(A)).length, 2); assert.equal((await first.accounts(B)).length, 2);
    await first.updateEnterprisePolicy(A, 1, { type: 'drain' });
    await sql.query('UPDATE user_pool_settings SET next_ordinal=?,idle_target=3 WHERE id=1', [NAME_CAPACITY - 1]);
    assert.equal(await restarted.reserveDeficit(owner, [B]), 1);
    assert.equal((await restarted.inventory(accountName(NAME_CAPACITY - 1)))?.enterprise_id, B);
    await sql.query('UPDATE user_pool_settings SET idle_target=4 WHERE id=1');
    assert.equal(await restarted.reserveDeficit(owner, [B]), 0);
    const overview = await restarted.enterpriseOverview();
    assert.equal(overview.names.nextOrdinal, NAME_CAPACITY); assert.equal(overview.names.remainingPositions, 0);
    assert.equal((await first.counts()).total, 5); await first.releaseOwner(owner);
  });
  await t.test('same caller converges and distinct callers never share a live member', async () => {
    await reset(2); await ready(2);
    const holds = await Promise.all([first.acquire(caller(1)), second.acquire(caller(1)), first.acquire(caller(1))]);
    assert.equal(new Set(holds.map(row => row.lease_id)).size, 1);
    const others = await Promise.allSettled([first.acquire(caller(2)), second.acquire(caller(3))]);
    assert.equal(others.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(others.filter(row => row.status === 'rejected').length, 1);
    for (const held of holds) await first.finish(held, false);
    for (const result of others) if (result.status === 'fulfilled') await first.finish(result.value, false);
  });
  await t.test('cap CAS versus concurrent registration never exceeds the cap or evicts', async () => {
    await reset(10);
    await first.updateEnterprisePolicy(B, 1, { type: 'drain' });
    await first.updateEnterprisePolicy(A, 1, { type: 'cap', maxAccounts: 2 });
    await Promise.all([first.reserve(), second.updateEnterprisePolicy(A, 2, { type: 'cap', maxAccounts: 1 })]);
    await Promise.all([first.reserve(), second.reserve()]);
    assert.equal((await first.counts(A)).total, 1);
    assert.equal((await first.enterprisePolicy(A))?.maxAccounts, 1);
  });
  await t.test('admission holds final policy SHARE so drain waits without joined-profile lock inversion', async () => {
    await reset(1); await first.updateEnterprisePolicy(B, 1, { type: 'drain' }); await ready(1);
    let reached!: () => void, release!: () => void;
    const policyHeld = new Promise<void>(resolve => { reached = resolve; });
    const continueAdmission = new Promise<void>(resolve => { release = resolve; });
    const interceptedPool = { ...pool, async getConnection() {
      const connection = await pool.getConnection();
      return new Proxy(connection, { get(target, key) {
        if (key === 'query') return async (...args: unknown[]) => {
          const result = await Reflect.apply(target.query, target, args);
          if (typeof args[0] === 'string' && /enterprise_pool_policy WHERE enterprise_id=\? FOR SHARE/.test(args[0])) {
            reached(); await continueAdmission;
          }
          return result;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    } } as Pool;
    const admitting = new MysqlPoolStore(interceptedPool, options, reg); await admitting.initialize();
    const admission = admitting.acquire(caller(4));
    await policyHeld;
    let done = false;
    const drain = second.updateEnterprisePolicy(A, 1, { type: 'drain' }).then(row => { done = true; return row; });
    try { await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(done, false); }
    finally { release(); }
    const held = await admission; await drain;
    assert.equal(held.enterprise_id, A);
    const continued = await first.acquire(caller(4));
    assert.equal(continued.lease_id, held.lease_id);
    await assert.rejects(second.acquireCatalog(caller(4)), { code: 'enterprise_not_active' });
    await first.finish(held, false); await first.finish(continued, false);
  });
  await t.test('drain winning before admission preserves catalog affinity without enterprise escape', async () => {
    await reset(2); await ready(2);
    const catalog = await first.acquireCatalog(caller(5));
    await second.updateEnterprisePolicy(catalog.enterprise_id, 1, { type: 'drain' });
    await assert.rejects(first.acquire(caller(5)), { code: 'enterprise_not_active' });
    assert.equal((await first.leases()).length, 0);
    await first.finish(catalog, false);
  });
  await t.test('owner handoff and held generation fences survive policy changes', async () => {
    await reset(1); await ready(1);
    const owner = randomUUID(), successor = randomUUID();
    assert.equal(await first.claimOwner(owner), true);
    await sql.query('UPDATE user_pool_settings SET owner_until=0 WHERE id=1');
    assert.equal(await first.renewOwner(owner), false);
    assert.equal(await second.claimOwner(successor), true);
    assert.equal(await first.reserveDeficit(owner), 0);
    const held = await first.acquire(caller(6));
    await second.updateEnterprisePolicy(held.enterprise_id, 1, { type: 'drain' });
    assert.equal(await first.heartbeat(held), true);
    await sql.query("UPDATE proxy_accounts SET copilot_oauth_token='synthetic-replacement' WHERE identity=?", [held.member_identity]);
    assert.equal(await first.heartbeat(held), false);
    await first.finish(held, true);
    const [leases] = await sql.query<RowDataPacket[]>('SELECT phase FROM user_pool_leases WHERE lease_id=?', [held.lease_id]);
    assert.notEqual(leases[0]?.phase, 'active');
  });
}));
