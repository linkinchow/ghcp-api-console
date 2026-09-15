import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { canonicalSql, MYSQL_CREDENTIAL_FENCE_BODY, MYSQL_SCHEMA, MysqlSchemaError,
  validateMysqlCredentialFence, validateMysqlSchema } from './mysqlSchema.js';

type Row = Record<string, unknown>;
function fixture() {
  const columns: Record<string, Row[]> = {};
  const indexes: Record<string, Row[]> = {};
  const foreign: Record<string, Row[]> = {};
  const checks: Record<string, Row[]> = {};
  for (const [name, table] of Object.entries(MYSQL_SCHEMA)) {
    columns[name] = Object.entries(table.columns).map(([column, definition]) => {
      const defaults = definition.match(/DEFAULT (?:'([^']*)'|(\d+))/);
      return { COLUMN_NAME: column, COLUMN_TYPE: definition.match(/^\w+(?:\(\d+\))?(?: UNSIGNED)?/)![0].toLowerCase(),
        IS_NULLABLE: column === table.primary || definition.includes('NOT NULL') ? 'NO' : 'YES',
        COLLATION_NAME: definition.match(/COLLATE (\w+)/)?.[1] ?? (/^(?:VARCHAR|CHAR|TEXT)/.test(definition)
          ? table.pool ? 'utf8mb4_bin' : 'utf8mb4_0900_ai_ci' : null),
        COLUMN_DEFAULT: defaults ? defaults[1] ?? defaults[2] : null, EXTRA: definition.includes('AUTO_INCREMENT') ? 'auto_increment' : '' };
    });
    indexes[name] = [table.primary, ...table.unique ?? []].map((column, i) => ({ INDEX_NAME: i ? column : 'PRIMARY',
      NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: column, SUB_PART: null }));
    for (const index of table.indexes ?? []) {
      const [indexName, ...parts] = index.replace(/[(),]/g, ' ').trim().split(/\s+/);
      parts.filter(part => part !== 'DESC').forEach((column, i) => indexes[name].push({ INDEX_NAME: indexName,
        NON_UNIQUE: 1, SEQ_IN_INDEX: i + 1, COLUMN_NAME: column, SUB_PART: null }));
    }
    foreign[name] = (table.foreign ?? []).map(([column, target, referenced, onDelete]) => ({ CONSTRAINT_NAME: 'canonical', COLUMN_NAME: column,
      REFERENCED_TABLE_NAME: target, REFERENCED_COLUMN_NAME: referenced, DELETE_RULE: onDelete, UPDATE_RULE: 'NO ACTION', local_reference: 1 }));
    checks[name] = (table.checks ?? []).map(check => ({ CHECK_CLAUSE: `(${check})`, ENFORCED: 'YES' }));
  }
  let triggers: Row[] = [{ TRIGGER_NAME: 'user_pool_credential_fence', EVENT_OBJECT_TABLE: 'proxy_accounts', ACTION_TIMING: 'AFTER',
    EVENT_MANIPULATION: 'UPDATE', ACTION_STATEMENT: MYSQL_CREDENTIAL_FENCE_BODY }];
  const connection = { async query(sql: string, values: string[] = []) {
    if (sql.includes('information_schema.TRIGGERS')) return [triggers];
    if (sql.includes('information_schema.TABLES')) return [Object.keys(MYSQL_SCHEMA).map(TABLE_NAME => ({ TABLE_NAME, ENGINE: 'InnoDB' }))];
    if (sql.includes('information_schema.COLUMNS')) return [columns[values[0]]];
    if (sql.includes('information_schema.STATISTICS')) return [indexes[values[0]]];
    if (sql.includes('information_schema.CHECK_CONSTRAINTS')) return [checks[values[0]]];
    if (sql.includes('information_schema.KEY_COLUMN_USAGE')) return [foreign[values[0]]];
    assert.fail(`Unexpected fixture query: ${sql}`);
  } } as unknown as PoolConnection;
  return { columns, indexes, foreign, checks, connection, setTriggers: (rows: Row[]) => { triggers = rows; }, triggers };
}

