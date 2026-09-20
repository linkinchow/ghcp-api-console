import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection } from 'mysql2/promise';
import { withEnterpriseMysqlTestSchema } from './mysqlHarness.js';
import { readNameCatalogTestGate } from '../../tests/enterprise-phase7/name-gate.js';

// No driver, schema or configured runtime is imported unless BOTH gates pass.
const gate = readNameCatalogTestGate();
const skip = !gate.enabled ? 'Dedicated name-catalog gate absent; real MySQL NOT EXECUTED, zero connections attempted.' : false;
const quote = (name: string) => { assert.match(name, /^[a-z_][a-z0-9_]*$/); return `\`${name}\``; };

/** Includes markers, receipts, policies, trigger DDL and every typed row, not only business rows. */
async function completeSnapshot(c: Connection) {
  const [tables] = await c.query<any[]>('SELECT TABLE_NAME name,AUTO_INCREMENT sequence FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME');
  const result: unknown[] = [];
  for (const { name, sequence } of tables) {
    const [ddl] = await c.query<any[]>(`SHOW CREATE TABLE ${quote(name)}`);
    const [columns] = await c.query<any[]>('SELECT COLUMN_NAME name,COLUMN_TYPE type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [name]);
    const [rows] = await c.query<any[]>(`SELECT ${columns.map(col => `HEX(CAST(${quote(col.name)} AS BINARY)) AS ${quote(col.name)}`).join(',')} FROM ${quote(name)}`);
    result.push({ name, sequence, ddl, columns, rows: rows.map(row => JSON.stringify(row)).sort() });
  }
  const [triggers] = await c.query<any[]>('SELECT TRIGGER_NAME,ACTION_TIMING,EVENT_MANIPULATION,EVENT_OBJECT_TABLE,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME');
  result.push({ triggers });
  return result;
}

function recordReads(c: Connection, statements: string[]): Connection {
  return new Proxy(c, { get(target, key) {
    if (key === 'query' || key === 'execute') return (...args: unknown[]) => {
      assert.equal(typeof args[0], 'string');
      const sql = args[0] as string; statements.push(sql);
      assert.match(sql, /^(?:SELECT|SHOW)\b/i, 'Validation must not dispatch a mutation');
      assert.doesNotMatch(sql, /FOR UPDATE|FOR SHARE|LOCK IN SHARE MODE|GET_LOCK/i, 'Startup must not lock a writer');
      return Reflect.apply(target[key], target, args);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

for (const version of [3, 4] as const) {
  for (const scenario of ['old-ordinal-1000', 'ambiguous-cursor-1001', 'unchanged-prefix', 'new-catalog-witness'] as const) {
    test(`real MySQL name catalog v${version} ${scenario}: exact read-only qualification`, { skip, timeout: 60_000 }, async () => {
      // Separate acknowledged-empty lifecycle per case. No DELETE/reset of failed
      // inventory, cursor, schema marker or receipt to make the next case pass.
      await withEnterpriseMysqlTestSchema(gate, async h => {
        const [{ registryV3, poolOptionsV3, A }, { initEnterpriseMysqlV3 }, { initEnterpriseMysqlV4, validateEnterpriseMysqlV4 },
          { preflightEnterpriseMysqlV4 }, { accountName, PoolNameCatalogCompatibilityError }, { randomUUID }] = await Promise.all([
          import('../multi-enterprise/fixtures.js'), import('../../src/packages/shared/src/enterpriseMysqlV3.js'),
          import('../../src/packages/shared/src/enterpriseMysqlV4.js'), import('./mysql.js'),
          import('../../src/packages/shared/src/poolNames.js'), import('node:crypto'),
        ]);
        const c = h.connection, registry = registryV3();
        await (version === 3 ? initEnterpriseMysqlV3 : initEnterpriseMysqlV4)(c, 'proxy', registry, poolOptionsV3());
        const ordinal = scenario === 'unchanged-prefix' ? 39 : 1000;
        if (scenario !== 'ambiguous-cursor-1001') {
          const identity = scenario === 'old-ordinal-1000' ? 'aaliyah.abbott01' : accountName(ordinal);
          await c.query(`INSERT INTO proxy_accounts(enterprise_id,account_incarnation,identity,sso_user,created_at,updated_at)
            VALUES(?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [A, randomUUID(), identity, identity]);
          await c.query("INSERT INTO user_pool_accounts(identity,ordinal,state,stage,attempt_id,updated_at) VALUES(?,?,'disabled','new',?,1)", [identity, ordinal, randomUUID()]);
        }
        await c.query('UPDATE user_pool_settings SET next_ordinal=? WHERE id=1', [ordinal + 1]);
        const before = await completeSnapshot(c), statements: string[] = [], checked = recordReads(c, statements);
        const validate = () => version === 3 ? preflightEnterpriseMysqlV4(checked, registry, 'pool') : validateEnterpriseMysqlV4(checked, 'proxy', registry);
        if (scenario === 'old-ordinal-1000' || scenario === 'ambiguous-cursor-1001') await assert.rejects(validate(), PoolNameCatalogCompatibilityError);
        else await validate();
        assert.deepEqual(await completeSnapshot(c), before, 'No row, typed byte, cursor, marker, receipt, DDL or sequence may change');
        assert.equal(statements.filter(sql => sql.startsWith('SELECT s.next_ordinal,p.identity,p.ordinal,a.sso_user')).length, 1);
        const [marker] = await c.query<any[]>('SELECT schema_version FROM enterprise_schema');
        assert.equal(Number(marker[0].schema_version), version);
      });
    });
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('name_catalog_concurrency_barrier_timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}

test('real MySQL startup/reserve interleaving crosses ordinal1000 with one committed catalog snapshot', { skip, timeout: 60_000 }, async () => {
  await withEnterpriseMysqlTestSchema(gate, async h => {
    const [{ registryV3, poolOptionsV3 }, { initEnterpriseMysqlV4, validateEnterpriseMysqlV4, validatePoolNameCatalogMysqlV4 },
      { MysqlPoolStore }, { normalizePoolConfig }, { connectionPool }, { enterpriseProfileIdentityHashV4 },
      { enterpriseRegistryHashV3 }, { accountName }, { createHash }] = await Promise.all([
      import('../multi-enterprise/fixtures.js'), import('../../src/packages/shared/src/enterpriseMysqlV4.js'),
      import('../../src/proxy/src/userPool/mysqlStore.js'), import('../../src/proxy/src/userPool/config.js'),
      import('../../tests/enterprise-phase5/db-fixtures.js'), import('../../src/packages/shared/src/enterpriseRuntimeV4.js'),
      import('../../src/packages/shared/src/enterpriseRuntimeV3.js'), import('../../src/packages/shared/src/poolNames.js'), import('node:crypto'),
    ]);
    const registry = registryV3();
    const options = normalizePoolConfig({ enabled: true, accountDomain: registry.profiles[0].accountDomain, idleTarget: 1,
      maxAccounts: 10, leaseSeconds: 600, provisionalSeconds: 30, pollMs: 1000,
      retryAfterSeconds: 1, warmupModel: 'synthetic-no-http', requestTimeoutMs: 120000 });
    const { idleTarget: _i, maxAccounts: _m, leaseSeconds: _l, enabled: _e, callerDomain: _d, ...invariants } = options;
    const init = poolOptionsV3();
    init.pool.fingerprint = createHash('sha256').update(JSON.stringify(Object.entries(invariants).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
    await initEnterpriseMysqlV4(h.connection, 'proxy', registry, init);
    const writer = await h.openConnection(), reader = await h.openConnection();
    const commitReached = deferred(), commitAllowed = deferred();
    let interceptCommit = false;
    const writerProxy = new Proxy(writer, { get(target, key) {
      if (key === 'commit') return async () => {
        if (interceptCommit) { commitReached.resolve(); await bounded(commitAllowed.promise); }
        return target.commit();
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const store = new MysqlPoolStore(connectionPool(writerProxy), options, registry);
    await store.initialize();
    const profile = registry.profiles[0], now = await store.now();
    const binding = { enterpriseId: profile.id, enterpriseRevision: profile.revision, profileIdentitySha256: enterpriseProfileIdentityHashV4(profile),
      registryRevision: registry.registryRevision, registrySha256: enterpriseRegistryHashV3(registry), legacyEnterpriseId: registry.legacyEnterpriseId };
    const probe = { ...binding, probeVersion: 1 as const, schemaVersion: 3, contractVersion: 2 as const,
      capability: 'enterprise-isolation-legacy-pool', ready: true, blockers: [] };
    const evidence = { ...binding, version: 1 as const, checkedAt: now,
      sso: { ...probe, component: 'sso' as const }, login: { ...probe, component: 'login' as const } };
    const validated = await store.updateEnterprisePolicy(profile.id, 1, { type: 'validate', evidence });
    await store.updateEnterprisePolicy(profile.id, validated.policyVersion, { type: 'activate', evidence });
    await store.updateSettings((await store.settings()).version, { paused: 0, idle_target: 1 });
    // Fresh fixture only: advance once to the unchanged-prefix boundary. Never rewind.
    await h.connection.query('UPDATE user_pool_settings SET next_ordinal=1000 WHERE id=1');
    interceptCommit = true;
    const reservation = store.reserve();
    void reservation.catch(() => {}); // A failed writer is still awaited below, never an unhandled rejection.
    const statements: string[] = [], readOnly = recordReads(reader, statements);
    let oldCursor: number | undefined, newCursor: number | undefined;
    const racing = new Proxy(readOnly, { get(target, key) {
      if (key === 'query') return async (...args: unknown[]) => {
        const result = await Reflect.apply(target.query, target, args);
        if (args[0] === 'SELECT * FROM user_pool_settings') {
          oldCursor = Number((result[0] as any[])[0].next_ordinal);
          commitAllowed.resolve();
          assert.equal((await bounded(reservation))?.identity, accountName(1000));
        }
        if (typeof args[0] === 'string' && args[0].startsWith('SELECT s.next_ordinal,p.identity,p.ordinal,a.sso_user')) {
          newCursor = Number((result[0] as any[])[0].next_ordinal);
          assert.equal((result[0] as any[])[0].identity, accountName(1000));
        }
        return result;
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      await bounded(Promise.race([commitReached.promise, reservation.then(() => { throw new Error('reservation_did_not_reach_commit_barrier'); })]));
      // The writer still holds cursor/account locks and has not committed. The
      // standalone check must finish immediately on the previous consistent image.
      await bounded(validatePoolNameCatalogMysqlV4(readOnly), 5000);
      statements.length = 0;
      await bounded(validateEnterpriseMysqlV4(racing, 'proxy', registry));
      assert.equal(oldCursor, 1000); assert.equal(newCursor, 1001);
      assert.equal(statements.filter(sql => sql.startsWith('SELECT s.next_ordinal,p.identity,p.ordinal,a.sso_user')).length, 1);
      const [inventory] = await h.connection.query<any[]>('SELECT identity,ordinal FROM user_pool_accounts');
      assert.deepEqual(inventory.map(row => ({ identity: row.identity, ordinal: Number(row.ordinal) })), [{ identity: accountName(1000), ordinal: 1000 }]);
      const beforeRestart = await completeSnapshot(h.connection);
      const restarted = new MysqlPoolStore(connectionPool(await h.openConnection()), options, registry);
      await restarted.initialize();
      assert.deepEqual(await completeSnapshot(h.connection), beforeRestart, 'Real store startup must be read-only after reservation');
    } finally {
      commitAllowed.resolve();
      await bounded(reservation).catch(() => {});
    }
  });
});
