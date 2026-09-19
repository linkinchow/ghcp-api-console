import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { fixture as v2Fixture, profile as legacy, plan as v2Plan, type Row } from '../default-enterprise/mysql.fixture.js';
import { applyEnterpriseMysql, preflightEnterpriseMysql } from '../default-enterprise/mysql.js';
import { parseEnterpriseRegistryV3, type EnterpriseRegistryV3 } from '../../src/packages/shared/src/enterpriseV3.js';
import { mysqlCreateTable, type MysqlConnection } from '../../src/packages/shared/src/enterpriseMysqlV1.js';
import { EnterpriseMysqlError, withEnterpriseMysqlDeadline } from '../../src/packages/shared/src/enterpriseMysql.js';
import { ENTERPRISE_MYSQL_V3_TABLES, ENTERPRISE_MYSQL_V3_FINAL_STEP, enterpriseMysqlSchemaV3, getExpectedEnterpriseMysqlV3,
  enterpriseMysqlCreateTriggerV3 } from '../../src/packages/shared/src/enterpriseMysqlSchemaV3.js';
import { initEnterpriseMysqlV3, validateEnterpriseMysqlV3, enterpriseMysqlRegistryHashV3, registerEnterpriseMysqlV3 } from '../../src/packages/shared/src/enterpriseMysqlV3.js';
import { preflightEnterpriseMysqlV3, applyEnterpriseMysqlV3, verifyEnterpriseMysqlMigrationV3, inspectEnterpriseMysqlV3,
  enterpriseMysqlStageSchemaV3, enterpriseMysqlStageTriggersV3, type EnterpriseMysqlPreflightV3 } from './mysql.js';

const second = '4f22df8a-1f0e-448a-a6d9-14fb9c5e2f64';
export function registryFixture(two = true): EnterpriseRegistryV3 {
  const profile = (id: string, isLegacy: boolean) => {
    const root = legacy.routes.ssoPublicUrl, path = isLegacy ? '' : `/profiles/${id}`;
    return { ...legacy, id, slug: isLegacy ? legacy.slug : 'second', shortcode: isLegacy ? 'team' : 'more', maxAccounts: 6,
      sso: { entityId: `${root}${path}/metadata`, ssoUrl: `${root}${path}/sso`, loginUrl: `${root}${path}/login`, logoutUrl: `${root}${path}/logout`,
        spEntityId: `https://sp.example.test/${id}`, spAcsUrl: `https://sp.example.test/${id}/acs`, scimBaseUrl: `https://api.example.test/scim/${id}`,
        githubApiBaseUrl: 'https://api.example.test', emailDomain: 'example.test', userPrefix: 'user',
        signingCertRef: { env: 'SYNTHETIC_CERT' }, signingKeyRef: { env: 'SYNTHETIC_KEY' }, sessionSecretRef: { env: 'SYNTHETIC_SESSION' } },
      login: { provider: 'custom', allowedLoginUrls: [`${root}${path}/login`], selectors: {} } };
  };
  return parseEnterpriseRegistryV3({ version: 3, registryRevision: 1, legacyEnterpriseId: legacy.id,
    profiles: [profile(legacy.id, true), ...(two ? [profile(second, false)] : [])] });
}
const registry = registryFixture();
const options = (source: EnterpriseMysqlPreflightV3) => ({ ...v2Plan(source.sourceSha256), accountIncarnations: source.accountIncarnations, layout: source.layout });