test('all canonical schema definitions pass metadata validation', async () => {
  const f = fixture();
  await validateMysqlSchema(f.connection, Object.keys(MYSQL_SCHEMA));
  await validateMysqlCredentialFence(f.connection);
  f.columns.user_pool_settings.find(row => row.COLUMN_NAME === 'version')!.COLUMN_TYPE = 'int(11)';
  f.checks.user_pool_accounts[0].CHECK_CLAUSE = "(`state` in (_ascii'provisioning',_ascii'ready',_ascii'cooling',_ascii'failed',_ascii'disabled'))";
  await validateMysqlSchema(f.connection, Object.keys(MYSQL_SCHEMA));
});

test('MySQL escaped CHECK_CLAUSE enum delimiters match only supported simple checks', async () => {
  const f = fixture();
  f.checks.user_pool_accounts[0].CHECK_CLAUSE = "(`state` in (_utf8mb4\\'provisioning\\',_utf8mb4\\'ready\\',_utf8mb4\\'cooling\\',_utf8mb4\\'failed\\',_utf8mb4\\'disabled\\'))";
  f.checks.user_pool_leases[0].CHECK_CLAUSE = "((`phase` in (_ascii\\'provisional\\',_ascii\\'active\\')))";
  await validateMysqlSchema(f.connection, Object.keys(MYSQL_SCHEMA));
  for (const sql of [
    "(`phase` in (_utf8mb4\\'provisional\\',_utf8mb4\\'ACTIVE\\'))",
    "(`phase` in (_utf8mb4\\'provisional\\',_utf8mb4\\'act\\ive\\'))",
    "(`phase` in (_utf8mb4\\'provisional\\',_utf8mb4\\'active'))",
    "(`phase` in (_utf8mb4\\'provisional\\',_utf8mb4\\'active\\')) OR 1",
    "(`phase` in (_utf8mb4\\'provisional\\',_utf8mb4\\'active\\')) /* ignored? */",
    "(`phase` in (_utf8mb4\\'provisional\\',_utf8mb4\\'active\\')) = (1)",
  ]) {
    f.checks.user_pool_leases[0].CHECK_CLAUSE = sql;
    await assert.rejects(validateMysqlSchema(f.connection, ['user_pool_leases']), MysqlSchemaError);
  }
});

