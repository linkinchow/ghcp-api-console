import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Connection, Pool } from 'mysql2/promise';
import type { PoolConfig } from '../../upgrade/v1-frozen/userPool/config.js';
import type { EnterpriseRegistryV3 } from '../../src/packages/shared/src/enterpriseV3.js';
import { assertEmpty, hashFile, insist, sha256, type State } from './db-gate.js';

export const LEGACY_HASHES: Record<string, string> = {
  'src/sso/src/db/migrations.ts': 'de16c10a14dca6a30e343d5654c2d47cc013c6cb75ac895791fd5190f07bf10b',
  'src/login/src/db/migrations.ts': '40a3d055a71e8e06ed03d85cc03e01c27f1d6c50d92f78b6eadfbf04e902d1f2',
  'src/proxy/src/db/mysqlMigrations.ts': '86ec3ef3033cb440bf169cc5a439bf6c5eece5039005d9460e66f90471cd6779',
  'src/proxy/src/userPool/mysqlStore.ts': '52024f293c6c0fdd88d9ca616254774ed300c787a040d88253c761e033cd9cdc',
};
export function legacySource(env = process.env): string {
  const root = env.PHASE5_LEGACY_SOURCE_ROOT;
  insist(root && isAbsolute(root), 'explicit_pristine_legacy_source_required');
  for (const [path, hash] of Object.entries(LEGACY_HASHES)) insist(hashFile(join(root, path)) === hash, 'legacy_source_not_frozen_8ad76d5');
  return root;
}
export function assertLegacySharedRuntime(root: string): void {
  const expected: Record<string, string> = {
    'src/proxy/src/db/mysqlStorage.ts': '962628d25097014ed80ca4f6ff72e3c4ad96ab5b13fe9f5835f23578932f63ba',
    'src/packages/shared/package.json': '41dd0b228cad9aad6e4f5f0519a03d0b2918bd40ae24e08ace8e39b3f0ecd78f',
    'src/packages/shared/src/index.ts': '99ead419af02569c955a90615259081836e7e6fe986646986ae9e5ae176bf09e',
    'src/packages/shared/src/contracts.ts': '10e583864c6bd35882befa8fa2870cf3b93b75481702060d281d218051d5efe5',
    'src/packages/shared/src/api.ts': '986d023f678d6515e3ec5a73b64ab8324acea330a6c4000e8f6bc636295fe2c6',
    'src/packages/shared/src/httpClient.ts': '156127f5d9382b56389d7bb40ea6e331dc034d08f1049af245c010f1760094ed',
    'src/packages/shared/src/ids.ts': 'e2633e978f6d69ba5acaf26b43b77a1e0ba7c33d65edf55913f30ac23fdd75c5',
    'src/packages/shared/src/logger.ts': 'e07da881faa813fb075f6747ba1c99f626126a737429ec71cfe44ecab6f930b7',
    'src/packages/shared/src/redact.ts': '150c77464eac2cb1f3ec630141d46b70ede180abd5682cb87c3dbacdaaa1cd2d',
    'src/packages/shared/src/time.ts': 'bf34af3b532ba276c0089bda9833a73b55c65f8701e403dda34b2954c9aac314',
  };
  for (const [file, hash] of Object.entries(expected)) insist(hashFile(join(root, file)) === hash, 'legacy_runtime_source_changed');
  const require = createRequire(join(root, 'src/proxy/src/db/mysqlStorage.ts'));
  const installed = require.resolve.paths('@ghcp/shared')?.map(base => join(base, '@ghcp/shared')).find(path => existsSync(join(path, 'package.json')));
  insist(installed && realpathSync(installed) === realpathSync(join(root, 'src/packages/shared'))
    && existsSync(join(installed, 'dist/index.js')), 'legacy_shared_resolves_current_or_unbuilt');
}
export const importLegacy = (root: string, file: string) => import(pathToFileURL(join(root, file)).href);
export function poolOptions(profile: any) {
  return { enabled: true, accountDomain: profile.accountDomain, idleTarget: 2, maxAccounts: profile.maxAccounts,
    leaseSeconds: 172800, provisionalSeconds: 300, pollMs: 5000, prewarmConcurrency: 2,
    retryAfterSeconds: 30, warmupModel: 'phase5-synthetic-no-http', requestTimeoutMs: 120000 };
}
export function connectionPool(c: Connection): Pool {
  return { query: c.query.bind(c), execute: c.execute.bind(c),
    async getConnection() { return new Proxy(c, { get(target, key) {
      if (key === 'release') return () => {};
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } }); } } as unknown as Pool;
}
export function historicalPoolConfig(runtime: PoolConfig, registry: EnterpriseRegistryV3): PoolConfig {
  const profile = registry.profiles.find(p => p.id === registry.legacyEnterpriseId);
  insist(profile && runtime.enabled === true && runtime.accountDomain === profile.accountDomain
    && runtime.maxAccounts === registry.profiles.reduce((sum, p) => sum + p.maxAccounts, 0), 'preseed_runtime_global_capacity_mismatch');
  // The historical singleton owned only A's cap. Global runtime capacity is a
  // seed-only option excluded from the fingerprint; keep every invariant exact.
  return { ...runtime, maxAccounts: profile.maxAccounts };
}
export async function legacySeedPoolConfig(root: string, profile: any, explicit?: PoolConfig): Promise<{ options: PoolConfig; fingerprint: string }> {
  const { normalizePoolConfig } = await importLegacy(root, 'src/proxy/src/userPool/config.ts');
  if (explicit) insist(explicit.accountDomain === profile.accountDomain && explicit.maxAccounts === profile.maxAccounts
    && explicit.enabled === true, 'preseed_pool_config_profile_mismatch');
  const options = normalizePoolConfig(explicit ?? poolOptions(profile)) as PoolConfig;
  const { idleTarget: _idle, maxAccounts: _max, leaseSeconds: _lease, enabled: _enabled, callerDomain: _legacy, ...invariants } = options;
  return { options, fingerprint: sha256(JSON.stringify(Object.entries(invariants).sort(([a], [b]) => a.localeCompare(b)))) };
}
/** Uses the actual pristine v1 initialization functions, not a new hand-built approximation. */
export async function seedLegacyMysql(c: Connection, root: string, profile: any, layout: 'pool' | 'direct' = 'pool', explicitPoolConfig?: PoolConfig) {
  const seeded = await legacySeedPoolConfig(root, profile, explicitPoolConfig);
  await assertEmpty(c);
  const { runMysqlMigrations } = await importLegacy(root, 'src/proxy/src/db/mysqlMigrations.ts');
  await runMysqlMigrations(connectionPool(c));
  if (layout === 'pool') {
    const { MysqlPoolStore } = await importLegacy(root, 'src/proxy/src/userPool/mysqlStore.ts');
    await new MysqlPoolStore(connectionPool(c), seeded.options).initialize();
    const [settings] = await c.query<any[]>('SELECT config_fingerprint FROM user_pool_settings WHERE id=1');
    insist(settings[0]?.config_fingerprint === seeded.fingerprint, 'preseed_fingerprint_mismatch');
  }
  const { accountName } = await importLegacy(root, 'src/proxy/src/userPool/names.ts');
  const identity = accountName(0), created = '2026-01-02 03:04:05.006', token = '  phase5 \0 ByteSensitive Aaß☃  ';
  const caller = 'sha256:' + sha256('phase5-original-caller'), lease = randomUUID(), attempt = randomUUID();
  await c.execute(`INSERT INTO proxy_accounts(identity,sso_user,gh_login,copilot_oauth_token,copilot_oauth_status,copilot_oauth_updated_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`, [identity, identity, `${identity}_${profile.shortcode}`, token, 'valid', created, created, created]);
  if (layout === 'pool') {
    await c.execute('UPDATE user_pool_settings SET paused=1,version=7,next_ordinal=1,owner=NULL,owner_until=0 WHERE id=1');
    await c.execute(`INSERT INTO user_pool_accounts(identity,ordinal,state,stage,attempt_id,oauth_attempt_id,sso_created_at,task_id,attempts,retry_at,last_error,
      updated_at,cooldown_until,verified_at,generation,reauth_count,reauth_window_at) VALUES(?,0,'ready','ready',?,?,?,'phase5-completed-task',2,0,NULL,1700000000000,0,1700000000000,7,1,1699999999999)`,
    [identity, attempt, attempt, '2026-01-02T03:04:05.006Z']);
    await c.execute(`INSERT INTO user_pool_leases(caller_id,member_identity,lease_id,phase,assigned_at,last_success_at,expires_at)
      VALUES(?,?,?,'active',1700000000000,1700000000123,4102444800000)`, [caller, identity, lease]);
    await c.execute(`INSERT INTO user_pool_events(id,at,action,identity,caller_id,lease_id,detail) VALUES
      (7,1800000000000,'synthetic-original',?,?,?,'original bytes'),(8,1,'synthetic-before-recreated',?,NULL,NULL,NULL),
      (9,1800000000000,'synthetic-unattributed','deleted-synthetic',NULL,NULL,NULL),(10,1800000000000,'synthetic-global',NULL,NULL,NULL,NULL)`,
    [identity, caller, lease, identity]);
    await c.query('ALTER TABLE user_pool_events AUTO_INCREMENT=47');
  }
  await c.execute(`INSERT INTO proxy_request_stats(id,identity,gh_login,requested_at,path,model,success,input_tokens,output_tokens,caller_id,lease_id)
    VALUES('phase5-known',?,?,?,'/v1/messages','synthetic',1,9007199254740993,2,?,?),
    ('phase5-before-recreated',?,?, '2020-01-01 00:00:00.000','/v1/messages','synthetic',0,NULL,NULL,NULL,NULL)`,
    [identity, `${identity}_${profile.shortcode}`, '2026-01-03 03:04:05.006', layout === 'pool' ? caller : null, layout === 'pool' ? lease : null, identity, `${identity}_${profile.shortcode}`]);
  await c.execute(`INSERT INTO proxy_request_stats(id,identity,requested_at,path,success) VALUES
    ('phase5-deleted-account','deleted-synthetic','2026-01-03 03:04:05.006','/v1/messages',0)`);
  return { identity, caller, lease, attempt, tokenSha256: sha256(token), baseline: '8ad76d5', layout,
    poolConfig: seeded.options, poolFingerprint: seeded.fingerprint, explicitPreseedRuntimeConfig: explicitPoolConfig !== undefined };
}
export async function seedLegacySqlite(root: string, directory: string, profile: any, identity: string,
  admin?: { username: string; password: string }) {
  if (admin) insist(/^[a-zA-Z0-9_-]{1,64}$/.test(admin.username) && /^[a-zA-Z0-9_-]{24,128}$/.test(admin.password), 'synthetic_admin_preseed_required');
  const { default: Database } = await import('better-sqlite3');
  const outputs: Record<string, string> = {};
  for (const component of ['sso', 'login']) {
    const path = join(directory, `${component}-v1.sqlite`); insist(!existsSync(path), 'sqlite_seed_output_exists');
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys=ON');
      const { runMigrations } = await importLegacy(root, `src/${component}/src/db/migrations.ts`);
      runMigrations(db);
      const stamp = '2026-01-02T03:04:05.006Z';
      if (component === 'sso') {
        const salt = randomBytes(16).toString('hex'), password = randomBytes(32).toString('base64url');
        db.prepare(`INSERT INTO sso_users(sso_user,password_hash,salt,email,role,gh_login,gh_scim_id,emu_status,copilot_seat_status,created_at,updated_at)
          VALUES(?,?,?,?,? ,?,?,'synced','assigned',?,?)`).run(identity, scryptSync(password, salt, 64).toString('hex'), salt,
        `${identity}@${profile.accountDomain}`, 'user', `${identity}_${profile.shortcode}`, 'phase5-scim-original', stamp, stamp);
        db.prepare('INSERT INTO sso_pool_managed_users(sso_user) VALUES(?)').run(identity);
        db.prepare('UPDATE sso_runtime_settings SET email_domain=?,max_sso_users=?,version=4,updated_at=? WHERE id=1').run(profile.accountDomain, profile.maxAccounts, stamp);
        db.prepare("INSERT INTO sso_budget_cache VALUES('2026-01',2026,1,1.125,'synthetic','{\"original\":true}',?)").run(stamp);
        db.prepare("INSERT INTO sso_emu_import_plans(id,sso_user,status,created_at,updated_at,applied_at) VALUES('phase5-plan',?,'complete',?,?,?)").run(identity, stamp, stamp, stamp);
        db.prepare(`INSERT INTO sso_emu_import_plan_rows(plan_id,row_index,sso_user,status,detail,created_at,updated_at)
          VALUES('phase5-plan',9007199254740993,?,'complete','synthetic history',?,?)`).run(identity, stamp, stamp);
      } else {
        for (const [index, status] of ['success', 'failed', 'cancelled'].entries()) db.prepare(`INSERT INTO login_tasks
          (id,identity,sso_user,gh_login,oauth_attempt_id,sso_type,status,attempts,failure_reason,created_at,started_at,finished_at)
          VALUES(?,?,?,?,?,'custom',?,2,?,?,?,?)`).run(`phase5-task-${index}`, identity, identity, `${identity}_${profile.shortcode}`,
        randomUUID(), status, status === 'success' ? null : 'synthetic-terminal', stamp, stamp, stamp);
        db.prepare('UPDATE login_runtime_settings SET version=4,updated_at=? WHERE id=1').run(stamp);
      }
      writeFileSync(path, db.serialize(), { flag: 'wx', mode: 0o600 }); outputs[component] = path;
    } finally { db.close(); }
  }
  const adminPath = join(directory, 'admins.json'), salt = randomBytes(16).toString('hex');
  writeFileSync(adminPath, JSON.stringify([{ username: admin?.username ?? 'phase5-recovery-admin',
    password_hash: scryptSync(admin?.password ?? randomBytes(32), salt, 64).toString('hex'), salt, role: 'admin', enabled: true }]), { flag: 'wx', mode: 0o600 });
  outputs.admins = adminPath;
  return outputs;
}
export function certificateEvidence(state: State, registry: any): Record<string, string> {
  const result: Record<string, string> = {};
  for (const p of registry.profiles) for (const key of ['signingCertRef', 'signingKeyRef']) {
    const ref = p.sso[key]; insist(ref && typeof ref.file === 'string', 'synthetic_certificate_file_reference_required');
    // In tooling this is /fixture/secrets; host caller translates via prepared host root.
    const file = ref.file.startsWith('/fixture/') && !existsSync(ref.file)
      ? join(state.hostPaths.fixture, ref.file.slice('/fixture/'.length)) : ref.file;
    result[`${p.id}:${key}`] = hashFile(file);
  }
  return result;
}
