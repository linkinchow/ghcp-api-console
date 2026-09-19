import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import type { Pool } from 'mysql2/promise';
import type { EnterpriseProfile, EnterpriseProfileV3, EnterpriseRegistryV3, AuthorizationBinding } from '@ghcp/shared';
import { parseEnterpriseRegistryV3 } from '@ghcp/shared';
import type { EnterpriseInitOptionsV4 } from '@ghcp/shared/enterpriseStorageV4';
import { initEnterpriseSqliteV4 } from '@ghcp/shared/enterpriseStorageV4';
import { enterpriseProfileIdentityHashV4 } from '@ghcp/shared/enterpriseRuntimeV4';
import { enterpriseRegistryHashV3 } from '@ghcp/shared/enterpriseRuntimeV3';
import type { EnterpriseValidationEvidenceV1 } from '@ghcp/shared';
import { initEnterpriseMysqlV4 } from '@ghcp/shared/enterpriseMysqlV4';
import type { ProxyStorage } from '../db/storageTypes.js';
import { SqliteStorage } from '../db/sqliteStorage.js';
import { UserPoolStore } from '../userPool/store.js';
import { MysqlPoolStore } from '../userPool/mysqlStore.js';

export class FixtureMysqlPoolStore extends MysqlPoolStore {
  constructor(pool: Pool, options: PoolConfig) { super(pool, options, fixtureRegistry(options)); }
}
import { normalizePoolConfig, readPoolConfig, type PoolConfig } from '../userPool/config.js';

export const TEST_ENTERPRISE: EnterpriseProfile = {
  id: '86e2ee02-223a-45ea-8c26-bdd1c570a4ee', slug: 'synthetic-enterprise', shortcode: 'octo',
  accountDomain: 'accounts.example.test', revision: 1,
  routes: { proxyInternalUrl: 'http://localhost:3000', ssoInternalUrl: 'http://localhost:7001',
    loginInternalUrl: 'http://localhost:7003', ssoPublicUrl: 'http://localhost:7001' },
};

