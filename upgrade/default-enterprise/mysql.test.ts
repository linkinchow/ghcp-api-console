import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { canonicalMysqlCheck, MYSQL_CREDENTIAL_FENCE_BODY, MYSQL_SCHEMA } from '../../src/packages/shared/src/enterpriseMysqlV1.js';
import { initEnterpriseMysql, validateEnterpriseMysql, withEnterpriseMysqlDeadline, EnterpriseMysqlError, ENTERPRISE_MYSQL_LOCK } from '../../src/packages/shared/src/enterpriseMysql.js';
import { applyEnterpriseMysql, inspectEnterpriseMysql, preflightEnterpriseMysql, verifyEnterpriseMysqlMigration } from './mysql.js';
import { fixture, profile, plan, type Row } from './mysql.fixture.js';

for (const layout of ['direct', 'pool'] as const) {
  test(`v2 ${layout} validates complete shape and is strictly read only`, async () => {
    const f = fixture(layout);
    assert.deepEqual(await validateEnterpriseMysql(f.connection, 'proxy', profile), { profile, layout, ...(layout === 'pool' ? { maxAccounts: 6 } : {}) });
    assert.equal(f.mutations.length, 0);
    assert(f.statements.every(sql => sql.startsWith('SELECT')));
  });
  test(`init ${layout} only accepts empty schema`, async () => {
    const existing = fixture(layout);
    await assert.rejects(initEnterpriseMysql(existing.connection, 'proxy', profile), /init_requires_empty/);
    assert.equal(existing.mutations.length, 0);
    const empty = fixture(layout, 0);
    await initEnterpriseMysql(empty.connection, 'proxy', profile, layout === 'pool' ? { layout, maxAccounts: 6, pool: { fingerprint: 'a'.repeat(64), settings: {
      version: 1, idle_target: 2, lease_seconds: 172800, paused: 1, next_ordinal: 0, account_domain: profile.accountDomain, owner: null, owner_until: 0,
    } } } : { layout });
    assert.equal((await validateEnterpriseMysql(empty.connection, 'proxy', profile)).layout, layout);
    assert.equal(empty.data.enterprise_upgrade.length, 0);
  });
  test(`v1 ${layout} migrates without changing any frozen column, cap only moves`, async () => {
    const f = fixture(layout, 1);
    const sourceAccounts = structuredClone(f.data.proxy_accounts);
    const before = await preflightEnterpriseMysql(f.connection, profile, layout);
    assert.equal(f.mutations.length, 0);
    assert.equal((await inspectEnterpriseMysql(f.connection)).state, 'v1');
    const options = plan(before.sourceSha256);
    const result = await applyEnterpriseMysql(f.connection, profile, options);
    assert.equal(result.resumed, false);
    assert.equal(result.sourceSha256, before.sourceSha256);
    assert.deepEqual(f.data.proxy_accounts.map(({ enterprise_id, ...row }) => row), sourceAccounts);
    assert(f.data.proxy_accounts.every(row => row.enterprise_id === profile.id));
    if (layout === 'pool') {
      assert.equal(f.data.enterprise_profiles[0].max_accounts, 6);
      assert.equal(Object.hasOwn(f.schema.user_pool_settings.columns, 'max_accounts'), false);
      assert.equal(f.triggers.user_pool_credential_fence.body, MYSQL_CREDENTIAL_FENCE_BODY);
    }
    assert.equal(f.data.enterprise_upgrade[0].state, 'complete');
    assert.equal((await inspectEnterpriseMysql(f.connection)).state, 'v2');
    await verifyEnterpriseMysqlMigration(f.connection, profile, options);
    await assert.rejects(verifyEnterpriseMysqlMigration(f.connection, profile, { ...options, backupSha256: '0'.repeat(64) }), /checkpoint_binding/);
    const count = f.mutations.length;
    assert.equal((await applyEnterpriseMysql(f.connection, profile, { ...options, resume: true })).resumed, true);
    assert.equal(f.mutations.length, count);
    f.data.proxy_accounts[0].copilot_oauth_token += 'changed';
    await assert.rejects(verifyEnterpriseMysqlMigration(f.connection, profile, options), /source_changed/);
  });
}

