import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { MYSQL_SCHEMA, MYSQL_CREDENTIAL_FENCE_BODY } from '../../src/proxy/src/db/mysqlSchema.js';
import { readPoolConfig } from '../../src/proxy/src/userPool/config.js';
import { concurrencyConfigFingerprint, reconfigureConcurrency, type ExpectedPoolSettings,
  type ReconfigureConcurrencyOptions } from './reconfigure-concurrency.js';

const oldEnv = { ACCOUNT_ROUTING_MODE: 'caller-lease', STORAGE_DRIVER: 'mysql', POOL_ACCOUNT_EMAIL_DOMAIN: 'synthetic.invalid',
  READY_IDLE_TARGET: '2', POOL_MAX_ACCOUNTS: '10', CALLER_LEASE_TTL_SECONDS: '172800', PROVISIONAL_LEASE_TTL_SECONDS: '300',
  PREWARM_POLL_SECONDS: '5', PREWARM_CONCURRENCY: '1', POOL_LOGIN_MAX_PENDING: '1', POOL_EXHAUSTED_RETRY_AFTER_SECONDS: '30',
  POOL_WARMUP_MODEL: 'synthetic-unused', POOL_REQUEST_TIMEOUT_SECONDS: '120' };
const newEnv = { ...oldEnv, PREWARM_CONCURRENCY: '5', POOL_LOGIN_MAX_PENDING: '2' };
const expected: ExpectedPoolSettings = { id: 1, version: 7, idle_target: 2, max_accounts: 10, lease_seconds: 172800,
  paused: 1, next_ordinal: 2, account_domain: 'synthetic.invalid', owner: 'expired-synthetic-owner', owner_until: 500 };
