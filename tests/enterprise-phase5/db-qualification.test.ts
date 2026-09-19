import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { args, SCHEMAS, safeError, sha256, validateDbGate, type State } from './db-gate.js';
import { interceptConnection } from './migration-faults.js';
import { historicalPoolConfig, legacySeedPoolConfig, legacySource, seedLegacySqlite } from './db-fixtures.js';
import { scryptSync } from 'node:crypto';
import { snapshotSqlite } from './db-snapshot.js';
import { SUITES } from './db-run.js';
import { APPLICATION_PRIVILEGES, applicationGrant } from './db-prepare.js';

function gate() {
  const runId = '20260919a', project = `ghcp-enterprise-phase5-${runId}`, id = 'a'.repeat(64);
  const state = { fixtureVersion: 1, syntheticOnly: true, mode: 'init', runId, project, root: `/opt/ghcp-test/phase5-${runId}`,
    database: { hostAddress: '127.0.0.1', hostPort: 33195, restoreHostPort: 33196, name: SCHEMAS[0], username: 'phase5',
      password: 'synthetic-password-'.repeat(2), rootPassword: 'synthetic-root-'.repeat(2), schemas: [...SCHEMAS] },
    ownership: { containers: { mysql: { id, name: `${project}-mysql-1` } } } } as unknown as State;
  const inspect = { Id: id, Name: `/${project}-mysql-1`, Config: { Labels: { 'com.docker.compose.project': project,
    'com.docker.compose.service': 'mysql', 'io.ghcp.phase5.run-id': runId, 'io.ghcp.phase5.synthetic': 'true' } },
    State: { Running: true }, NetworkSettings: { Ports: { '3306/tcp': [{ HostIp: '127.0.0.1', HostPort: '33195' }] } } };
  const env = { PHASE5_SYNTHETIC_ONLY: '1', PHASE5_DB_ALLOW_DDL: '1' }; return { state, inspect, env };
}
test('DB gate rejects absent opt-in, stale/wrong ownership, nonloopback and unowned schemas before driver import', () => {
  const base = gate(); assert.doesNotThrow(() => validateDbGate(base.state, base.inspect, base.env));
  for (const mutate of [
    (f: ReturnType<typeof gate>) => { delete (f.env as any).PHASE5_DB_ALLOW_DDL; },
    (f: ReturnType<typeof gate>) => { f.state.syntheticOnly = false; },
    (f: ReturnType<typeof gate>) => { f.state.root += '/other'; },
    (f: ReturnType<typeof gate>) => { f.inspect.Id = 'b'.repeat(64); },
    (f: ReturnType<typeof gate>) => { f.inspect.Config.Labels['io.ghcp.phase5.run-id'] = 'other'; },
    (f: ReturnType<typeof gate>) => { f.inspect.Config.Labels['com.docker.compose.project'] = 'old-project'; },
    (f: ReturnType<typeof gate>) => { f.inspect.NetworkSettings.Ports['3306/tcp'][0].HostIp = '0.0.0.0'; },
    (f: ReturnType<typeof gate>) => { f.inspect.State.Running = false; },
    (f: ReturnType<typeof gate>) => { f.state.database.schemas[0] = 'customer'; },
  ]) { const f = gate(); mutate(f); assert.throws(() => validateDbGate(f.state, f.inspect, f.env), /^Error: phase5_/); }
  assert.throws(() => validateDbGate(base.state, base.inspect, base.env, 'mysql-restore'), /ownership/);
  const migration = gate(); migration.state.mode = 'migration';
  assert.throws(() => validateDbGate(migration.state, migration.inspect, migration.env), /credentials_required/);
  migration.state.database.name = 'ghcp_enterprise_test_phase5_chain';
  assert.doesNotThrow(() => validateDbGate(migration.state, migration.inspect, migration.env));
  migration.state.mode = 'init'; assert.throws(() => validateDbGate(migration.state, migration.inspect, migration.env), /credentials_required/);
});
test('application grant includes explicit trigger DDL capability on one owned schema only', () => {
  assert.deepEqual(APPLICATION_PRIVILEGES, ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRIGGER']);
  for (const schema of ['ghcp_enterprise_test_phase5_app', 'ghcp_enterprise_test_phase5_chain']) {
    assert.equal(applicationGrant(schema), `GRANT SELECT,INSERT,UPDATE,DELETE,TRIGGER ON \`${schema}\`.* TO ?@?`);
    assert.doesNotMatch(applicationGrant(schema), /(?:ALL|SUPER|GRANT OPTION|\*\.\*)/);
  }
  for (const schema of ['customer', '*', 'mysql', 'ghcp_enterprise_test_phase5_chain`; GRANT ALL ON *.*']) assert.throws(() => applicationGrant(schema), /schema_not_owned/);
});
test('real suite allowlist cannot invoke root tests or destructive existing-target migration suites', () => {
  const files = Object.values(SUITES).flat();
  assert.equal(new Set(files).size, files.length);
  assert.ok(files.every(file => file.endsWith('.integration.test.ts') && !file.includes('*') && !file.includes('sqlite-to-mysql')));
  assert.ok(files.includes('src/proxy/src/db/mysqlStorage.integration.test.ts'));
});
test('qualification argument parser and diagnostics never echo arbitrary secrets', () => {
  assert.deepEqual(args(['--stage', 'seed']), { stage: 'seed' });
  for (const value of [['--stage'], ['--stage', 'seed', '--stage', 'v2'], ['plain', 'secret']]) assert.throws(() => args(value));
  assert.equal(safeError(new Error('mysql://root:private@real-db')), 'phase5_operation_failed_details_suppressed');
  assert.equal(safeError(new Error('enterprise_mysql_unknown_manual_inspection_required')), 'enterprise_mysql_unknown_manual_inspection_required');
});
test('fault interception distinguishes before dispatch and actual server-result ACK loss, never rewrites SQL', async () => {
  const statements: string[] = []; let destroyed = 0;
  const fake = { async query(sql: string) { statements.push(sql); return [{ affectedRows: 1 }]; }, destroy() { destroyed++; } } as any;
  const before = interceptConnection(fake, sql => sql === 'DDL', false);
  await assert.rejects(before.connection.query('DDL'), /before_dispatch/); assert.deepEqual(statements, []); assert.equal(destroyed, 0);
  const after = interceptConnection(fake, sql => sql === 'COMMIT', true);
  await assert.rejects(after.connection.query('COMMIT'), /ack_loss/); assert.deepEqual(statements, ['COMMIT']); assert.equal(destroyed, 1);
  assert.equal(before.hit(), true); assert.equal(after.hit(), true);
});
test('real MySQL fixture options obey v4 capacity contract and preserve registry capacity/fingerprint', async () => {
  const { fixtureOptions, fixtureRegistry } = await import('../../src/proxy/src/test/enterpriseFixtures.js');
  const { normalizePoolConfig } = await import('../../src/proxy/src/userPool/config.js');
  const { initEnterpriseMysqlV4 } = await import('../../src/packages/shared/src/enterpriseMysqlV4.js');
  const { mysqlFixtureV4 } = await import('../../upgrade/multi-enterprise-pool/mysql.fixture.js');
  const options = normalizePoolConfig({ enabled: true, accountDomain: 'synthetic.example.test', idleTarget: 4, maxAccounts: 8,
    leaseSeconds: 172800, provisionalSeconds: 300, pollMs: 5000, prewarmConcurrency: 2, retryAfterSeconds: 30,
    warmupModel: 'synthetic-no-http', requestTimeoutMs: 120000 });
  const registry = fixtureRegistry(options), init = fixtureOptions(options);
  assert.equal(Object.hasOwn(init, 'maxAccounts'), false);
  assert.equal(registry.profiles[0].maxAccounts, options.maxAccounts);
  const rejected = mysqlFixtureV4('pool', 0, registry);
  await assert.rejects(initEnterpriseMysqlV4(rejected.connection, 'proxy', registry, { ...init, maxAccounts: options.maxAccounts }), /enterprise_mysql_v4_settings/);
  assert.equal(rejected.statements.length, 0, 'Strict production gate must keep rejecting the stale v2 field before SQL');
  const valid = mysqlFixtureV4('pool', 0, registry);
  await initEnterpriseMysqlV4(valid.connection, 'proxy', registry, init);
  assert.equal(valid.data.enterprise_profiles[0].max_accounts, options.maxAccounts);
  assert.equal(valid.data.user_pool_settings[0].config_fingerprint, init.pool!.fingerprint);
  assert.equal(valid.data.user_pool_settings[0].paused, 1);
  assert.equal(valid.data.user_pool_settings[0].idle_target, options.idleTarget);
});
test('actual pristine old SSO/Login builders preserve every original typed SQLite value through public v2/v3/v4 commands', async t => {
  if (!process.env.PHASE5_LEGACY_SOURCE_ROOT) { t.skip('No explicit pristine old source for local synthetic fixture test'); return; }
  const root = legacySource(), directory = mkdtempSync(join(tmpdir(), 'phase5-chain-synthetic-'));
  try {
    const { registryV3 } = await import('../../upgrade/multi-enterprise/fixtures.js');
    const registry = registryV3();
    for (const p of registry.profiles) p.maxAccounts = 6;
    const profile = registry.profiles.find(p => p.id === registry.legacyEnterpriseId)!;
    const { normalizePoolConfig } = await import('../../src/proxy/src/userPool/config.js');
    const runtime = normalizePoolConfig({ enabled: true, accountDomain: profile.accountDomain, idleTarget: 0,
      maxAccounts: 12, leaseSeconds: 120, provisionalSeconds: 20, pollMs: 1000, prewarmConcurrency: 2,
      loginMaxPending: 5, retryAfterSeconds: 2, warmupModel: 'phase5-synthetic', requestTimeoutMs: 30000 });
    const originalRuntime = structuredClone(runtime), explicit = historicalPoolConfig(runtime, registry);
    assert.deepEqual(runtime, originalRuntime, 'Adapting the old cap must not mutate immutable run state');
    assert.equal(explicit.maxAccounts, 6);
    assert.deepEqual(explicit, { ...runtime, maxAccounts: 6 }, 'Only seed-only cap changes from global12 to legacy6');
    assert.throws(() => historicalPoolConfig({ ...runtime, maxAccounts: 11 }, registry), /global_capacity_mismatch/);
    const seeded = await legacySeedPoolConfig(root, profile, explicit);
    assert.deepEqual(seeded.options, explicit, 'Old normalization must exactly match prepared runtime invariants');
    const { idleTarget: _idle, maxAccounts: _max, leaseSeconds: _lease, enabled: _enabled, callerDomain: _legacy, ...invariants } = runtime;
    assert.equal(seeded.fingerprint, sha256(JSON.stringify(Object.entries(invariants).sort(([a], [b]) => a.localeCompare(b)))));
    await assert.rejects(legacySeedPoolConfig(root, profile, { ...explicit, accountDomain: 'wrong.invalid' }), /profile_mismatch/);
    const admin = { username: 'phase5-admin', password: 'synthetic-console-preseed-password' };
    const files = await seedLegacySqlite(root, directory, profile, 'synthetic-original', admin);
    const adminBytes = readFileSync(files.admins), [adminRow] = JSON.parse(adminBytes.toString());
    assert.equal(adminRow.username, admin.username);
    assert.equal(adminRow.password_hash, scryptSync(admin.password, adminRow.salt, 64).toString('hex'));
    const original = { sso: await snapshotSqlite(files.sso), login: await snapshotSqlite(files.login) };
    const { default: Database } = await import('better-sqlite3');
    const { runMigrations } = await import('../../upgrade/v1-frozen/db/migrations.js');
    const proxy = new Database(':memory:'); runMigrations(proxy);
    const { writeFileSync } = await import('node:fs'); writeFileSync(join(directory, 'proxy-v1.sqlite'), proxy.serialize()); proxy.close();
    const { runEnterpriseCommand } = await import('../../upgrade/default-enterprise/commands.js');
    const { runEnterpriseCommandV3 } = await import('../../upgrade/multi-enterprise/commands.js');
    const { runEnterpriseCommandV4 } = await import('../../upgrade/multi-enterprise-pool/commands.js');
    for (const version of [2, 3, 4]) {
      const services = ['proxy', 'sso', 'login'].map(component => {
        const source = join(directory, `${component}-v${version - 1}.sqlite`);
        return { component, driver: 'sqlite', layout: component === 'proxy' ? 'direct' : component, source,
          target: join(directory, `${component}-v${version}.sqlite`), backup: { reference: `synthetic-${component}-v${version - 1}`, sha256: sha256(readFileSync(source)) } };
      });
      const manifest = version === 2 ? { manifestVersion: 1, baseline: '8ad76d5', profile: Object.fromEntries(['id','slug','shortcode','accountDomain','revision','routes'].map(k => [k, (profile as any)[k]])), services,
        attestations: { writersStopped: true, externalOperationsDrained: true, backupVerified: true },
        admins: { path: files.admins, backup: { reference: 'synthetic-admins', sha256: sha256(readFileSync(files.admins)) } } }
        : { manifestVersion: version, sourceSchemaVersion: version - 1, registry, services, attestations: { writersStopped: true, externalOperationsDrained: true, backupVerified: true } };
      const command = version === 2 ? runEnterpriseCommand : version === 3 ? runEnterpriseCommandV3 : runEnterpriseCommandV4;
      const planOut = join(directory, `plan-v${version}.json`);
      await command('preflight', manifest, { env: {}, planOut });
      const bound = JSON.parse(readFileSync(planOut, 'utf8'));
      for (const operation of ['apply', 'verify', 'inspect'] as const) { const result = await command(operation, bound, { env: {} }); if (operation !== 'inspect') assert.equal(result.ready, true); }
      for (const component of ['sso','login'] as const) assert.deepEqual(await snapshotSqlite(join(directory, `${component}-v${version}.sqlite`), original[component], registry.legacyEnterpriseId), original[component]);
      assert.deepEqual(readFileSync(files.admins), adminBytes, 'Known synthetic admin must remain original bytes through every migration');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