test('concurrent initializers serialize all inspection and DDL under the shared migration lock', { timeout: 3000 }, async () => {
  const f = fixture('direct', 0);
  let owner: number | undefined;
  const waiting: Array<() => void> = [];
  const trace: Array<{ id: number; sql: string }> = [];
  const connection = (id: number) => ({
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes('GET_LOCK')) {
        assert.equal(values[0], ENTERPRISE_MYSQL_LOCK);
        if (owner !== undefined) await new Promise<void>(resolve => waiting.push(resolve));
        assert.equal(owner, undefined); owner = id; trace.push({ id, sql }); return [[{ acquired: 1 }]];
      }
      assert.equal(owner, id, 'Inspection, DDL, verification and cleanup must retain exclusive lock ownership');
      trace.push({ id, sql });
      if (sql.includes('RELEASE_LOCK')) { owner = undefined; waiting.shift()?.(); return [[{ released: 1 }]]; }
      await new Promise(resolve => setImmediate(resolve));
      return f.connection.query(sql, values);
    },
    destroy() { if (owner === id) { owner = undefined; waiting.shift()?.(); } },
  }) as any;
  const results = await Promise.allSettled([initEnterpriseMysql(connection(1), 'proxy', profile), initEnterpriseMysql(connection(2), 'proxy', profile)]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match((results[1] as PromiseRejectedResult).reason.message, /init_requires_empty/);
  const firstRelease = trace.findIndex(row => row.id === 1 && row.sql.includes('RELEASE_LOCK'));
  assert(firstRelease >= 0);
  assert(trace.slice(0, firstRelease).every(row => row.id === 1));
  assert(trace.filter(row => row.id === 2).every(row => row.sql.startsWith('SELECT')));
  assert.equal(owner, undefined);
  assert.equal(f.data.enterprise_schema.length, 1);
});

test('initializer lock refusal or uncertain acquisition never inspects or mutates the schema', async () => {
  for (const acquired of [0, null]) {
    const f = fixture('direct', 0);
    const connection = { async query(sql: string, values: unknown[]) {
      assert(sql.includes('GET_LOCK')); assert.equal(values[0], ENTERPRISE_MYSQL_LOCK); return [[{ acquired }]];
    }, destroy() { f.connection.destroy(); } } as any;
    await assert.rejects(initEnterpriseMysql(connection, 'proxy', profile), /lock_unavailable/);
    assert.equal(f.statements.length, 0);
    assert.equal(f.destroyed, acquired === null);
  }
  const f = fixture('direct', 0);
  f.failWhen(sql => sql.includes('GET_LOCK'));
  await assert.rejects(initEnterpriseMysql(f.connection, 'proxy', profile), /statement_outcome_unknown/);
  assert.equal(f.destroyed, true);
  assert.equal(f.mutations.length, 0);
});

test('initializer checks full schema and fixture data before publishing the complete marker', async () => {
  for (const kind of ['shape', 'data'] as const) {
    const f = fixture('direct', 0);
    if (kind === 'shape') f.alterMetadata((key, table, rows) => key === 'columns' && table === 'proxy_accounts'
      ? rows.map(row => row.COLUMN_NAME === 'enterprise_id' ? { ...row, IS_NULLABLE: 'YES' } : row) : rows);
    const connection = { async query(sql: string, values: unknown[]) {
      if (kind === 'data' && sql.startsWith('SELECT COUNT(*) AS n FROM proxy_accounts')) return [[{ n: 1 }]];
      return f.connection.query(sql, values);
    }, destroy() { f.connection.destroy(); } } as any;
    await assert.rejects(initEnterpriseMysql(connection, 'proxy', profile));
    assert.equal(f.data.enterprise_schema.length, 0);
    assert.equal(f.mutations.some(sql => sql.startsWith('INSERT INTO enterprise_schema')), false);
    assert(f.statements.some(sql => sql.includes('RELEASE_LOCK')));
    await assert.rejects(validateEnterpriseMysql(f.connection, 'proxy', profile));
  }
});

test('initializer cleanup destroys an uncertain lock owner and preserves an earlier error', async () => {
  const f = fixture('direct', 0);
  f.failWhen(sql => sql.includes('RELEASE_LOCK'));
  await assert.rejects(initEnterpriseMysql(f.connection, 'proxy', profile), /lock_release_unknown/);
  assert.equal(f.destroyed, true);
  const existing = fixture('direct');
  existing.failWhen(sql => sql.includes('RELEASE_LOCK'));
  await assert.rejects(initEnterpriseMysql(existing.connection, 'proxy', profile), /init_requires_empty/);
  assert.equal(existing.destroyed, true);
});

test('initializer deadline while owning the lock destroys socket without publishing a marker', { timeout: 3000 }, async () => {
  const f = fixture('direct', 0);
  let acquired = false;
  const connection = { async query(sql: string, values: unknown[]) {
    if (sql.includes('GET_LOCK')) { acquired = true; return [[{ acquired: 1 }]]; }
    assert(acquired);
    return new Promise(resolve => setTimeout(() => resolve([[]]), 50));
  }, destroy() { f.connection.destroy(); } } as any;
  await assert.rejects(withEnterpriseMysqlDeadline(connection, c => initEnterpriseMysql(c, 'proxy', profile), 15), /deadline/);
  assert.equal(f.destroyed, true);
  assert.equal(f.mutations.length, 0);
});