/** Synthetic SQL interpreter: v2 fixture supplies exact information_schema rows, never a network connection. */
function fixture(layout: 'direct' | 'pool' = 'pool', version: 0 | 2 | 3 = 3, input = registry, underlying?: ReturnType<typeof v2Fixture>) {
  const base = underlying ?? v2Fixture(layout, version === 3 ? 0 : version);
  const data = base.data, statements: string[] = [], mutations: string[] = [];
  let destroyed = false, fail: (sql: string) => boolean = () => false, lose: (sql: string) => boolean = () => false;
  let txn: Record<string, Row[]> | undefined;
  function replaceShape(schema: ReturnType<typeof enterpriseMysqlSchemaV3>, triggers = base.triggers as any) {
    for (const name of Object.keys(base.schema)) delete base.schema[name]; Object.assign(base.schema, structuredClone(schema));
    const copied = structuredClone(triggers);
    for (const name of Object.keys(base.triggers)) delete base.triggers[name]; Object.assign(base.triggers, copied);
  }
  if (version === 3) {
    const expected = getExpectedEnterpriseMysqlV3(layout); replaceShape(expected.schema, expected.triggers);
    for (const name of Object.keys(expected.schema)) data[name] = [];
    data.schema_migrations = ['2026-08-27-proxy-mysql-initial', '2026-08-27-proxy-token-binary-collation', ...(layout === 'pool' ? ['2026-09-12-user-pool-mysql-v1'] : [])]
      .map(id => ({ id, applied_at: '2026-09-18 00:00:00.000' }));
    data.enterprise_profiles = input.profiles.map(p => ({ id: p.id, slug: p.slug, revision: p.revision, profile_json: JSON.stringify(p), max_accounts: p.maxAccounts }));
    data.enterprise_registry = [{ singleton: 1, legacy_enterprise_id: input.legacyEnterpriseId, registry_revision: input.registryRevision, registry_sha256: enterpriseMysqlRegistryHashV3(input) }];
    data.enterprise_schema = [{ singleton: 1, component: 'proxy', schema_version: 3, contract_version: 2, capability: 'enterprise-isolation-legacy-pool',
      layout, registry_sha256: enterpriseMysqlRegistryHashV3(input), migration_id: 'enterprise-schema3-contract2', state: 'complete' }];
    if (layout === 'pool') data.user_pool_settings = [{ id: 1, version: 1, idle_target: 2, lease_seconds: 172800, paused: 1, next_ordinal: 0,
      account_domain: legacy.accountDomain, config_fingerprint: 'a'.repeat(64), owner: null, owner_until: 0 }];
  }
  async function execute(sql: string, values: any[]): Promise<any> {
    if (sql.startsWith('SET SESSION') || sql.includes('GET_LOCK') || sql.includes('RELEASE_LOCK') || sql.startsWith('SELECT DATABASE()')) return base.connection.query(sql, values);
    if (sql.includes('SELECT c.CHECK_CLAUSE,t.CONSTRAINT_NAME')) return [[{ CHECK_CLAUSE: 'singleton = 1', CONSTRAINT_NAME: 'enterprise_profiles_chk_1' }]];
    if (sql.includes('information_schema')) return base.connection.query(sql, values);
    if (sql.startsWith('SELECT HEX')) return base.connection.query(sql, values);
    if (sql.startsWith('SELECT COUNT(*)')) {
      const table = sql.match(/FROM (\w+)/)![1];
      if (sql.includes("WHERE state='provisioning'")) return [[{ n: data[table].filter(row => row.state === 'provisioning').length }]];
      if (sql.includes('WHERE status=')) return [[{ n: data[table].filter(row => row.status === 'active').length }]];
      if (sql.includes('LEFT JOIN')) {
        if (sql.includes('BINARY a.enterprise_id <>')) return [[{ n: data.user_pool_accounts.filter(row => {
          const account = data.proxy_accounts.find(a => a.identity === row.identity); return !account || account.enterprise_id !== values[0] || row.state === 'provisioning';
        }).length }]];
        const match = sql.match(/FROM (\w+) a LEFT JOIN (\w+) b ON a\.(\w+)=b\.(\w+)/);
        if (match) return [[{ n: data[match[1]].filter(a => !data[match[2]].some(b => a[match[3]] === b[match[4]])).length }]];
      }
      if (sql.includes('copilot_oauth_attempt_id IS NOT NULL')) return [[{ n: data.proxy_accounts.filter(row => row.copilot_oauth_attempt_id != null || !['valid', 'expired', 'missing', 'failed'].includes(row.copilot_oauth_status)).length }]];
      if (sql.includes('enterprise_id IS NULL OR')) return [[{ n: data.proxy_accounts.filter(row => row.enterprise_id == null || row.enterprise_id !== values[0]).length }]];
      assert(!sql.includes('WHERE'), `Unsupported count filter ${sql}`);
      return [[{ n: data[table].length }]];
    }
    if (sql.includes('AS server_now')) return [data.user_pool_settings.map(row => ({ ...row, server_now: Date.now() }))];
    if (sql.startsWith('SELECT ')) {
      const match = sql.match(/^SELECT (.+) FROM (\w+)/)!; assert(match, sql);
      let rows = structuredClone(data[match[2]]); assert(rows, sql);
      if (sql.includes('WHERE id=?')) rows = rows.filter(row => row.id === values[0]);
      if (sql.includes('ORDER BY BINARY')) { const column = sql.match(/ORDER BY BINARY (\w+)/)![1]; rows.sort((a, b) => Buffer.compare(Buffer.from(a[column]), Buffer.from(b[column]))); }
      if (match[1] !== '*') rows = rows.map(row => Object.fromEntries(match[1].split(',').map(column => [column, row[column]])));
      return [rows];
    }
    if (sql === 'START TRANSACTION') { txn = structuredClone(data); return [{}]; }
    if (sql === 'COMMIT') { txn = undefined; return [{}]; }
    if (sql === 'ROLLBACK') { if (txn) { for (const name of Object.keys(data)) delete data[name]; Object.assign(data, txn); txn = undefined; } return [{}]; }
    if (sql.startsWith('CREATE TABLE')) {
      const name = sql.match(/CREATE TABLE `([^`]+)`/)![1];
      const schema = enterpriseMysqlSchemaV3(layout);
      assert.equal(sql, mysqlCreateTable(name, schema)); assert(!base.schema[name]);
      base.schema[name] = structuredClone(schema[name]); data[name] = [];
    } else if (sql.startsWith('DROP TABLE')) {
      assert.equal(sql, 'DROP TABLE enterprise_schema'); delete base.schema.enterprise_schema; delete data.enterprise_schema;
    } else if (sql.startsWith('DROP TRIGGER')) { delete base.triggers[sql.match(/DROP TRIGGER (\w+)/)![1]]; }
    else if (sql.startsWith('CREATE TRIGGER')) {
      const name = sql.match(/CREATE TRIGGER (\w+)/)![1], trigger = getExpectedEnterpriseMysqlV3(layout).triggers[name];
      assert.equal(sql, enterpriseMysqlCreateTriggerV3(name, trigger)); (base.triggers as any)[name] = structuredClone(trigger);
    } else if (sql.startsWith('ALTER TABLE')) {
      const step = Number(data.enterprise_upgrade_v3[0].step);
      const schema = enterpriseMysqlStageSchemaV3(layout, step), table = sql.match(/ALTER TABLE (\w+)/)![1];
      base.schema[table] = structuredClone(schema[table]);
      if (step === 5) for (const row of data.enterprise_profiles) delete row.singleton;
      if (step === 11) for (const row of data.proxy_accounts) row.account_incarnation = null;
    } else if (sql.startsWith('INSERT INTO enterprise_upgrade_v3')) {
      data.enterprise_upgrade_v3.push({ singleton: 1, migration_id: values[0], database_name: values[1], manifest_sha256: values[2], backup_reference: values[3], backup_sha256: values[4],
        registry_sha256: values[5], source_sha256: values[6], mapping_sha256: values[7], layout: values[8], state: 'applying', step: 0, checkpoint_state: 'after', evidence_json: values[9], mapping_json: values[10] });
    } else if (sql.startsWith('INSERT INTO enterprise_profiles')) data.enterprise_profiles.push(Object.fromEntries(['id', 'slug', 'revision', 'profile_json', 'max_accounts'].map((key, i) => [key, values[i]])));
    else if (sql.startsWith('INSERT INTO enterprise_registry')) data.enterprise_registry.push({ singleton: 1, legacy_enterprise_id: values[0], registry_revision: values[1], registry_sha256: values[2] });
    else if (sql.startsWith('INSERT INTO enterprise_schema')) data.enterprise_schema.push({ singleton: 1, component: 'proxy', schema_version: 3, contract_version: 2, capability: 'enterprise-isolation-legacy-pool', layout: values[0], registry_sha256: values[1], migration_id: values[2], state: 'complete' });
    else if (sql.startsWith('INSERT INTO schema_migrations')) data.schema_migrations.push({ id: values[0], applied_at: '2026-09-18 00:00:00.000' });
    else if (sql.startsWith('INSERT INTO user_pool_settings')) data.user_pool_settings.push(Object.fromEntries(['id', 'version', 'idle_target', 'lease_seconds', 'paused', 'next_ordinal', 'account_domain', 'config_fingerprint', 'owner', 'owner_until'].map((key, i) => [key, [1, ...values][i]])));
    else if (sql.startsWith('UPDATE enterprise_profiles SET profile_json=')) { data.enterprise_profiles[0].profile_json = values[0]; data.enterprise_profiles[0].max_accounts ??= values[1]; }
    else if (sql.startsWith('UPDATE proxy_accounts SET account_incarnation=')) {
      const row = data.proxy_accounts.find(a => a.identity === values[1] && a.account_incarnation === null); if (!row) return [{ affectedRows: 0 }]; row.account_incarnation = values[0];
    } else if (sql.startsWith('UPDATE enterprise_upgrade_v3 SET step=')) { data.enterprise_upgrade_v3[0].step = values[0]; data.enterprise_upgrade_v3[0].checkpoint_state = 'before'; }
    else if (sql.startsWith("UPDATE enterprise_upgrade_v3 SET checkpoint_state='unknown'")) data.enterprise_upgrade_v3[0].checkpoint_state = 'unknown';
    else if (sql.startsWith("UPDATE enterprise_upgrade_v3 SET checkpoint_state='after'")) { data.enterprise_upgrade_v3[0].checkpoint_state = 'after'; data.enterprise_upgrade_v3[0].state = values[0]; }
    else if (sql.startsWith('UPDATE enterprise_registry SET')) {
      const row = data.enterprise_registry[0]; if (row.registry_revision !== values[2] || row.registry_sha256 !== values[3]) return [{ affectedRows: 0 }];
      row.registry_revision = values[0]; row.registry_sha256 = values[1];
    } else if (sql.startsWith('UPDATE enterprise_schema SET')) {
      const row = data.enterprise_schema[0]; if (row.registry_sha256 !== values[1]) return [{ affectedRows: 0 }]; row.registry_sha256 = values[0];
    } else assert.fail(`Unhandled statement ${sql}`);
    return [{ affectedRows: 1 }];
  }
  const connection = { async query(sql: string, values: any[] = []) {
    statements.push(sql); if (destroyed) throw new Error('closed'); if (fail(sql)) throw new Error('synthetic credential in driver failure');
    if (!sql.startsWith('SELECT') && !sql.startsWith('SET SESSION')) mutations.push(sql);
    const result = await execute(sql, values); if (lose(sql)) throw new Error('lost response'); return result;
  }, destroy() { destroyed = true; } } as unknown as MysqlConnection;
  return { connection, data, statements, mutations, base, get destroyed() { return destroyed; },
    failWhen(fn: typeof fail) { fail = fn; }, loseWhen(fn: typeof lose) { lose = fn; }, reconnect() { destroyed = false; fail = () => false; lose = () => false; base.reconnect(); } };
}

for (const layout of ['direct', 'pool'] as const) {
  test(`schema3 ${layout} gate is SELECT-only and DB cap is authoritative`, async () => {
    const f = fixture(layout); f.data.enterprise_profiles[0].max_accounts = 9;
    const expected = structuredClone(registry); expected.profiles[0].maxAccounts = 7;
    const result = await validateEnterpriseMysqlV3(f.connection, 'proxy', expected);
    assert.equal(result.registry.profiles[0].maxAccounts, 6); assert.equal(result.maxAccounts, layout === 'pool' ? 9 : undefined);
    assert.equal(result.legacyEnterpriseId, legacy.id); assert(f.statements.every(sql => sql.startsWith('SELECT')));
  });
  test(`offline empty init ${layout} establishes gate, never copies accounts`, async () => {
    const f = fixture(layout, 0);
    await initEnterpriseMysqlV3(f.connection, 'proxy', registry, layout === 'direct' ? {} : { pool: { fingerprint: 'a'.repeat(64), settings: {
      version: 1, idle_target: 2, lease_seconds: 172800, paused: 1, next_ordinal: 0, account_domain: legacy.accountDomain, owner: null, owner_until: 0,
    } } });
    assert.equal(f.data.proxy_accounts.length, 0); assert.equal(f.data.enterprise_upgrade.length, 0); assert.equal(f.data.enterprise_upgrade_v3.length, 0);
    assert.equal((await validateEnterpriseMysqlV3(f.connection, 'proxy', registry)).layout, layout);
    await assert.rejects(initEnterpriseMysqlV3(f.connection, 'proxy', registry), /init_requires_empty/);
  });
  test(`v2 to v3 ${layout}: full column evidence, UUID mapping, history, lease/generation preserved`, async () => {
    // First exercise the old 12-step tool so its actual receipt becomes immutable input to v3.
    const old = v2Fixture(layout, 1);
    if (layout === 'pool') {
      old.data.user_pool_settings[0].next_ordinal = 1;
      old.data.user_pool_accounts.push({ identity: 'alice', ordinal: 0, state: 'ready', stage: 'ready', attempt_id: randomUUID(), oauth_attempt_id: randomUUID(),
        sso_created_at: '2026-09-17T00:00:00.000Z', task_id: 'completed-synthetic', attempts: 2, retry_at: 0, last_error: null,
        updated_at: 1700000000000, cooldown_until: 0, verified_at: 1700000000000, generation: '9007199254740993', reauth_count: 1, reauth_window_at: 1699999999999 });
      old.data.user_pool_leases.push({ caller_id: `sha256:${'c'.repeat(64)}`, member_identity: 'alice', lease_id: randomUUID(), phase: 'active',
        assigned_at: 1700000000000, last_success_at: 1700000000123, expires_at: 9999999999999 });
      old.data.user_pool_events.push({ id: 10, at: 1700000000000, action: 'synthetic-ready', identity: 'alice', caller_id: null, lease_id: null, detail: 'preserved' });
    }
    const sourceOld = await preflightEnterpriseMysql(old.connection, legacy);
    await applyEnterpriseMysql(old.connection, legacy, v2Plan(sourceOld.sourceSha256));
    const f = fixture(layout, 2, registry, old), preserved = structuredClone(f.data);
    const before = await preflightEnterpriseMysqlV3(f.connection, registry, layout);
    assert(f.statements.every(sql => sql.startsWith('SELECT'))); assert.equal((await inspectEnterpriseMysqlV3(f.connection, registry)).state, 'v2');
    const plan = options(before); const result = await applyEnterpriseMysqlV3(f.connection, registry, plan);
    assert.equal(result.resumed, false); assert.equal(f.data.enterprise_upgrade_v3[0].step, ENTERPRISE_MYSQL_V3_FINAL_STEP);
    assert.deepEqual(f.data.enterprise_upgrade, preserved.enterprise_upgrade); assert.deepEqual(f.data.schema_migrations, preserved.schema_migrations);
    assert.deepEqual(f.data.proxy_accounts.map(({ account_incarnation: _, ...row }) => row), preserved.proxy_accounts);
    assert.equal(f.data.proxy_accounts[0].account_incarnation, plan.accountIncarnations[0].accountIncarnation);
    for (const name of Object.keys(preserved).filter(n => n.startsWith('user_pool_'))) assert.deepEqual(f.data[name], preserved[name]);
    assert.equal((await inspectEnterpriseMysqlV3(f.connection, registry)).state, 'v3');
    await verifyEnterpriseMysqlMigrationV3(f.connection, registry, plan);
    const count = f.mutations.length; assert.equal((await applyEnterpriseMysqlV3(f.connection, registry, { ...plan, resume: true })).resumed, true); assert.equal(f.mutations.length, count);
    f.data.proxy_accounts[0].copilot_oauth_token += 'changed';
    await assert.rejects(verifyEnterpriseMysqlMigrationV3(f.connection, registry, plan), /source_changed/);
  });
}
const alterations: Array<[string, string, string, (rows: Row[]) => Row[]]> = [
  ['unknown view', 'tables', '', rows => [...rows, { TABLE_NAME: 'unexpected', TABLE_TYPE: 'VIEW' }]],
  ['nullable incarnation', 'columns', 'proxy_accounts', rows => rows.map(row => row.COLUMN_NAME === 'account_incarnation' ? { ...row, IS_NULLABLE: 'YES' } : row)],
  ['wrong profile PK', 'indexes', 'enterprise_profiles', rows => rows.map(row => row.INDEX_NAME === 'PRIMARY' ? { ...row, COLUMN_NAME: 'slug' } : row)],
  ['wrong identity collation', 'columns', 'enterprise_profiles', rows => rows.map(row => row.COLUMN_NAME === 'id' ? { ...row, COLLATION_NAME: 'ascii_general_ci' } : row)],
  ['generated registry', 'columns', 'enterprise_registry', rows => rows.map(row => ({ ...row, GENERATION_EXPRESSION: '1' }))],
  ['widened statuses', 'checks', 'proxy_authorization_attempts', rows => rows.map(row => ({ ...row, CHECK_CLAUSE: row.CHECK_CLAUSE.replace("'active'", "'active','unknown'") }))],
  ['unenforced checks', 'checks', 'enterprise_profiles', rows => rows.map(row => ({ ...row, ENFORCED: 'NO' }))],
  ['prefix index', 'indexes', 'proxy_authorization_attempts', rows => rows.map(row => ({ ...row, SUB_PART: 4 }))],
  ['cross-database FK', 'foreign', 'proxy_identity_initializations', rows => rows.map(row => ({ ...row, local_reference: 0 }))],
  ['cascade enterprise', 'foreign', 'proxy_accounts', rows => rows.map(row => ({ ...row, UPDATE_RULE: 'CASCADE' }))],
  ['missing legacy insert guard', 'triggers', '', rows => rows.filter(row => row.TRIGGER_NAME !== 'enterprise_pool_legacy_insert')],
  ['ledger deletable', 'triggers', '', rows => rows.filter(row => row.TRIGGER_NAME !== 'enterprise_authorization_no_delete')],
  ['changed generation fence', 'triggers', '', rows => rows.map(row => row.TRIGGER_NAME === 'user_pool_credential_fence' ? { ...row, ACTION_STATEMENT: row.ACTION_STATEMENT.replace('generation + 1', 'generation + 0') } : row)],
];
for (const [name, kind, table, change] of alterations) test(`strict v3 metadata rejects ${name} without writes`, async () => {
  const f = fixture(); f.base.alterMetadata((k, t, rows) => k === kind && t === table ? change(rows) : rows);
  await assert.rejects(validateEnterpriseMysqlV3(f.connection, 'proxy', registry), EnterpriseMysqlError); assert.equal(f.mutations.length, 0);
});

test('frozen v3 constraints forbid account FK on ledger and preserve v2 pool foreign/fence definitions', () => {
  const { schema, triggers } = getExpectedEnterpriseMysqlV3('pool');
  assert(schema.proxy_authorization_attempts.foreign!.every(foreign => foreign[1] !== 'proxy_accounts'));
  assert.match(triggers.enterprise_authorization_immutable.body, /expected_github_user_id/);
  assert.match(triggers.enterprise_account_immutable.body, /account_incarnation/);
  assert.match(triggers.enterprise_registry_immutable.body, /legacy_enterprise_id/);
  assert(!triggers.enterprise_profile_immutable.body.includes('max_accounts'));
  assert.deepEqual(schema.user_pool_accounts.foreign, [['identity', 'proxy_accounts', 'identity', 'RESTRICT']]);
  assert.deepEqual(schema.enterprise_upgrade, v2Fixture().schema.enterprise_upgrade);
  assert.equal(Object.hasOwn(schema.proxy_authorization_attempts.columns, 'result_token_hash'), false);
  assert.equal(Object.hasOwn(schema.proxy_authorization_attempts.columns, 'token'), false);
});

test('empty, schema2, future, partial, bad config and nonlegacy pool inventory are rejected read-only', async () => {
  for (const version of [0, 2] as const) { const f = fixture('pool', version); await assert.rejects(validateEnterpriseMysqlV3(f.connection, 'proxy', registry)); assert.equal(f.mutations.length, 0); }
  for (const mutate of [(f: ReturnType<typeof fixture>) => { f.data.enterprise_schema[0].schema_version = 4; },
    (f: ReturnType<typeof fixture>) => { f.data.enterprise_registry[0].legacy_enterprise_id = second; },
    (f: ReturnType<typeof fixture>) => { f.data.enterprise_profiles[0].max_accounts = null; },
    (f: ReturnType<typeof fixture>) => { f.data.proxy_accounts.push({ identity: 'foreign', enterprise_id: second, account_incarnation: randomUUID() }); f.data.user_pool_accounts.push({ identity: 'foreign' }); },
    (f: ReturnType<typeof fixture>) => { f.data.proxy_accounts.push({ identity: 'bad', enterprise_id: legacy.id, account_incarnation: 'not-uuid' }); }]) {
    const f = fixture(); mutate(f); await assert.rejects(validateEnterpriseMysqlV3(f.connection, 'proxy', registry)); assert.equal(f.mutations.length, 0);
  }
});

test('offline registration uses registry CAS and only inserts new refs/profile, preserving cap and all business rows', async () => {
  const previous = registryFixture(false), next = { ...registry, registryRevision: 2 }, f = fixture('pool', 3, previous);
  f.data.enterprise_profiles[0].max_accounts = 9;
  const oldProfile = structuredClone(f.data.enterprise_profiles[0]), oldBusiness = structuredClone(f.data.proxy_accounts);
  const result = await registerEnterpriseMysqlV3(f.connection, previous, next, { confirmOffline: true, confirmDrained: true, expectedRegistryRevision: 1 });
  assert.equal(result.registry.registryRevision, 2); assert.equal(result.maxAccounts, 9);
  assert.deepEqual(f.data.enterprise_profiles[0], oldProfile); assert.deepEqual(f.data.proxy_accounts, oldBusiness);
  assert(f.mutations.every(sql => /^(START TRANSACTION|COMMIT|INSERT INTO enterprise_profiles|UPDATE enterprise_registry|UPDATE enterprise_schema)/.test(sql)));
  assert(f.statements.some(sql => sql.includes('FOR UPDATE')));
  const count = f.mutations.length;
  await assert.rejects(registerEnterpriseMysqlV3(f.connection, previous, next, { confirmOffline: true, confirmDrained: true, expectedRegistryRevision: 1 }), /registry_mismatch/);
  assert.equal(f.mutations.length, count);
});

test('v3 gate rejects mutable cap overflow, invalid pool settings and incomplete token evidence',async()=>{
  for(const mutate of [
    (f:ReturnType<typeof fixture>)=>{f.data.enterprise_profiles[0].max_accounts=10000;},
    (f:ReturnType<typeof fixture>)=>{f.data.user_pool_settings[0].idle_target=1000;},
    (f:ReturnType<typeof fixture>)=>{f.data.proxy_authorization_attempts.push({oauth_attempt_id:randomUUID(),enterprise_id:legacy.id,enterprise_revision:1,
      identity:'account',account_incarnation:randomUUID(),expected_gh_login:'test_emu',status:'succeeded',result_fingerprint:null,result_gh_login:'test_emu'});},
  ]) {const f=fixture();mutate(f);await assert.rejects(validateEnterpriseMysqlV3(f.connection,'proxy',registry));assert.equal(f.mutations.length,0);}
  assert.match(getExpectedEnterpriseMysqlV3('pool').triggers.enterprise_authorization_immutable.body,/authorization_attempt_terminal/);
});

test('registration rejects config mutation, missing maintenance and active ledger before writes', async () => {
  const previous = registryFixture(false), next = { ...registry, registryRevision: 2 };
  const altered = structuredClone(next); altered.profiles[0].revision++;
  const f = fixture('pool', 3, previous);
  await assert.rejects(registerEnterpriseMysqlV3(f.connection, previous, altered, { confirmOffline: true, confirmDrained: true, expectedRegistryRevision: 1 }), /add_only/);
  await assert.rejects(registerEnterpriseMysqlV3(f.connection, previous, next, { confirmOffline: false, confirmDrained: true, expectedRegistryRevision: 1 }), /maintenance/);
  f.data.proxy_authorization_attempts.push({ oauth_attempt_id:randomUUID(),enterprise_id:legacy.id,enterprise_revision:1,
    identity:'account',account_incarnation:randomUUID(),expected_gh_login:'test_emu',expected_github_user_id:null,status:'active',
    result_fingerprint:null,result_gh_login:null,result_github_user_id:null,failure_reason:null,created_at:'2026-09-18 00:00:00.000',updated_at:'2026-09-18 00:00:00.000' });
  await assert.rejects(registerEnterpriseMysqlV3(f.connection, previous, next, { confirmOffline: true, confirmDrained: true, expectedRegistryRevision: 1 }), /not_drained/);
  assert.equal(f.mutations.length, 0);
});

for (const interrupted of ['DROP TRIGGER enterprise_profile_immutable', 'ALTER TABLE enterprise_profiles DROP PRIMARY', 'UPDATE enterprise_profiles SET profile_json',
  'CREATE TABLE `enterprise_registry`', 'INSERT INTO enterprise_registry', 'ALTER TABLE proxy_accounts ADD COLUMN account_incarnation',
  'UPDATE proxy_accounts SET account_incarnation', 'ALTER TABLE proxy_identity_initializations', 'CREATE TABLE `proxy_authorization_attempts`',
  'DROP TABLE enterprise_schema', 'INSERT INTO enterprise_schema', 'CREATE TRIGGER enterprise_pool_legacy_update']) {
  test(`unknown acknowledgment never guesses resume: ${interrupted}`, async () => {
    const f = fixture('pool', 2), before = await preflightEnterpriseMysqlV3(f.connection, registry), plan = options(before);
    f.loseWhen(sql => sql.startsWith(interrupted));
    await assert.rejects(applyEnterpriseMysqlV3(f.connection, registry, plan), /statement_outcome_unknown/);
    assert.equal(f.destroyed, true); assert.equal(f.data.enterprise_upgrade_v3[0].checkpoint_state, 'unknown');
    f.reconnect(); assert.equal((await inspectEnterpriseMysqlV3(f.connection, registry)).state, 'partial');
    const writes = f.mutations.length;
    await assert.rejects(applyEnterpriseMysqlV3(f.connection, registry, { ...plan, resume: true }), /unknown_manual_inspection/);
    assert.equal(f.mutations.length, writes);
  });
}

test('known before and after checkpoints resume exact stage without reallocating incarnation', async () => {
  for (const kind of ['before', 'after'] as const) {
    const f = fixture('direct', 2), before = await preflightEnterpriseMysqlV3(f.connection, registry), plan = options(before);
    if (kind === 'before') f.failWhen(sql => sql.includes("SET checkpoint_state='unknown'") && f.data.enterprise_upgrade_v3[0].step === 12);
    else f.failWhen(sql => sql.includes("SET step=?,checkpoint_state='before'") && f.data.enterprise_upgrade_v3[0].step === 12);
    await assert.rejects(applyEnterpriseMysqlV3(f.connection, registry, plan)); f.reconnect();
    assert.equal(f.data.enterprise_upgrade_v3[0].checkpoint_state, kind);
    await applyEnterpriseMysqlV3(f.connection, registry, { ...plan, resume: true });
    assert.equal(f.data.proxy_accounts[0].account_incarnation, plan.accountIncarnations[0].accountIncarnation);
    assert.equal(f.mutations.filter(sql => sql.startsWith('UPDATE proxy_accounts SET account_incarnation')).length, 1);
  }
});

test('missing receipt, wrong mapping, changed preserved bytes and stale source all stop without further DDL', async () => {
  const f = fixture('direct', 2), before = await preflightEnterpriseMysqlV3(f.connection, registry), plan = options(before);
  f.loseWhen(sql => sql.startsWith('CREATE TABLE `enterprise_upgrade_v3`'));
  await assert.rejects(applyEnterpriseMysqlV3(f.connection, registry, plan)); f.reconnect();
  const count = f.mutations.length; await assert.rejects(applyEnterpriseMysqlV3(f.connection, registry, { ...plan, resume: true }), /checkpoint_missing_manual/); assert.equal(f.mutations.length, count);
  const g = fixture('pool', 2), source = await preflightEnterpriseMysqlV3(g.connection, registry), opts = options(source);
  g.failWhen(sql => sql.includes("SET step=?,checkpoint_state='before'") && g.data.enterprise_upgrade_v3[0].step === 12);
  await assert.rejects(applyEnterpriseMysqlV3(g.connection, registry, opts)); g.reconnect();
  const writes = g.mutations.length;
  await assert.rejects(applyEnterpriseMysqlV3(g.connection, registry, { ...opts, resume: true, accountIncarnations: [{ ...opts.accountIncarnations[0], accountIncarnation: randomUUID() }] }), /checkpoint_binding/);
  g.data.proxy_accounts[0].copilot_oauth_token += 'bad';
  await assert.rejects(applyEnterpriseMysqlV3(g.connection, registry, { ...opts, resume: true }), /source_changed/); assert.equal(g.mutations.length, writes);
  const h = fixture('pool', 2), first = await preflightEnterpriseMysqlV3(h.connection, registry); h.data.proxy_accounts[0].updated_at += 'changed';
  await assert.rejects(applyEnterpriseMysqlV3(h.connection, registry, options(first)), /source_changed/); assert.equal(h.mutations.length, 0);
});

test('preflight refuses live claims, holds, OAuth attempts, and unpaused pool without writes', async () => {
  for (const mutate of [(f: ReturnType<typeof fixture>) => f.data.proxy_identity_initializations.push({ identity: 'busy' }),
    (f: ReturnType<typeof fixture>) => f.data.user_pool_holds.push({ request_id: 'expired-but-undrained' }),
    (f: ReturnType<typeof fixture>) => { f.data.proxy_accounts[0].copilot_oauth_attempt_id = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.data.user_pool_settings[0].paused = 0; }]) {
    const f = fixture('pool', 2); mutate(f); await assert.rejects(preflightEnterpriseMysqlV3(f.connection, registry)); assert.equal(f.mutations.length, 0);
  }
});

test('deadline destroys socket and sanitized failure cannot leak SQL driver credentials', async () => {
  let destroyed = 0;
  const stuck = { query: () => new Promise(resolve => setTimeout(() => resolve([[]]), 35)), destroy() { destroyed++; } } as any;
  await assert.rejects(withEnterpriseMysqlDeadline(stuck, c => validateEnterpriseMysqlV3(c, 'proxy', registry), 5), /deadline/); assert.equal(destroyed, 1);
  const f = fixture(); f.failWhen(() => true);
  await assert.rejects(validateEnterpriseMysqlV3(f.connection, 'proxy', registry), error => error instanceof EnterpriseMysqlError && !error.message.includes('synthetic credential'));
});

test('v3 stage generation never mutates frozen v2 schema definitions', () => {
  const original = structuredClone(v2Fixture().schema);
  for (let step = 0; step <= ENTERPRISE_MYSQL_V3_FINAL_STEP; step++) enterpriseMysqlStageSchemaV3('pool', step);
  assert.deepEqual(v2Fixture().schema, original);
});

test('registration after migration accepts the historical registry digest without rewriting its checkpoint', async () => {
  const previous = registryFixture(false), next = { ...registry, registryRevision: 2 }, f = fixture('pool', 2);
  const before = await preflightEnterpriseMysqlV3(f.connection, previous);
  await applyEnterpriseMysqlV3(f.connection, previous, options(before));
  const checkpoint = structuredClone(f.data.enterprise_upgrade_v3);
  await registerEnterpriseMysqlV3(f.connection, previous, next, { confirmOffline: true, confirmDrained: true, expectedRegistryRevision: 1 });
  assert.deepEqual(f.data.enterprise_upgrade_v3, checkpoint);
  assert.equal((await validateEnterpriseMysqlV3(f.connection, 'proxy', next)).registry.profiles.length, 2);
  const row = f.data.enterprise_upgrade_v3[0], evidence = JSON.parse(row.evidence_json);
  delete evidence.columns.proxy_accounts.copilot_oauth_token;
  row.evidence_json = JSON.stringify(evidence); row.source_sha256 = createHash('sha256').update(row.evidence_json).digest('hex');
  await assert.rejects(validateEnterpriseMysqlV3(f.connection, 'proxy', next), /checkpoint/);
});

test('migration code never writes the old receipt/history, disables FK checks, creates server resources or reads environment', () => {
  const code = readFileSync(new URL('./mysql.ts', import.meta.url), 'utf8');
  assert(!/process\.env|dotenv|createConnection|CREATE DATABASE|foreign_key_checks\s*=\s*0/i.test(code));
  assert(!/(?:INSERT INTO|UPDATE|DROP TABLE) enterprise_upgrade(?:\s|\()/i.test(code));
  assert(!/(?:INSERT INTO|UPDATE|DROP TABLE) schema_migrations/i.test(code));
  assert(!code.includes('ALTER TABLE user_pool_'));
});