type Row = Record<string, any>;
function fixture() {
  const data: Record<string, Row[]> = Object.fromEntries(Object.keys(MYSQL_SCHEMA).map(table => [table, []]));
  data.user_pool_settings = [{ ...expected, config_fingerprint: concurrencyConfigFingerprint(readPoolConfig(oldEnv)) }];
  for (const identity of ['synthetic-one', 'synthetic-two']) {
    data.proxy_accounts.push({ identity, sso_user: identity, gh_login: identity, copilot_oauth_status: 'valid',
      copilot_oauth_token: 'SYNTHETIC_ONLY_TOKEN', copilot_oauth_attempt_id: null, copilot_oauth_updated_at: '2026-01-01' });
    data.user_pool_accounts.push({ identity, state: 'ready', stage: 'ready', verified_at: 100, sso_created_at: '2026-01-01',
      task_id: 'historical-task', oauth_attempt_id: 'historical-attempt', generation: 12, ordinal: data.user_pool_accounts.length,
      last_error: null });
  }
  data.schema_migrations = [{ id: 'synthetic-history', applied_at: '2026-01-01' }];
  data.user_pool_leases = [{ caller_id: 'synthetic-caller', member_identity: 'synthetic-one', expires_at: 999999 }];
  data.user_pool_events = [{ id: '1', detail: 'synthetic-history' }];
  data.proxy_request_stats = [{ id: 'synthetic-stat', input_tokens: '100', extra: Buffer.from('synthetic') }];
  data.user_pool_catalog_cooldowns = [{ caller_id: 'synthetic-caller', expires_at: 99999 }];
  let rollbackImage: Record<string, Row[]> | undefined;
  const f = { data, statements: [] as string[], commits: 0, rollbacks: 0, destroyed: 0, casRows: 1,
    commitFail: false, rollbackFail: false, mutateAfterUpdate: false, missingTrigger: false, stallCommit: false,
    connection: { config: { host: '127.0.0.1', database: 'synthetic_maintenance', socketPath: undefined as string | undefined },
      stream: { remoteAddress: '127.0.0.1' } },
    async query(sql: string, values: any[] = []): Promise<any> {
      f.statements.push(sql);
      if (sql.startsWith('SET TRANSACTION')) return [[], []];
      if (sql.includes('DATABASE() AS db')) return [[{ db: 'synthetic_maintenance', version: '8.0.40', now: '1000' }], []];
      if (sql.includes('information_schema.TABLES')) return [Object.keys(MYSQL_SCHEMA).map(TABLE_NAME => ({ TABLE_NAME, ENGINE: 'InnoDB' })), []];
      const name = values[0], schema = MYSQL_SCHEMA[name];
      if (sql.includes('information_schema.COLUMNS')) return [Object.entries(schema.columns).map(([column, definition]) => ({
        COLUMN_NAME: column, COLUMN_TYPE: definition.match(/^\w+(?:\(\d+\))?(?: UNSIGNED)?/)![0].toLowerCase(),
        IS_NULLABLE: column === schema.primary || definition.includes('NOT NULL') ? 'NO' : 'YES',
        COLLATION_NAME: definition.match(/COLLATE (\w+)/)?.[1] ?? (schema.pool && /^(VARCHAR|CHAR|TEXT)/.test(definition) ? 'utf8mb4_bin' : null),
        COLUMN_DEFAULT: definition.match(/DEFAULT (?:'([^']*)'|(\d+))/)?.slice(1).find(value => value !== undefined) ?? null,
        EXTRA: definition.includes('AUTO_INCREMENT') ? 'auto_increment' : '',
      })), []];
      if (sql.includes('information_schema.STATISTICS')) {
        const result: Row[] = [schema.primary, ...schema.unique ?? []].map((COLUMN_NAME, i) => ({
          COLUMN_NAME, INDEX_NAME: i === 0 ? 'PRIMARY' : `unique_${i}`, NON_UNIQUE: 0, SEQ_IN_INDEX: 1, SUB_PART: null }));
        for (const definition of schema.indexes ?? []) {
          const [INDEX_NAME, ...parts] = definition.replace(/[(),]/g, ' ').trim().split(/\s+/);
          parts.filter(part => part !== 'DESC').forEach((COLUMN_NAME, i) => result.push({ COLUMN_NAME, INDEX_NAME, NON_UNIQUE: 1, SEQ_IN_INDEX: i + 1, SUB_PART: null }));
        }
        return [result, []];
      }
      if (sql.includes('information_schema.CHECK_CONSTRAINTS')) return [(schema.checks ?? []).map(CHECK_CLAUSE => ({ CHECK_CLAUSE, ENFORCED: 'YES' })), []];
      if (sql.includes('information_schema.KEY_COLUMN_USAGE')) return [(schema.foreign ?? []).map(([COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, DELETE_RULE]) => ({
        COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, DELETE_RULE, UPDATE_RULE: 'RESTRICT', local_reference: 1 })), []];
      if (sql.includes('information_schema.TRIGGERS')) return [f.missingTrigger ? [] : [{ TRIGGER_NAME: 'user_pool_credential_fence',
        EVENT_OBJECT_TABLE: 'proxy_accounts', ACTION_TIMING: 'AFTER', EVENT_MANIPULATION: 'UPDATE', ACTION_STATEMENT: MYSQL_CREDENTIAL_FENCE_BODY }], []];
      const table = sql.match(/SELECT \* FROM `?(\w+)`?/i)?.[1];
      if (table && f.data[table]) return [f.data[table].map(row => ({ ...row })), []];
      throw new Error('unexpected synthetic query');
    },
    async execute(sql: string, values: any[]): Promise<any> {
      f.statements.push(sql);
      assert.match(sql, /^UPDATE user_pool_settings SET config_fingerprint=\?/);
      assert.match(sql, /paused=1 AND owner_until<=/);
      assert.match(sql, /`version` <=> \?/);
      if (f.casRows === 1) f.data.user_pool_settings[0].config_fingerprint = values[0];
      if (f.mutateAfterUpdate) f.data.proxy_accounts[0].copilot_oauth_token = 'SYNTHETIC_CORRUPTION';
      return [{ affectedRows: f.casRows }, []];
    },
    async beginTransaction() { rollbackImage = structuredClone(f.data); },
    async commit() { f.commits++; if (f.stallCommit) return new Promise<void>(() => {}); if (f.commitFail) throw new Error('PRIVATE_DRIVER_SECRET'); },
    async rollback() { f.rollbacks++; if (f.rollbackFail) throw new Error('PRIVATE_DRIVER_SECRET'); Object.assign(f.data, rollbackImage); },
    destroy() { f.destroyed++; },
  };
  const options: ReconfigureConcurrencyOptions = { connection: f as unknown as PoolConnection, expectedDatabase: 'synthetic_maintenance',
    oldEnv: { ...oldEnv }, newEnv: { ...newEnv }, expectedSettings: { ...expected }, confirmAllProxiesStopped: true,
    confirmExternalWritersStopped: true, confirmLoginDrained: true };
  return { f, options };
}