test('direct layout rejects non-null capacity and initializer rejects it before any SQL', async () => {
  const direct = fixture('direct');
  direct.data.enterprise_profiles[0].max_accounts = 7;
  await assert.rejects(validateEnterpriseMysql(direct.connection, 'proxy', profile), /enterprise_mysql_capacity/);
  assert.equal(direct.mutations.length, 0);
  const empty = fixture('direct', 0);
  await assert.rejects(initEnterpriseMysql(empty.connection, 'proxy', profile, { layout: 'direct', maxAccounts: 7 }), /enterprise_mysql_capacity/);
  assert.equal(empty.statements.length, 0);
});

test('MySQL fixtures contain escaped NUL test data, never literal NUL source bytes', () => {
  for (const file of ['mysql.fixture.ts', 'mysql.integration.test.ts']) {
    assert.equal(readFileSync(new URL(file, import.meta.url)).includes(0), false, file);
  }
});

test('frozen baseline includes all runtime baseline columns and identical credential trigger', () => {
  const root = new URL('../../src/proxy/src/db/mysqlSchema.ts', import.meta.url);
  const source = readFileSync(root, 'utf8');
  const body = source.match(/MYSQL_CREDENTIAL_FENCE_BODY = `([\s\S]*?)`;/)![1];
  assert.equal(MYSQL_CREDENTIAL_FENCE_BODY, body.replace(/\r\n/g, '\n'));
  assert.equal(MYSQL_SCHEMA.proxy_accounts.columns.copilot_oauth_token, 'TEXT COLLATE utf8mb4_bin');
});

test('CHECK parser accepts MySQL metadata quoting but not changed semantics', () => {
  assert.equal(canonicalMysqlCheck('max_accounts >= 1 AND max_accounts <= 10000'), canonicalMysqlCheck('((`max_accounts` >= 1) and (`max_accounts` <= 10000))'));
  assert.equal(canonicalMysqlCheck("state IN ('provisioning','ready')"), canonicalMysqlCheck("(`state` in (_utf8mb4\\'provisioning\\',_ascii\\'ready\\'))"));
  for (const sql of ['x=1 OR 1', 'x=1 /* comment */', 'x=1) and (y=2', "state IN ('re\\ady')", 'x >= 1 AND x <= 10000 OR 1']) assert.equal(canonicalMysqlCheck(sql), undefined);
  assert.notEqual(canonicalMysqlCheck("state IN ('READY')"), canonicalMysqlCheck("state IN ('ready')"));
});

