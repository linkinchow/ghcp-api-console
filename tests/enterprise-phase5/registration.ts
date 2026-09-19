import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize } from 'node:v8';
import type { Connection } from 'mysql2/promise';
import type { EnterpriseRegistryV3 } from '../../src/packages/shared/src/enterpriseV3.js';
import type { EnterpriseManifestV4, MysqlServiceV4, SqliteServiceV4 } from '../../upgrade/multi-enterprise-pool/manifest.js';
import { args, assertEmpty, connect, databaseUrl, hashFile, inside, insist, loadDbGate, noSymlinkPath, resultPath, safeError, sha256, writePrivate } from './db-gate.js';

const SCHEMA = 'ghcp_enterprise_test_phase5_v4';
const IDENTITY = 'phase5-registration-retained';
const STAMP = '2026-01-02T03:04:05.006Z';
const TOKEN = '  phase5-registration\0ByteSensitive Aaß☃  ';
const CALLER = `sha256:${sha256('phase5-registration-retained-caller')}`;
const quote = (name: string) => { insist(/^[a-z_][a-z0-9_]*$/.test(name), 'registration_identifier'); return '`' + name + '`'; };

/** One fresh qualification only. No app schema, provider calls, database provisioning or cleanup. */
export async function registration(input = args()): Promise<void> {
  insist(Object.keys(input).every(k => ['state', 'inspect', 'output', 'self-test'].includes(k)), 'registration_arguments');
  if (input['self-test'] !== undefined) {
    insist(input['self-test'] === '1' && Object.keys(input).length === 1, 'registration_self_test_arguments');
    const directory = mkdtempSync(join(tmpdir(), 'phase5-registration-synthetic-'));
    try {
      const { registryV3 } = await import('../../upgrade/multi-enterprise/fixtures.js');
      const result = await qualify(directory, registryV3(), {});
      console.log(JSON.stringify({ ...result, execution: 'local-all-sqlite-synthetic', realMysqlExecuted: false }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
    return;
  }
  const state = await loadDbGate(input.state, input.inspect);
  resultPath(state, input.output);
  const fixture = input.state.startsWith('/fixture/') ? '/fixture' : state.hostPaths.fixture;
  const directory = inside(fixture, join(fixture, 'registration')); noSymlinkPath(directory);
  insist(!existsSync(directory), 'registration_output_exists');
  const registryFile = existsSync(state.registryFile) ? state.registryFile : join(fixture, 'registry.json');
  const registryHash = hashFile(registryFile), registry = JSON.parse(readFileSync(registryFile, 'utf8'));
  const c = await connect(state, SCHEMA);
  try {
    await assertEmpty(c); mkdirSync(directory, { mode: 0o700 });
    const env = { ENTERPRISE_MYSQL_PHASE5_REGISTER: databaseUrl(state, SCHEMA) };
    const proxy: MysqlServiceV4 = { component: 'proxy', driver: 'mysql', layout: 'pool', location: {
      host: '127.0.0.1', port: state.database.hostPort, database: SCHEMA, connectionEnv: 'ENTERPRISE_MYSQL_PHASE5_REGISTER' } };
    const result = await qualify(directory, registry, env, { c, proxy });
    assert.equal(hashFile(registryFile), registryHash, 'Run registry bytes must not change');
    writePrivate(input.output, { ...result, syntheticOnly: true, runId: state.runId, schema: SCHEMA,
      mysqlContainerOwnershipVerified: true, execution: 'real-mysql-with-sso-login-sqlite',
      registryFileUnchanged: true,
      externalProviderRequests: 0, databaseCreated: false, databaseDropped: false, qualificationSchemaRetained: true });
  } finally { await c.end().catch(() => c.destroy()); }
}

async function qualify(directory: string, value: unknown, env: NodeJS.ProcessEnv,
  mysql?: { c: Connection; proxy: MysqlServiceV4 }) {
  // These imports occur only after real ownership/loopback gates, or explicit local self-test.
  const { parseEnterpriseRegistryV3 } = await import('../../src/packages/shared/src/enterpriseV3.js');
  const { runEnterpriseCommandV4 } = await import('../../upgrade/multi-enterprise-pool/commands.js');
  const { default: Database } = await import('better-sqlite3');
  const full = parseEnterpriseRegistryV3(value), a = full.profiles.find(p => p.id === full.legacyEnterpriseId)!;
  insist(full.profiles.length === 2 && a.maxAccounts > 1, 'registration_two_profile_fixture_required');
  const b = full.profiles.find(p => p.id !== a.id)!;
  const previous = parseEnterpriseRegistryV3({ ...full, profiles: [a] });
  const next = parseEnterpriseRegistryV3({ ...full, registryRevision: previous.registryRevision + 1 });
  const retainedCap = a.maxAccounts - 1, lease = randomUUID(), incarnation = randomUUID(), attempt = randomUUID();
  const settings = { version: 1, idle_target: 0, lease_seconds: 120, paused: 1 as const, next_ordinal: 0,
    account_domain: a.accountDomain, owner: null, owner_until: 0 };
  const pool = { settings, fingerprint: sha256('phase5-registration-offline-only') };
  const proxy: MysqlServiceV4 | SqliteServiceV4 = mysql ? { ...mysql.proxy, init: { pool } }
    : { component: 'proxy', driver: 'sqlite', layout: 'pool', target: join(directory, 'proxy-before.sqlite'), init: { pool } };
  const sources = { sso: join(directory, 'sso-before.sqlite'), login: join(directory, 'login-before.sqlite') };
  const attestations = { writersStopped: true as const, externalOperationsDrained: true as const, backupVerified: true as const };
  const initial: EnterpriseManifestV4 = { manifestVersion: 4, sourceSchemaVersion: 3, registry: previous, services: [proxy,
    { component: 'sso', driver: 'sqlite', layout: 'sso', target: sources.sso },
    { component: 'login', driver: 'sqlite', layout: 'login', target: sources.login }], attestations };
  const commands: { command: string; pairedRegistry: boolean; ready: boolean }[] = [];
  const run = async (command: 'init' | 'register' | 'verify' | 'inspect', manifest: EnterpriseManifestV4) => {
    const result = await runEnterpriseCommandV4(command, manifest, { env });
    if (command !== 'inspect') insist(result.ready && result.pairedRegistry, 'registration_public_command_not_ready');
    commands.push({ command, ready: result.ready, pairedRegistry: result.pairedRegistry }); return result;
  };
  writePrivate(join(directory, 'init-manifest.json'), initial);
  await run('init', initial); await run('verify', initial);
  const sqlTime = '2026-01-02 03:04:05.006';
  if (mysql) {
    await mysql.c.execute('UPDATE enterprise_profiles SET max_accounts=? WHERE id=?', [retainedCap, a.id]);
    await mysql.c.execute(`INSERT INTO proxy_accounts(identity,enterprise_id,account_incarnation,sso_user,gh_login,copilot_oauth_token,
      copilot_oauth_status,copilot_oauth_updated_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'valid',?,?,?)`,
    [IDENTITY, a.id, incarnation, IDENTITY, `${IDENTITY}_${a.shortcode}`, TOKEN, sqlTime, sqlTime, sqlTime]);
    await mysql.c.execute(`INSERT INTO user_pool_accounts(identity,ordinal,state,stage,attempt_id,sso_created_at,updated_at,verified_at,generation)
      VALUES(?,0,'ready','ready',?,?,1700000000000,1700000000000,7)`, [IDENTITY, attempt, STAMP]);
    await mysql.c.execute('UPDATE user_pool_settings SET next_ordinal=1,version=7 WHERE id=1');
    await mysql.c.execute(`INSERT INTO user_pool_leases(caller_id,member_identity,lease_id,phase,assigned_at,last_success_at,expires_at)
      VALUES(?,?,?,'active',1700000000000,1700000000123,4102444800000)`, [CALLER, IDENTITY, lease]);
    await mysql.c.execute(`INSERT INTO proxy_request_stats(id,enterprise_id,identity,requested_at,path,success,input_tokens)
      VALUES('registration-known',?,?,'2026-01-03 00:00:00.000','/v1/messages',1,9007199254740993),
      ('registration-unattributed',NULL,'deleted-synthetic','2020-01-01 00:00:00.000','/v1/messages',0,NULL)`, [a.id, IDENTITY]);
    await mysql.c.execute(`INSERT INTO user_pool_events(at,action,identity,enterprise_id) VALUES(1700000000000,'registration-retained',?,?),
      (1700000000001,'registration-unattributed',NULL,NULL)`, [IDENTITY, a.id]);
  } else {
    const db = new Database((proxy as SqliteServiceV4).target);
    try {
      db.pragma('foreign_keys=ON');
      db.prepare('UPDATE enterprise_profiles SET max_accounts=? WHERE id=?').run(retainedCap, a.id);
      db.prepare(`INSERT INTO proxy_accounts(identity,enterprise_id,account_incarnation,sso_user,gh_login,copilot_oauth_token,
        copilot_oauth_status,copilot_oauth_updated_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'valid',?,?,?)`)
        .run(IDENTITY, a.id, incarnation, IDENTITY, `${IDENTITY}_${a.shortcode}`, TOKEN, STAMP, STAMP, STAMP);
      db.prepare(`INSERT INTO user_pool_accounts(identity,ordinal,state,stage,attempt_id,sso_created_at,updated_at,verified_at,generation)
        VALUES(?,0,'ready','ready',?,?,1700000000000,1700000000000,7)`).run(IDENTITY, attempt, STAMP);
      db.prepare('UPDATE user_pool_settings SET next_ordinal=1,version=7 WHERE id=1').run();
      db.prepare(`INSERT INTO user_pool_leases(caller_id,member_identity,lease_id,phase,assigned_at,last_success_at,expires_at)
        VALUES(?,?,?,'active',1700000000000,1700000000123,4102444800000)`).run(CALLER, IDENTITY, lease);
      db.prepare(`INSERT INTO proxy_request_stats(id,enterprise_id,identity,requested_at,path,success,input_tokens)
        VALUES('registration-known',?,?,?,'/v1/messages',1,9007199254740993),
        ('registration-unattributed',NULL,'deleted-synthetic','2020-01-01T00:00:00.000Z','/v1/messages',0,NULL)`).run(a.id, IDENTITY, STAMP);
      db.prepare(`INSERT INTO user_pool_events(at,action,identity,enterprise_id) VALUES(1700000000000,'registration-retained',?,?),
        (1700000000001,'registration-unattributed',NULL,NULL)`).run(IDENTITY, a.id);
    } finally { db.close(); }
  }
  for (const component of ['sso', 'login'] as const) {
    const db = new Database(sources[component]);
    try {
      db.pragma('foreign_keys=ON');
      db.prepare('UPDATE enterprise_profiles SET max_accounts=? WHERE id=?').run(retainedCap, a.id);
      if (component === 'sso') {
        const salt = '0123456789abcdef0123456789abcdef';
        db.prepare(`INSERT INTO sso_users(enterprise_id,sso_user,user_incarnation,password_hash,salt,email,gh_login,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(a.id, IDENTITY, randomUUID(), scryptSync('synthetic-registration-password', salt, 64).toString('hex'),
        salt, `${IDENTITY}@${a.accountDomain}`, `${IDENTITY}_${a.shortcode}`, STAMP, STAMP);
        db.prepare('INSERT INTO sso_pool_managed_users(enterprise_id,sso_user) VALUES(?,?)').run(a.id, IDENTITY);
      } else db.prepare(`INSERT INTO login_tasks(id,enterprise_id,binding_version,identity,sso_user,sso_type,status,created_at,finished_at)
        VALUES('registration-terminal-task',?,1,?,?,'custom','success',?,?)`).run(a.id, IDENTITY, IDENTITY, STAMP, STAMP);
    } finally { db.close(); }
  }
  await run('verify', initial);

  function sqliteSnapshot(file: string, scopeLegacy = true) {
    const db = new Database(readFileSync(file));
    try {
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN ('enterprise_registry','enterprise_schema') ORDER BY name").all() as { name: string }[];
      return tables.map(({ name }) => {
        const key = name === 'enterprise_profiles' ? 'id' : ['enterprise_pool_policy', 'sso_runtime_settings'].includes(name) ? 'enterprise_id' : undefined;
        const rows = db.prepare(`SELECT * FROM ${quote(name)}${key && scopeLegacy ? ` WHERE ${quote(key)}=?` : ''}`).raw(true).safeIntegers(true);
        return { table: name, rows: (key && scopeLegacy ? rows.all(a.id) : rows.all()).map(row => serialize(row).toString('hex')).sort() };
      });
    } finally { db.close(); }
  }
  async function mysqlSnapshot() {
    insist(mysql, 'registration_mysql_connection_required');
    const [tables] = await mysql.c.query<any[]>("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME NOT IN ('enterprise_registry','enterprise_schema') ORDER BY TABLE_NAME");
    const out: unknown[] = [];
    for (const { name } of tables) {
      const [columns] = await mysql.c.query<any[]>('SELECT COLUMN_NAME name,COLUMN_TYPE type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [name]);
      const key = name === 'enterprise_profiles' ? 'id' : name === 'enterprise_pool_policy' ? 'enterprise_id' : undefined;
      const [rows] = await mysql.c.query<any[]>(`SELECT ${columns.map(col => `HEX(CAST(${quote(col.name)} AS BINARY)) AS ${quote(col.name)}`).join(',')} FROM ${quote(name)}${key ? ` WHERE ${quote(key)}=?` : ''}`, key ? [a.id] : []);
      out.push({ table: name, columns, rows: rows.map(row => JSON.stringify(row)).sort() });
    }
    const [sequence] = await mysql.c.query<any[]>("SELECT AUTO_INCREMENT n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user_pool_events'");
    out.push({ eventSequence: String(sequence[0].n) });
    return out;
  }
  const before = { proxy: mysql ? await mysqlSnapshot() : sqliteSnapshot((proxy as SqliteServiceV4).target),
    sso: sqliteSnapshot(sources.sso), login: sqliteSnapshot(sources.login) };
  // Private complete logical row evidence; no dump/restore qualification is claimed here.
  writePrivate(join(directory, 'before-logical-snapshot.json'), before);
  const sourceHashes = Object.fromEntries(Object.entries(sources).map(([component, file]) => [component, hashFile(file)]));
  const register: EnterpriseManifestV4 = { manifestVersion: 4, sourceSchemaVersion: 3, registry: next, previousRegistry: previous,
    services: [mysql ? { ...mysql.proxy } : { component: 'proxy', driver: 'sqlite', layout: 'pool', source: (proxy as SqliteServiceV4).target,
      target: join(directory, 'proxy-after.sqlite'), backup: { reference: 'registration-proxy-standalone', sha256: hashFile((proxy as SqliteServiceV4).target) } },
    ...(['sso', 'login'] as const).map(component => ({ component, driver: 'sqlite' as const, layout: component,
      source: sources[component], target: join(directory, `${component}-after.sqlite`),
      backup: { reference: `registration-${component}-standalone`, sha256: sourceHashes[component] } }))], attestations };
  writePrivate(join(directory, 'register-manifest.json'), register);
  const rejected: string[] = [];
  for (const kind of ['wrong-revision', 'old-profile-mutation'] as const) {
    const bad = structuredClone(register);
    if (kind === 'wrong-revision') bad.registry.registryRevision = previous.registryRevision;
    else bad.registry.profiles.find(p => p.id === a.id)!.maxAccounts++;
    for (const service of bad.services) if (service.driver === 'sqlite') service.target = join(directory, `${kind}-${service.component}.sqlite`);
    await assert.rejects(runEnterpriseCommandV4('register', bad, { env }), /(?:registry_add_only|registry_append_only)/);
    for (const service of bad.services) if (service.driver === 'sqlite') {
      if (mysql) assert.equal(existsSync(service.target), false, 'Invalid MySQL registration must reject before SQLite outputs');
      else if (existsSync(service.target)) assert.equal(lstatSync(service.target).size, 0, 'SQLite may retain an exclusive unapproved empty output, never a completed registration');
    }
    assert.deepEqual(mysql ? await mysqlSnapshot() : sqliteSnapshot((proxy as SqliteServiceV4).target), before.proxy);
    rejected.push(kind);
  }
  await run('register', register); await run('verify', register); await run('inspect', register);
  assert.deepEqual(mysql ? await mysqlSnapshot() : sqliteSnapshot(join(directory, 'proxy-after.sqlite')), before.proxy);
  for (const component of ['sso', 'login'] as const) {
    assert.equal(hashFile(sources[component]), sourceHashes[component], 'Standalone registration source unchanged');
    assert.deepEqual(sqliteSnapshot(join(directory, `${component}-after.sqlite`)), before[component]);
    const db = new Database(readFileSync(join(directory, `${component}-after.sqlite`)));
    try {
      const table = component === 'sso' ? 'sso_users' : 'login_tasks';
      assert.equal((db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE enterprise_id=?`).get(b.id) as any).n, 0);
      assert.equal((db.prepare('SELECT max_accounts FROM enterprise_profiles WHERE id=?').get(a.id) as any).max_accounts, retainedCap);
    } finally { db.close(); }
  }
  if (mysql) {
    const [policy] = await mysql.c.query<any[]>('SELECT state,policy_version,validation_kind,validation_evidence_json FROM enterprise_pool_policy WHERE enterprise_id=?', [b.id]);
    assert.deepEqual(policy.map(row => ({ ...row, policy_version: Number(row.policy_version) })), [{ state: 'draft', policy_version: 1, validation_kind: null, validation_evidence_json: null }]);
    const [count] = await mysql.c.query<any[]>('SELECT COUNT(*) n FROM proxy_accounts WHERE enterprise_id=?', [b.id]); assert.equal(Number(count[0].n), 0);
  } else {
    const db = new Database(readFileSync(join(directory, 'proxy-after.sqlite')));
    try {
      assert.deepEqual(db.prepare('SELECT state,policy_version,validation_kind,validation_evidence_json FROM enterprise_pool_policy WHERE enterprise_id=?').get(b.id),
        { state: 'draft', policy_version: 1, validation_kind: null, validation_evidence_json: null });
      assert.equal((db.prepare('SELECT COUNT(*) n FROM proxy_accounts WHERE enterprise_id=?').get(b.id) as any).n, 0);
    } finally { db.close(); }
  }
  return { status: 'PASS', stage: 'offline-registration', commands, rejected,
    previousProfileCount: 1, nextProfileCount: 2, previousRegistryRevision: previous.registryRevision, nextRegistryRevision: next.registryRevision,
    originalPhysicalCap: retainedCap, originalRegistryCap: a.maxAccounts, oldCapNotReset: true, oldPolicyAndTypedBusinessRowsUnchanged: true,
    credentialBytesAndHashSaltUnchanged: true, accountAndUserIncarnationsPreserved: true, activeLeasePreserved: true,
    oldNullableHistoryPreserved: true, standaloneSourcesUnchanged: true, newEnterpriseDraftEmpty: true,
    externalProviderRequests: 0, runtimeStarted: false, backupEvidence: 'standalone SQLite images and private logical row snapshot; not a MySQL dump/restore test' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) registration().catch(error => {
  console.error(safeError(error)); process.exitCode = 1;
});