const alterations: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  ['integer type', f => { f.columns.user_pool_accounts.find(row => row.COLUMN_NAME === 'generation')!.COLUMN_TYPE = 'int'; }],
  ['integer sign', f => { f.columns.user_pool_accounts.find(row => row.COLUMN_NAME === 'generation')!.COLUMN_TYPE = 'bigint unsigned'; }],
  ['caller collation', f => { f.columns.user_pool_leases[0].COLLATION_NAME = 'ascii_general_ci'; }],
  ['token collation', f => { f.columns.proxy_accounts.find(row => row.COLUMN_NAME === 'copilot_oauth_token')!.COLLATION_NAME = 'utf8mb4_general_ci'; }],
  ['nullable fence', f => { f.columns.user_pool_accounts.find(row => row.COLUMN_NAME === 'generation')!.IS_NULLABLE = 'YES'; }],
  ['changed default', f => { f.columns.user_pool_accounts.find(row => row.COLUMN_NAME === 'generation')!.COLUMN_DEFAULT = '1'; }],
  ['generated field', f => { f.columns.user_pool_accounts.find(row => row.COLUMN_NAME === 'generation')!.EXTRA = 'STORED GENERATED'; }],
  ['missing unique', f => { f.indexes.user_pool_leases = f.indexes.user_pool_leases.filter(row => row.INDEX_NAME !== 'member_identity'); }],
  ['nonunique substitute', f => { f.indexes.user_pool_leases.find(row => row.INDEX_NAME === 'member_identity')!.NON_UNIQUE = 1; }],
  ['prefix unique', f => { f.indexes.user_pool_leases.find(row => row.INDEX_NAME === 'member_identity')!.SUB_PART = 10; }],
  ['composite unique', f => { f.indexes.user_pool_leases.push({ ...f.indexes.user_pool_leases[1], COLUMN_NAME: 'lease_id', SEQ_IN_INDEX: 2 }); }],
  ['missing primary', f => { f.indexes.user_pool_leases[0].INDEX_NAME = 'not_primary'; }],
  ['missing required query index', f => { f.indexes.user_pool_accounts = f.indexes.user_pool_accounts.filter(row => row.INDEX_NAME !== 'idx_user_pool_available'); }],
  ['missing foreign key', f => { f.foreign.user_pool_holds = []; }],
  ['foreign delete action', f => { f.foreign.user_pool_holds[0].DELETE_RULE = 'RESTRICT'; }],
  ['foreign update action', f => { f.foreign.user_pool_holds[0].UPDATE_RULE = 'CASCADE'; }],
  ['foreign remote schema', f => { f.foreign.user_pool_holds[0].local_reference = 0; }],
  ['unenforced check', f => { f.checks.user_pool_leases[0].ENFORCED = 'NO'; }],
  ['altered check', f => { f.checks.user_pool_leases[0].CHECK_CLAUSE = "phase IN ('provisional', 'ACTIVE')"; }],
];
for (const [name, alter] of alterations) test(`schema rejects ${name} without mutation`, async () => {
  const f = fixture(); alter(f);
  await assert.rejects(validateMysqlSchema(f.connection, Object.keys(MYSQL_SCHEMA)), MysqlSchemaError);
});

test('only the known historical TEXT token collation is upgradeable', async () => {
  const f = fixture();
  const token = f.columns.proxy_accounts.find(row => row.COLUMN_NAME === 'copilot_oauth_token')!;
  token.COLLATION_NAME = 'utf8mb4_general_ci';
  await validateMysqlSchema(f.connection, ['proxy_accounts'], { allowLegacyTokenCollation: true });
  token.COLUMN_TYPE = 'varchar(255)';
  await assert.rejects(validateMysqlSchema(f.connection, ['proxy_accounts'], { allowLegacyTokenCollation: true }), MysqlSchemaError);
});

test('credential fence comparison accepts formatting but not semantics, comments or case-sensitive table aliases', async () => {
  const f = fixture();
  f.triggers[0].ACTION_STATEMENT = MYSQL_CREDENTIAL_FENCE_BODY.replace(/\s+/g, ' ').replace('UPDATE user_pool_accounts', 'update `user_pool_accounts`');
  await validateMysqlCredentialFence(f.connection);
  for (const body of ['BEGIN SET @noop = 1; END', MYSQL_CREDENTIAL_FENCE_BODY.replace('generation + 1', 'generation + 0'),
    MYSQL_CREDENTIAL_FENCE_BODY.replace('verified_at = NULL', 'verified_at = verified_at'),
    MYSQL_CREDENTIAL_FENCE_BODY.replace('user_pool_accounts', 'USER_POOL_ACCOUNTS'),
    MYSQL_CREDENTIAL_FENCE_BODY.replace('generation + 1', 'generation /* changed */ + 1')]) {
    f.triggers[0].ACTION_STATEMENT = body;
    await assert.rejects(validateMysqlCredentialFence(f.connection), MysqlSchemaError);
  }
  assert.notEqual(canonicalSql("state='ready'"), canonicalSql("state='READY'"));
  f.setTriggers([]);
  await assert.rejects(validateMysqlCredentialFence(f.connection), /credential fence is missing/);
  assert.equal(await validateMysqlCredentialFence(f.connection, true), false);
});