const alterations: Array<[string, string, string, (rows: Row[]) => Row[]]> = [
  ['unknown table', 'tables', '', rows => [...rows, { TABLE_NAME: 'surprise', TABLE_TYPE: 'BASE TABLE' }]],
  ['missing column', 'columns', 'proxy_accounts', rows => rows.filter(row => row.COLUMN_NAME !== 'enterprise_id')],
  ['nullable enterprise', 'columns', 'proxy_accounts', rows => rows.map(row => row.COLUMN_NAME === 'enterprise_id' ? { ...row, IS_NULLABLE: 'YES' } : row)],
  ['identity collation', 'columns', 'enterprise_profiles', rows => rows.map(row => row.COLUMN_NAME === 'id' ? { ...row, COLLATION_NAME: 'ascii_general_ci' } : row)],
  ['extra generated', 'columns', 'proxy_accounts', rows => rows.map(row => row.COLUMN_NAME === 'enterprise_id' ? { ...row, GENERATION_EXPRESSION: "'x'" } : row)],
  ['changed type', 'columns', 'user_pool_accounts', rows => rows.map(row => row.COLUMN_NAME === 'generation' ? { ...row, COLUMN_TYPE: 'int' } : row)],
  ['extra index', 'indexes', 'proxy_accounts', rows => [...rows, { ...rows[0], INDEX_NAME: 'unexpected' }]],
  ['descending direction', 'indexes', 'proxy_request_stats', rows => rows.map(row => row.COLUMN_NAME === 'requested_at' ? { ...row, COLLATION: 'A' } : row)],
  ['unique prefix', 'indexes', 'enterprise_profiles', rows => rows.map(row => row.INDEX_NAME === 'id' ? { ...row, SUB_PART: 6 } : row)],
  ['invisible index', 'indexes', 'proxy_accounts', rows => rows.map(row => ({ ...row, IS_VISIBLE: 'NO' }))],
  ['missing foreign', 'foreign', 'proxy_accounts', () => []],
  ['cross database foreign', 'foreign', 'proxy_accounts', rows => rows.map(row => ({ ...row, local_reference: 0 }))],
  ['cascade identity', 'foreign', 'proxy_accounts', rows => rows.map(row => ({ ...row, UPDATE_RULE: 'CASCADE' }))],
  ['unenforced check', 'checks', 'enterprise_profiles', rows => rows.map(row => ({ ...row, ENFORCED: 'NO' }))],
  ['widened cap', 'checks', 'enterprise_profiles', rows => rows.map(row => ({ ...row, CHECK_CLAUSE: row.CHECK_CLAUSE.replace('10000', '10001') }))],
  ['missing trigger', 'triggers', '', rows => rows.filter(row => row.TRIGGER_NAME !== 'enterprise_profile_no_delete')],
  ['altered credential', 'triggers', '', rows => rows.map(row => row.TRIGGER_NAME === 'user_pool_credential_fence' ? { ...row, ACTION_STATEMENT: row.ACTION_STATEMENT.replace('generation + 1', 'generation + 0') } : row)],
  ['altered identity guard', 'triggers', '', rows => rows.map(row => row.TRIGGER_NAME === 'enterprise_account_immutable' ? { ...row, ACTION_STATEMENT: 'BEGIN END' } : row)],
];
for (const [name, kind, table, alter] of alterations) test(`strict gate rejects ${name} without DDL`, async () => {
  const f = fixture();
  f.alterMetadata((k, t, rows) => k === kind && t === table ? alter(rows) : rows);
  await assert.rejects(validateEnterpriseMysql(f.connection, 'proxy', profile), EnterpriseMysqlError);
  assert.equal(f.mutations.length, 0);
});

test('empty, legacy, partial, marker-only, wrong profile and incomplete upgrades fail closed', async () => {
  for (const version of [0, 1] as const) { const f = fixture('direct', version); await assert.rejects(validateEnterpriseMysql(f.connection, 'proxy', profile)); assert.equal(f.mutations.length, 0); }
  const f = fixture(); delete f.schema.user_pool_holds;
  await assert.rejects(validateEnterpriseMysql(f.connection, 'proxy', profile));
  const marker = fixture(); marker.data.enterprise_schema[0].schema_version = 3;
  await assert.rejects(validateEnterpriseMysql(marker.connection, 'proxy', profile));
  const mismatch = fixture(); await assert.rejects(validateEnterpriseMysql(mismatch.connection, 'proxy', { ...profile, slug: 'wrong' }));
  mismatch.data.enterprise_upgrade.push({ state: 'applying' });
  await assert.rejects(validateEnterpriseMysql(mismatch.connection, 'proxy', profile));
});

test('maintenance attestations, source digest and database bindings reject before DDL', async () => {
  for (const change of [{ confirmOffline: false }, { confirmBackup: false }, { confirmDrained: false }, { expectedDatabase: 'other' }, { expectedSourceSha256: '0'.repeat(64) }]) {
    const f = fixture('pool', 1); const before = await preflightEnterpriseMysql(f.connection, profile);
    await assert.rejects(applyEnterpriseMysql(f.connection, profile, { ...plan(before.sourceSha256), ...change }));
    assert.equal(f.mutations.length, 0);
  }
  const f = fixture('pool', 1); f.data.user_pool_holds.push({ request_id: 'expired-still-undrained' });
  await assert.rejects(preflightEnterpriseMysql(f.connection, profile), /not_drained/);
  assert.equal(f.mutations.length, 0);
});