test('fingerprint equals independent current runtime formula, defaults normalize, mutable seeds excluded', () => {
  const config = readPoolConfig(oldEnv);
  const { enabled, idleTarget, maxAccounts, leaseSeconds, callerDomain, ...invariants } = config;
  const legacy = createHash('sha256').update(JSON.stringify(Object.entries(invariants).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  assert.equal(concurrencyConfigFingerprint(config), legacy);
  assert.equal(concurrencyConfigFingerprint({ ...config, idleTarget: 0, maxAccounts: 3, enabled: false }), legacy);
  assert.equal(concurrencyConfigFingerprint({ ...config, prewarmConcurrency: undefined, loginMaxPending: undefined }),
    concurrencyConfigFingerprint({ ...config, prewarmConcurrency: 5, loginMaxPending: 5 }));
  assert.notEqual(concurrencyConfigFingerprint(readPoolConfig(newEnv)), legacy);
});
test('changes only fingerprint; preserves every other table and completed task correlation', async () => {
  const { f, options } = fixture();
  const before = structuredClone(f.data);
  assert.deepEqual(await reconfigureConcurrency(options), { changed: true });
  before.user_pool_settings[0].config_fingerprint = concurrencyConfigFingerprint(readPoolConfig(newEnv));
  assert.deepEqual(f.data, { ...before, proxy_request_stats: before.proxy_request_stats.map(row => ({ ...row, extra: Buffer.from(row.extra) })) });
  assert.equal(f.commits, 1); assert.equal(f.rollbacks, 0);
  assert.equal(f.statements.filter(sql => /^(UPDATE|DELETE|INSERT|CREATE|ALTER|DROP)/.test(sql)).length, 1);
  assert.match(f.statements[1], /user_pool_settings WHERE id=1 FOR UPDATE/);
});
for (const [label, change, error] of [
  ['confirmation', (o: any) => { o.confirmExternalWritersStopped = false; }, 'offline_confirmations'],
  ['missing config', (o: any) => { delete o.oldEnv.PREWARM_POLL_SECONDS; }, 'explicit_config'],
  ['extra config', (o: any) => { o.newEnv.UNKNOWN = 'secret'; }, 'explicit_config'],
  ['invalid range', (o: any) => { o.newEnv.PREWARM_CONCURRENCY = '21'; }, 'invalid_pool_config'],
  ['domain change', (o: any) => { o.newEnv.POOL_ACCOUNT_EMAIL_DOMAIN = 'other.invalid'; }, 'only_concurrency'],
  ['model change', (o: any) => { o.newEnv.POOL_WARMUP_MODEL = 'other'; }, 'only_concurrency'],
  ['mutable seed change', (o: any) => { o.newEnv.READY_IDLE_TARGET = '3'; }, 'only_concurrency'],
  ['no change', (o: any) => { o.newEnv = { ...oldEnv }; }, 'concurrency_change_required'],
  ['bad expected settings', (o: any) => { o.expectedSettings.paused = 0; }, 'invalid_expected'],
] as const) test(`rejects ${label} before SQL`, async () => {
  const { f, options } = fixture(); change(options);
  await assert.rejects(reconfigureConcurrency(options), new RegExp(error)); assert.equal(f.statements.length, 0);
});
for (const [label, change, error] of [
  ['old hash mismatch', (f: any) => { f.data.user_pool_settings[0].config_fingerprint = '0'.repeat(64); }, 'old_settings'],
  ['version mismatch', (f: any) => { f.data.user_pool_settings[0].version++; }, 'old_settings'],
  ['unpaused pool', (f: any) => { f.data.user_pool_settings[0].paused = 0; }, 'old_settings'],
  ['hold', (f: any) => { f.data.user_pool_holds.push({ expires_at: 0 }); }, 'undrained'],
  ['catalog hold', (f: any) => { f.data.user_pool_catalog_holds.push({ expires_at: 0 }); }, 'undrained'],
  ['init claim', (f: any) => { f.data.proxy_identity_initializations.push({ lease_expires_at: 0 }); }, 'undrained'],
  ['dispatch', (f: any) => { f.data.user_pool_accounts[0].stage = 'oauth-dispatch'; }, 'inventory_not'],
  ['provisioning', (f: any) => { f.data.user_pool_accounts[0].state = 'provisioning'; }, 'inventory_not'],
  ['credential callback', (f: any) => { f.data.proxy_accounts[0].copilot_oauth_attempt_id = 'pending'; }, 'unresolved_credentials'],
  ['refreshing', (f: any) => { f.data.proxy_accounts[0].copilot_oauth_status = 'refreshing'; }, 'unresolved_credentials'],
  ['unpaired task history', (f: any) => { f.data.user_pool_accounts[0].oauth_attempt_id = null; }, 'inventory_not'],
  ['schema trigger mismatch', (f: any) => { f.missingTrigger = true; }, 'maintenance_failed_details_suppressed'],
  ['CAS failure', (f: any) => { f.casRows = 0; }, 'fingerprint_cas_failed'],
  ['unexpected data mutation', (f: any) => { f.mutateAfterUpdate = true; }, 'preservation_verification_failed'],
] as const) test(`rolls back ${label}`, async () => {
  const { f, options } = fixture(); change(f);
  await assert.rejects(reconfigureConcurrency(options), new RegExp(error)); assert.equal(f.commits, 0); assert.equal(f.rollbacks, 1);
});
test('live owner rejected using database time', async () => {
  const { f, options } = fixture(); f.data.user_pool_settings[0].owner_until = options.expectedSettings.owner_until = 1001;
  await assert.rejects(reconfigureConcurrency(options), /live_owner/); assert.equal(f.rollbacks, 1);
});
test('remote address, hostname alias, socket and unexpected database rejected without SQL', async () => {
  for (const mutate of [(f: any) => { f.connection.config.host = 'localhost'; },
    (f: any) => { f.connection.stream.remoteAddress = '203.0.113.1'; },
    (f: any) => { f.connection.config.socketPath = '/tmp/mysql'; },
    (f: any) => { f.connection.config.database = 'other'; }]) {
    const { f, options } = fixture(); mutate(f);
    await assert.rejects(reconfigureConcurrency(options), /literal_loopback/); assert.equal(f.statements.length, 0);
  }
});
test('lost commit response destroys connection, suppresses secret and never rolls back or retries', async () => {
  const { f, options } = fixture(); f.commitFail = true;
  await assert.rejects(reconfigureConcurrency(options), /^Error: commit_outcome_unknown_do_not_retry_or_resume$/);
  assert.equal(f.commits, 1); assert.equal(f.rollbacks, 0); assert.equal(f.destroyed, 1);
});
test('failed rollback destroys connection and reports uncertainty', async () => {
  const { f, options } = fixture(); f.casRows = 0; f.rollbackFail = true;
  await assert.rejects(reconfigureConcurrency(options), /rollback_unconfirmed/); assert.equal(f.destroyed, 1);
});
test('hung commit is deadline-bounded and cannot be replayed', async () => {
  const { f, options } = fixture(); f.stallCommit = true; options.sqlBudgetMs = 100;
  await assert.rejects(reconfigureConcurrency(options), /commit_outcome_unknown/);
  assert.equal(f.commits, 1); assert.equal(f.rollbacks, 0); assert.ok(f.destroyed >= 1);
});
test('other validated concurrency pairs supported; persisted mutable settings need not equal original seeds', async () => {
  const { f, options } = fixture(); options.newEnv.PREWARM_CONCURRENCY = '20'; options.newEnv.POOL_LOGIN_MAX_PENDING = '100';
  f.data.user_pool_settings[0].idle_target = options.expectedSettings.idle_target = 0;
  assert.deepEqual(await reconfigureConcurrency(options), { changed: true });
});
