import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { renderMysqlInitialSql } from './mysqlInitialSql.js';
import { MYSQL_SCHEMA } from './mysqlSchema.js';

const scriptUrl = new URL('../../../../scripts/proxy-mysql-initial.sql', import.meta.url);

test('scripts/proxy-mysql-initial.sql matches the schema Proxy validates', async () => {
  const committed = (await readFile(scriptUrl, 'utf8')).replace(/\r\n/g, '\n');
  assert.equal(committed, renderMysqlInitialSql(), 'Run `npm --workspace @ghcp/proxy run mysql:initial-sql` and commit the result.');
});

test('initial SQL creates every table, the credential fence and the migration records', () => {
  const sql = renderMysqlInitialSql();
  for (const table of Object.keys(MYSQL_SCHEMA)) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS \`${table}\``));
  assert.match(sql, /CREATE TRIGGER user_pool_credential_fence AFTER UPDATE ON proxy_accounts/);
  assert.match(sql, /`caller_id` VARCHAR\(71\)/);
  assert.equal(sql.match(/INSERT IGNORE INTO schema_migrations/g)?.length, 3);
});
