import { enterpriseMysqlSchema, ENTERPRISE_MYSQL_TABLES, MYSQL_FENCE_TRIGGER, type EnterpriseMysqlLayout } from './enterpriseMysql.js';
import type { TableSchema } from './enterpriseMysqlV1.js';

export const ENTERPRISE_MYSQL_V3_MIGRATION = 'enterprise-schema3-contract2';
export const ENTERPRISE_MYSQL_V3_FINAL_STEP = 27;
export interface EnterpriseMysqlTriggerV3 { table: string; timing: 'BEFORE' | 'AFTER'; event: 'INSERT' | 'UPDATE' | 'DELETE'; body: string }
const uuid = 'VARCHAR(36) COLLATE ascii_bin';
const ascii = 'COLLATE ascii_bin';
export const ENTERPRISE_MYSQL_V3_TABLES: Record<string, TableSchema> = {
  enterprise_profiles: { pool: true, primary: 'id', unique: ['slug'], columns: {
    id: uuid, slug: `VARCHAR(100) ${ascii} NOT NULL`, revision: 'INT NOT NULL', profile_json: 'TEXT NOT NULL', max_accounts: 'INT NOT NULL',
  }, checks: ['revision >= 1', 'max_accounts >= 1 AND max_accounts <= 10000'] },
  enterprise_registry: { pool: true, primary: 'singleton', columns: {
    singleton: 'TINYINT', legacy_enterprise_id: `${uuid} NOT NULL`, registry_revision: 'BIGINT NOT NULL', registry_sha256: `CHAR(64) ${ascii} NOT NULL`,
  }, checks: ['singleton = 1', 'registry_revision >= 1'] },
  enterprise_schema: { pool: true, primary: 'singleton', columns: {
    singleton: 'TINYINT', component: `VARCHAR(16) ${ascii} NOT NULL`, schema_version: 'INT NOT NULL', contract_version: 'INT NOT NULL',
    capability: `VARCHAR(64) ${ascii} NOT NULL`, layout: `VARCHAR(16) ${ascii} NOT NULL`,
    registry_sha256: `CHAR(64) ${ascii} NOT NULL`, migration_id: `VARCHAR(64) ${ascii} NOT NULL`, state: `VARCHAR(16) ${ascii} NOT NULL`,
  }, checks: ['singleton = 1', "component = 'proxy'", 'schema_version = 3', 'contract_version = 2',
    "capability = 'enterprise-isolation-legacy-pool'", "layout IN ('direct', 'pool')", "state = 'complete'"] },
  proxy_authorization_attempts: { pool: true, primary: 'oauth_attempt_id', columns: {
    oauth_attempt_id: uuid, enterprise_id: `${uuid} NOT NULL`, enterprise_revision: 'INT NOT NULL',
    identity: 'VARCHAR(255) COLLATE utf8mb4_bin NOT NULL', account_incarnation: `${uuid} NOT NULL`,
    expected_gh_login: `VARCHAR(100) ${ascii} NOT NULL`, expected_github_user_id: `VARCHAR(20) ${ascii}`,
    status: `VARCHAR(16) ${ascii} NOT NULL`, result_fingerprint: `CHAR(64) ${ascii}`,
    result_gh_login: `VARCHAR(100) ${ascii}`, result_github_user_id: `VARCHAR(20) ${ascii}`, failure_reason: 'TEXT',
    created_at: 'DATETIME(3) NOT NULL', updated_at: 'DATETIME(3) NOT NULL',
  }, foreign: [['enterprise_id', 'enterprise_profiles', 'id', 'RESTRICT']],
  indexes: ['idx_proxy_authorization_enterprise (enterprise_id)', 'idx_proxy_authorization_identity (identity, account_incarnation)'],
  checks: ['enterprise_revision >= 1', "status IN ('active', 'succeeded', 'failed', 'cancelled')"] },
  enterprise_upgrade_v3: { pool: true, primary: 'singleton', columns: {
    singleton: 'TINYINT', migration_id: `VARCHAR(64) ${ascii} NOT NULL`, database_name: `VARCHAR(64) ${ascii} NOT NULL`,
    manifest_sha256: `CHAR(64) ${ascii} NOT NULL`, backup_reference: 'VARCHAR(255) NOT NULL', backup_sha256: `CHAR(64) ${ascii} NOT NULL`,
    registry_sha256: `CHAR(64) ${ascii} NOT NULL`, source_sha256: `CHAR(64) ${ascii} NOT NULL`, mapping_sha256: `CHAR(64) ${ascii} NOT NULL`,
    layout: `VARCHAR(16) ${ascii} NOT NULL`, state: `VARCHAR(16) ${ascii} NOT NULL`, step: 'INT NOT NULL',
    checkpoint_state: `VARCHAR(16) ${ascii} NOT NULL`, evidence_json: 'LONGTEXT NOT NULL', mapping_json: 'LONGTEXT NOT NULL',
  }, checks: ['singleton = 1', "layout IN ('direct', 'pool')", "state IN ('applying', 'complete')",
    `step >= 0 AND step <= ${ENTERPRISE_MYSQL_V3_FINAL_STEP}`, "checkpoint_state IN ('before', 'after', 'unknown')"] },
};
const immutable = (table: string, fields: string[], code: string): EnterpriseMysqlTriggerV3 => ({ table, timing: 'BEFORE', event: 'UPDATE', body: `BEGIN
  IF ${fields.map(field => `NOT (CAST(OLD.${field} AS BINARY) <=> CAST(NEW.${field} AS BINARY))`).join('\n    OR ')} THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${code}';
  END IF;
END` });
const noDelete = (table: string, code: string): EnterpriseMysqlTriggerV3 => ({ table, timing: 'BEFORE', event: 'DELETE', body: `BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${code}';
END` });
const poolGuard = (event: 'INSERT' | 'UPDATE'): EnterpriseMysqlTriggerV3 => ({ table: 'user_pool_accounts', timing: 'BEFORE', event, body: `BEGIN
  IF NOT EXISTS (SELECT 1 FROM proxy_accounts a JOIN enterprise_registry r ON r.singleton = 1
    WHERE BINARY a.identity = BINARY NEW.identity AND BINARY a.enterprise_id = BINARY r.legacy_enterprise_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'enterprise_pool_legacy_only';
  END IF;
END` });
export const ENTERPRISE_MYSQL_V3_TRIGGERS: Record<string, EnterpriseMysqlTriggerV3> = {
  enterprise_profile_immutable: immutable('enterprise_profiles', ['id', 'slug', 'revision', 'profile_json'], 'enterprise_profile_immutable'),
  enterprise_profile_no_delete: noDelete('enterprise_profiles', 'enterprise_profile_immutable'),
  enterprise_account_immutable: immutable('proxy_accounts', ['identity', 'enterprise_id', 'account_incarnation'], 'enterprise_account_immutable'),
  enterprise_claim_immutable: immutable('proxy_identity_initializations', ['identity', 'enterprise_id'], 'enterprise_claim_immutable'),
  enterprise_registry_immutable: immutable('enterprise_registry', ['singleton', 'legacy_enterprise_id'], 'enterprise_registry_immutable'),
  enterprise_registry_no_delete: noDelete('enterprise_registry', 'enterprise_registry_immutable'),
  enterprise_authorization_immutable: { ...immutable('proxy_authorization_attempts', ['oauth_attempt_id', 'enterprise_id', 'enterprise_revision', 'identity', 'account_incarnation', 'expected_gh_login', 'expected_github_user_id', 'created_at'], 'enterprise_authorization_immutable'),
    body: immutable('proxy_authorization_attempts', ['oauth_attempt_id', 'enterprise_id', 'enterprise_revision', 'identity', 'account_incarnation', 'expected_gh_login', 'expected_github_user_id', 'created_at'], 'enterprise_authorization_immutable').body.replace(/END$/, `  IF OLD.status <> 'active' AND (
    NOT (CAST(OLD.status AS BINARY) <=> CAST(NEW.status AS BINARY))
    OR NOT (CAST(OLD.result_fingerprint AS BINARY) <=> CAST(NEW.result_fingerprint AS BINARY))
    OR NOT (CAST(OLD.result_gh_login AS BINARY) <=> CAST(NEW.result_gh_login AS BINARY))
    OR NOT (CAST(OLD.result_github_user_id AS BINARY) <=> CAST(NEW.result_github_user_id AS BINARY))
    OR NOT (CAST(OLD.failure_reason AS BINARY) <=> CAST(NEW.failure_reason AS BINARY))
    OR NOT (OLD.updated_at <=> NEW.updated_at)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'authorization_attempt_terminal';
  END IF;
END`) },
  enterprise_authorization_no_delete: noDelete('proxy_authorization_attempts', 'enterprise_authorization_immutable'),
};
export const ENTERPRISE_MYSQL_V3_POOL_TRIGGERS: Record<string, EnterpriseMysqlTriggerV3> = {
  user_pool_credential_fence: MYSQL_FENCE_TRIGGER,
  enterprise_pool_legacy_insert: poolGuard('INSERT'), enterprise_pool_legacy_update: poolGuard('UPDATE'),
};
export function enterpriseMysqlSchemaV3(layout: EnterpriseMysqlLayout): Record<string, TableSchema> {
  const schema = enterpriseMysqlSchema(layout);
  delete schema.enterprise_profiles; delete schema.enterprise_schema;
  schema.proxy_accounts.columns.account_incarnation = `${uuid} NOT NULL`;
  schema.proxy_accounts.unique = ['account_incarnation'];
  schema.proxy_identity_initializations.columns.enterprise_id = `${uuid} NOT NULL`;
  schema.proxy_identity_initializations.foreign = [['enterprise_id', 'enterprise_profiles', 'id', 'RESTRICT']];
  schema.proxy_identity_initializations.indexes!.push('idx_proxy_initializations_enterprise (enterprise_id)');
  return structuredClone({ enterprise_profiles: ENTERPRISE_MYSQL_V3_TABLES.enterprise_profiles,
    enterprise_registry: ENTERPRISE_MYSQL_V3_TABLES.enterprise_registry, ...schema,
    proxy_authorization_attempts: ENTERPRISE_MYSQL_V3_TABLES.proxy_authorization_attempts,
    enterprise_schema: ENTERPRISE_MYSQL_V3_TABLES.enterprise_schema,
    enterprise_upgrade: ENTERPRISE_MYSQL_TABLES.enterprise_upgrade,
    enterprise_upgrade_v3: ENTERPRISE_MYSQL_V3_TABLES.enterprise_upgrade_v3 });
}
export function getExpectedEnterpriseMysqlV3(layout: EnterpriseMysqlLayout) {
  return { schema: enterpriseMysqlSchemaV3(layout), triggers: structuredClone({ ...ENTERPRISE_MYSQL_V3_TRIGGERS,
    ...(layout === 'pool' ? ENTERPRISE_MYSQL_V3_POOL_TRIGGERS : {}) }) };
}
export function enterpriseMysqlCreateTriggerV3(name: string, trigger: EnterpriseMysqlTriggerV3): string {
  return `CREATE TRIGGER ${name} ${trigger.timing} ${trigger.event} ON ${trigger.table} FOR EACH ROW ${trigger.body}`;
}