for (const interrupted of ['CREATE TABLE `enterprise_profiles`', 'INSERT INTO enterprise_profiles', 'ALTER TABLE proxy_accounts ADD',
  'UPDATE proxy_accounts SET enterprise_id', 'ALTER TABLE proxy_accounts MODIFY', 'ALTER TABLE user_pool_settings DROP',
  'CREATE TRIGGER enterprise_profile_immutable', 'CREATE TRIGGER enterprise_profile_no_delete', 'CREATE TRIGGER enterprise_account_immutable',
  'CREATE TABLE `enterprise_schema`', 'INSERT INTO enterprise_schema']) {
  test(`lost statement acknowledgment stops, explicit inspected resume: ${interrupted}`, async () => {
    const f = fixture('pool', 1); const before = await preflightEnterpriseMysql(f.connection, profile);
    const options = plan(before.sourceSha256);
    f.loseResponseWhen(sql => sql.startsWith(interrupted));
    await assert.rejects(applyEnterpriseMysql(f.connection, profile, options), /statement_outcome_unknown/);
    assert.equal(f.destroyed, true);
    assert.equal(f.data.enterprise_upgrade[0].checkpoint_state, 'unknown');
    const attempts = f.mutations.filter(sql => sql.startsWith(interrupted)).length;
    assert.equal(attempts, 1);
    f.reconnect();
    await assert.rejects(validateEnterpriseMysql(f.connection, 'proxy', profile));
    await assert.rejects(applyEnterpriseMysql(f.connection, profile, options), /resume_required/);
    await applyEnterpriseMysql(f.connection, profile, { ...options, resume: true });
    assert.equal(f.mutations.filter(sql => sql.startsWith(interrupted)).length, 1);
    assert.equal((await inspectEnterpriseMysql(f.connection)).state, 'v2');
  });
}

test('pre-statement interruption resumes only recognized prior stage', async () => {
  const f = fixture('pool', 1); const before = await preflightEnterpriseMysql(f.connection, profile); const options = plan(before.sourceSha256);
  f.failWhen(sql => sql.startsWith('ALTER TABLE proxy_accounts ADD'));
  await assert.rejects(applyEnterpriseMysql(f.connection, profile, options));
  f.reconnect();
  await applyEnterpriseMysql(f.connection, profile, { ...options, resume: true });
  assert.equal(f.data.enterprise_upgrade[0].state, 'complete');
});

test('resume never repairs altered partial schema or modified preserved data', async () => {
  for (const mutate of [(f: ReturnType<typeof fixture>) => { f.schema.proxy_accounts.columns.identity = 'VARCHAR(200) COLLATE utf8mb4_bin'; },
    (f: ReturnType<typeof fixture>) => { f.data.proxy_accounts[0].copilot_oauth_token += 'bad'; }]) {
    const f = fixture('pool', 1); const source = await preflightEnterpriseMysql(f.connection, profile); const options = plan(source.sourceSha256);
    f.loseResponseWhen(sql => sql.startsWith('ALTER TABLE proxy_accounts ADD'));
    await assert.rejects(applyEnterpriseMysql(f.connection, profile, options)); f.reconnect(); mutate(f);
    const mutations = f.mutations.length;
    await assert.rejects(applyEnterpriseMysql(f.connection, profile, { ...options, resume: true }));
    assert.equal(f.mutations.length, mutations);
  }
});

test('uncertain final complete checkpoint is inspected and completed once on explicit resume', async () => {
  const f = fixture('pool', 1); const source = await preflightEnterpriseMysql(f.connection, profile); const options = plan(source.sourceSha256);
  f.failWhen(sql => sql.startsWith("UPDATE enterprise_upgrade SET checkpoint_state='after',state=") && f.data.enterprise_upgrade[0]?.step === 12);
  await assert.rejects(applyEnterpriseMysql(f.connection, profile, options));
  assert.equal(f.data.enterprise_upgrade[0].step, 12);
  assert.equal(f.data.enterprise_upgrade[0].checkpoint_state, 'unknown');
  f.reconnect();
  await applyEnterpriseMysql(f.connection, profile, { ...options, resume: true });
  await verifyEnterpriseMysqlMigration(f.connection, profile, options);
  assert.equal(f.data.enterprise_upgrade[0].state, 'complete');
});

test('checkpoint creation acknowledgment loss requires manual inspection, not a guessed resume', async () => {
  const f = fixture('pool', 1); const source = await preflightEnterpriseMysql(f.connection, profile); const options = plan(source.sourceSha256);
  f.loseResponseWhen(sql => sql.startsWith('CREATE TABLE `enterprise_upgrade`'));
  await assert.rejects(applyEnterpriseMysql(f.connection, profile, options)); f.reconnect();
  const count = f.mutations.length;
  await assert.rejects(applyEnterpriseMysql(f.connection, profile, { ...options, resume: true }), /checkpoint_missing_manual_inspection/);
  assert.equal(f.mutations.length, count);
});

test('deadline destroys stuck socket and late result cannot continue writes', async () => {
  let destroyed = 0; let resolved = false;
  const connection = { query: () => new Promise(resolve => setTimeout(() => { resolved = true; resolve([[]]); }, 35)), destroy: () => { destroyed++; } } as any;
  await assert.rejects(withEnterpriseMysqlDeadline(connection, async c => { await c.query('SELECT 1'); assert.fail('deadline continued'); }, 5), /deadline/);
  assert.equal(destroyed, 1);
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(resolved, true);
});