export function fixtureOptions(options?: PoolConfig): EnterpriseInitOptionsV4 & { layout: 'direct' | 'pool' } {
  if (!options) return { layout: 'direct' };
  const { idleTarget: _idle, maxAccounts: _max, leaseSeconds: _lease, enabled: _enabled,
    callerDomain: _legacy, ...invariants } = normalizePoolConfig(options);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(Object.entries(invariants).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  // v4 capacity belongs to fixtureRegistry profiles, never the frozen v2 init field.
  return { layout: 'pool',
    pool: { fingerprint, settings: { version: 1, idle_target: options.idleTarget,
      lease_seconds: options.leaseSeconds, paused: 1, next_ordinal: 0, account_domain: options.accountDomain,
      owner: null, owner_until: 0 } } };
}

export function fixtureProfile(options?: PoolConfig): EnterpriseProfileV3 {
  const base={ ...TEST_ENTERPRISE,...(options?{accountDomain:options.accountDomain}:{}) };
  return { ...base,maxAccounts:options?.maxAccounts??100,
    sso:{entityId:'urn:synthetic:enterprise',ssoUrl:`${base.routes.ssoPublicUrl}/sso`,loginUrl:`${base.routes.ssoPublicUrl}/login`,logoutUrl:`${base.routes.ssoPublicUrl}/logout`,
      spEntityId:'urn:synthetic:sp',spAcsUrl:'https://github.example.test/saml/consume',scimBaseUrl:'https://api.github.example.test/scim',githubApiBaseUrl:'https://api.github.example.test',
      emailDomain:'example.test',userPrefix:'user',signingCertRef:{env:'TEST_CERT'},signingKeyRef:{env:'TEST_KEY'},sessionSecretRef:{env:'TEST_SESSION'}},
    login:{provider:'custom',allowedLoginUrls:[`${base.routes.ssoPublicUrl}/login`],selectors:{}} };
}
export function fixtureRegistry(options?: PoolConfig,profiles?: EnterpriseProfileV3[]):EnterpriseRegistryV3 {
  return parseEnterpriseRegistryV3({version:3,registryRevision:1,legacyEnterpriseId:TEST_ENTERPRISE.id,profiles:profiles??[fixtureProfile(options)]});
}

/** Explicit test-only trusted completion avoids recreating a contract-1 runtime backdoor. */
export async function completeFixtureAttempt(storage:ProxyStorage,identity:string,attemptId:string,token:string,ghLogin?:string) {
  const account=await storage.getAccount(identity);
  if (!account) return undefined;
  const attempt=await storage.getAuthorizationAttempt(account.enterpriseId,identity,attemptId);
  if (!attempt || attempt.status!=='active') return undefined;
  try {
    await storage.completeAuthorizationAttempt(attempt.binding,token,{login:ghLogin??attempt.binding.expectedGhLogin,id:'101'});
    return storage.getAccount(identity);
  } catch {return undefined;}
}
export async function failFixtureAttempt(storage:ProxyStorage,identity:string,attemptId:string) {
  const account=await storage.getAccount(identity);
  if (!account) return false;
  const attempt=await storage.getAuthorizationAttempt(account.enterpriseId,identity,attemptId);
  if (!attempt || attempt.status!=='active') return false;
  await storage.endAuthorizationAttempt(attempt.binding,'failed');return true;
}

export function initSqliteFixture(db: Database.Database, options?: PoolConfig): void {
  db.pragma('foreign_keys = ON');
  const registry = fixtureRegistry(options);
  initEnterpriseSqliteV4(db, 'proxy', registry, fixtureOptions(options));
  if (options) activateSqliteFixture(db, registry);
}

/** Tests explicitly request initialization; runtime constructors remain validation-only. */
export function createSqlitePoolFixture(db: Database.Database, options: PoolConfig): UserPoolStore {
  if (!(db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get())) initSqliteFixture(db, options);
  return new UserPoolStore(db, options, fixtureRegistry(options));
}

export function createSqliteStorageFixture(options?: PoolConfig, retention = 100): SqliteStorage {
  const db = new Database(':memory:');
  initSqliteFixture(db, options);
  return new SqliteStorage(':memory:', retention, fixtureRegistry(options), db);
}

export async function initMysqlFixture(pool: Pool, options?: PoolConfig): Promise<void> {
  const connection = await pool.getConnection();
  try {
    const registry = fixtureRegistry(options);
    await initEnterpriseMysqlV4(connection, 'proxy', registry, fixtureOptions(options));
    if (options) {
      for (const profile of registry.profiles) {
        const evidence = fixtureReadinessEvidence(registry, profile.id);
        await connection.query("UPDATE enterprise_pool_policy SET state='active',policy_version=3,validation_kind='local_service_readiness_v1',validation_evidence_json=?,validated_at=?,updated_at=? WHERE enterprise_id=?", [JSON.stringify(evidence),evidence.checkedAt,evidence.checkedAt,profile.id]);
      }
      await connection.query('UPDATE user_pool_settings SET paused=0 WHERE id=1');
    }
  }
  finally { connection.release(); }
}

const fixtureCleanups: Array<() => void | Promise<void>> = [];
after(async () => { for (const cleanup of fixtureCleanups.reverse()) await cleanup(); });
const fileCleanup = { after(fn: () => void | Promise<void>) { fixtureCleanups.push(fn); } };

/** Install an isolated on-disk v4 DB/registry before dynamically importing configured service modules. */
export function configureProxyFixture(t: { after(fn: () => void | Promise<void>): void } = fileCleanup, options?: PoolConfig): string {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-enterprise-fixture-'));
  const profilePath = join(dir, 'profile.json');
  const dbPath = join(dir, 'proxy.sqlite');
  const pool = options ?? (process.env.ACCOUNT_ROUTING_MODE === 'caller-lease' ? readPoolConfig(process.env) : undefined);
  const profile = { ...fixtureProfile(pool), shortcode: process.env.ENTERPRISE_SHORTCODE ?? 'octo',
    routes: { ...TEST_ENTERPRISE.routes, ssoInternalUrl: process.env.SSO_BASE_URL ?? TEST_ENTERPRISE.routes.ssoInternalUrl,
      loginInternalUrl: process.env.LOGIN_BASE_URL ?? TEST_ENTERPRISE.routes.loginInternalUrl } };
  const registry=fixtureRegistry(pool,[profile]);
  writeFileSync(profilePath, JSON.stringify(registry));
  const db = new Database(dbPath);
  try { db.pragma('foreign_keys = ON'); initEnterpriseSqliteV4(db, 'proxy', registry, fixtureOptions(pool)); if (pool) activateSqliteFixture(db, registry); }
  finally { db.close(); }
  process.env.ENTERPRISE_REGISTRY_FILE = profilePath;
  process.env.DB_PATH = dbPath;
  process.env.DOTENV_CONFIG_PATH = join(dir, 'missing.env');
  t.after(async () => {
    const { closeStorage } = await import('../db/connection.js');
    await closeStorage();
    rmSync(dir, { recursive: true, force: true });
  });
  return dbPath;
}

export function fixtureReadinessEvidence(registry: EnterpriseRegistryV3, id = registry.legacyEnterpriseId): EnterpriseValidationEvidenceV1 {
  const profile = registry.profiles.find(value => value.id === id)!;
  const identity = { enterpriseId: id, enterpriseRevision: profile.revision, profileIdentitySha256: enterpriseProfileIdentityHashV4(profile),
    registryRevision: registry.registryRevision, registrySha256: enterpriseRegistryHashV3(registry), legacyEnterpriseId: registry.legacyEnterpriseId };
  const base = { probeVersion: 1 as const, schemaVersion: 3, contractVersion: 2 as const, capability: 'enterprise-isolation-legacy-pool',
    ...identity, ready: true, blockers: [] };
  return { version: 1, ...identity, checkedAt: Date.now(), sso: { ...base, component: 'sso' }, login: { ...base, component: 'login' } };
}

function activateSqliteFixture(db: Database.Database, registry: EnterpriseRegistryV3): void {
  for (const profile of registry.profiles) {
    const evidence = fixtureReadinessEvidence(registry, profile.id);
    db.prepare("UPDATE enterprise_pool_policy SET state='active',policy_version=3,validation_kind='local_service_readiness_v1',validation_evidence_json=?,validated_at=?,updated_at=? WHERE enterprise_id=?")
      .run(JSON.stringify(evidence), evidence.checkedAt, evidence.checkedAt, profile.id);
  }
  db.prepare('UPDATE user_pool_settings SET paused=0 WHERE id=1').run();
}
