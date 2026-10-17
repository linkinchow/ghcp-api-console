import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { POOL_SCHEMA_MIGRATION } from '../userPool/mysqlMigrations.js';
import { INITIAL_SCHEMA_MIGRATION, TOKEN_COLLATION_MIGRATION } from './mysqlMigrations.js';
import { MYSQL_BASE_TABLES, MYSQL_CREDENTIAL_FENCE_DDL, MYSQL_POOL_TABLES, mysqlCreateTable } from './mysqlSchema.js';

/**
 * Renders scripts/proxy-mysql-initial.sql for deployments that run Proxy with MYSQL_AUTO_MIGRATE=false.
 * It is generated from MYSQL_SCHEMA, the same definition auto-migration creates and startup validates,
 * so the manual script cannot drift from what Proxy accepts. Regenerate with `npm run mysql:initial-sql`.
 */
export function renderMysqlInitialSql(): string {
  const migrations = [INITIAL_SCHEMA_MIGRATION, TOKEN_COLLATION_MIGRATION];
  return [
    '-- GENERATED FILE: do not edit. Regenerate with `npm --workspace @ghcp/proxy run mysql:initial-sql`.',
    '-- Prepares the Proxy MySQL schema for MYSQL_AUTO_MIGRATE=false. Run as an administrator account.',
    '--',
    '-- Runtime account privileges on this database:',
    '--   SELECT, INSERT, UPDATE, DELETE',
    '--   plus TRIGGER on proxy_accounts when the user pool is enabled (caller-lease mode):',
    '--   MySQL only shows trigger metadata to accounts holding TRIGGER, and Proxy verifies the',
    '--   credential fence trigger at startup.',
    '',
    'CREATE DATABASE IF NOT EXISTS ghcp_proxy',
    '  CHARACTER SET utf8mb4',
    '  COLLATE utf8mb4_0900_ai_ci;',
    '',
    'USE ghcp_proxy;',
    '',
    '-- If the database already exists, start here.',
    ...MYSQL_BASE_TABLES.map((table) => `${mysqlCreateTable(table)};\n`),
    ...migrations.map(migrationRecord),
    '',
    '-- User pool (caller-lease mode). Safe to apply even when the pool is disabled.',
    ...MYSQL_POOL_TABLES.map((table) => `${mysqlCreateTable(table)};\n`),
    'DELIMITER //',
    `${MYSQL_CREDENTIAL_FENCE_DDL}//`,
    'DELIMITER ;',
    '',
    migrationRecord(POOL_SCHEMA_MIGRATION),
    '',
  ].join('\n');
}

function migrationRecord(id: string): string {
  return `INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('${id}', UTC_TIMESTAMP(3));`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2];
  if (!target) throw new Error('Usage: tsx src/db/mysqlInitialSql.ts <output.sql>');
  await writeFile(target, renderMysqlInitialSql());
}
