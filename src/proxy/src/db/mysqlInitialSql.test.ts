import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ENTERPRISE_MIGRATION_IDS } from './enterpriseMigrationIds.js';
import { renderMysqlEnterpriseUpgradeSql, renderMysqlInitialSql } from './mysqlInitialSql.js';
import { MYSQL_SCHEMA } from './mysqlSchema.js';

const scriptUrl = new URL('../../../../scripts/proxy-mysql-initial.sql', import.meta.url);
const upgradeUrl = new URL('../../../../scripts/proxy-mysql-enterprise-upgrade.sql', import.meta.url);

test('scripts/proxy-mysql-initial.sql matches the schema Proxy validates', async () => {
  const committed = (await readFile(scriptUrl, 'utf8')).replace(/\r\n/g, '\n');
  assert.equal(committed, renderMysqlInitialSql(), 'Run `npm --workspace @ghcp/proxy run mysql:initial-sql` and commit the result.');
});

test('scripts/proxy-mysql-enterprise-upgrade.sql matches the steps Proxy runs', async () => {
  const committed = (await readFile(upgradeUrl, 'utf8')).replace(/\r\n/g, '\n');
  assert.equal(committed, renderMysqlEnterpriseUpgradeSql(),
    'Run `npm --workspace @ghcp/proxy run mysql:enterprise-upgrade-sql` and commit the result.');
});

test('initial SQL creates every table, the credential fence and the migration records', () => {
  const sql = renderMysqlInitialSql();
  for (const table of Object.keys(MYSQL_SCHEMA)) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS \`${table}\``));
  assert.match(sql, /CREATE TRIGGER user_pool_credential_fence AFTER UPDATE ON proxy_accounts/);
  assert.match(sql, /`caller_id` VARCHAR\(71\)/);
  assert.equal(sql.match(/INSERT IGNORE INTO schema_migrations/g)?.length, 9);
  // The identity of `default` depends on the deployment: Proxy inserts that row, the script must not.
  assert.doesNotMatch(sql, /INSERT IGNORE INTO proxy_enterprises/);
  assert.doesNotMatch(sql, new RegExp(ENTERPRISE_MIGRATION_IDS.seedDefault));
  assert.doesNotMatch(sql, new RegExp(ENTERPRISE_MIGRATION_IDS.poolConfigFingerprint));
  assert.doesNotMatch(sql, /DEFAULT 'default'/);
});

test('enterprise upgrade SQL records every DDL step, adds no trigger and leaves no temporary default', () => {
  const sql = renderMysqlEnterpriseUpgradeSql();
  const { poolConfigFingerprint, ...ddlSteps } = ENTERPRISE_MIGRATION_IDS;
  for (const id of Object.values(ddlSteps)) assert.ok(sql.includes(`VALUES ('${id}', UTC_TIMESTAMP(3));`), id);
  assert.doesNotMatch(sql, new RegExp(poolConfigFingerprint));
  assert.doesNotMatch(sql, /CREATE TRIGGER/);
  assert.equal(sql.match(/DEFAULT 'default'/g)?.length, 4);
  assert.equal(sql.match(/DROP DEFAULT/g)?.length, 4);
  assert.match(sql, /ADD INDEX idx_proxy_request_stats_enterprise_time .*,\n {2}ALGORITHM=INPLACE,\n {2}LOCK=NONE;/);
  assert.doesNotMatch(sql, /^USE /m);
});
