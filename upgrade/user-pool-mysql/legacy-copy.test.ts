import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/proxy/src/db/migrations.js';
import { UserPoolStore } from '../../src/proxy/src/userPool/store.js';
import { accountName } from '../../src/proxy/src/userPool/names.js';
import { prepareLegacySqliteCopy } from './legacy-copy.js';
import { preflightSqlite } from './migrate.js';

const token = 'SYNTHETIC_ONLY_LEGACY_COPY_AbCdEf';
function hash(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function fixture(historicalLayout = false) {
  const dir = mkdtempSync(join(tmpdir(), 'pool-legacy-copy-synthetic-'));
  const sourcePath = join(dir, 'immutable.sqlite');
  const outputPath = join(dir, 'prepared.sqlite');
  const db = new Database(sourcePath);
  const now = Date.now();
  const timestamp = new Date(now - 10000).toISOString();
  try {
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    if (historicalLayout) db.exec(`CREATE TABLE user_pool_accounts (
      identity TEXT PRIMARY KEY REFERENCES proxy_accounts(identity) ON DELETE RESTRICT,
      ordinal INTEGER UNIQUE NOT NULL, state TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'new',
      attempt_id TEXT NOT NULL, oauth_attempt_id TEXT, sso_created_at TEXT,
      task_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER NOT NULL,
      cooldown_until INTEGER NOT NULL DEFAULT 0, verified_at INTEGER,
      generation INTEGER NOT NULL DEFAULT 0, reauth_count INTEGER NOT NULL DEFAULT 0,
      reauth_window_at INTEGER NOT NULL DEFAULT 0,
      CHECK(state IN ('provisioning', 'ready', 'cooling', 'failed', 'disabled'))
    )`);
    new UserPoolStore(db, { enabled: true, accountDomain: 'fixture.invalid', idleTarget: 2, maxAccounts: 20,
      leaseSeconds: 172800, provisionalSeconds: 300, pollMs: 5000, retryAfterSeconds: 30,
      warmupModel: 'unused-offline', requestTimeoutMs: 120000 });
    db.exec('DROP TABLE user_pool_catalog_cooldowns');
    db.prepare('UPDATE user_pool_settings SET paused=1, next_ordinal=2, version=7, owner=?, owner_until=?')
      .run(randomUUID(), now - 1000);
    for (let ordinal = 0; ordinal < 2; ordinal++) {
      const identity = accountName(ordinal);
      db.prepare(`INSERT INTO proxy_accounts(identity,sso_user,gh_login,copilot_oauth_token,copilot_oauth_status,
        copilot_oauth_updated_at,created_at,updated_at) VALUES(?,?,?,?, 'valid',?,?,?)`)
        .run(identity, identity, `synthetic-${ordinal}`, token + ordinal, timestamp, timestamp, timestamp);
      db.prepare(`INSERT INTO user_pool_accounts(identity,ordinal,state,stage,attempt_id,oauth_attempt_id,task_id,
        sso_created_at,updated_at,verified_at,generation,reauth_count,reauth_window_at)
        VALUES(?,?,'ready','ready',?,?,?,?,?,?,9,2,?)`)
        .run(identity, ordinal, randomUUID(), randomUUID(), randomUUID(), timestamp, now - 5000, now - 5000, now - 90000);
      db.prepare(`INSERT INTO user_pool_leases VALUES(?,?,?,'active',?,?,?)`)
        .run(`sha256:${String(ordinal).repeat(64)}`, identity, randomUUID(), now - 9000, now - 8000,
          ordinal === 0 ? now + 3600000 : now - 1000);
    }
    db.prepare(`INSERT INTO proxy_request_stats(id,identity,requested_at,path,success,input_tokens,cache_input_tokens)
      VALUES('synthetic-stat',?,?,'/chat/completions',1,123,45)`).run(accountName(0), timestamp);
    db.prepare(`INSERT INTO user_pool_events(id,at,action,detail) VALUES(17,?,'synthetic-event','synthetic-detail')`).run(now - 1000);
    // Sequence greater than max(id) must not reset during preparation.
    db.exec("UPDATE sqlite_sequence SET seq=99 WHERE name='user_pool_events'");
  } finally { db.close(); }
  return { sourcePath, outputPath,
    change(sql: string) {
      const writable = new Database(sourcePath);
      try { writable.exec(sql); } finally { writable.close(); }
    },
    close() { rmSync(dir, { recursive: true, force: true }); },
  };
}
function rows(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name!='user_pool_catalog_cooldowns' ORDER BY name").all() as { name: string }[];
    return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  } finally { db.close(); }
}

for (const historical of [false, true]) test(`copy-only preparation preserves all rows and source bytes (${historical ? 'historical' : 'current'} column layout)`, () => {
  const f = fixture(historical);
  try {
    const before = hash(f.sourcePath);
    const beforeRows = rows(f.sourcePath);
    assert.throws(() => preflightSqlite(f.sourcePath), /Unsupported source schema in user_pool_catalog_cooldowns/);
    const result = prepareLegacySqliteCopy({ ...f, confirmOfflineSource: true });
    assert.equal(hash(f.sourcePath), before);
    assert.deepEqual(rows(f.outputPath), beforeRows);
    assert.equal(result.sourceUnchanged, true);
    assert.equal(result.existingRowsUnchanged, true);
    assert.equal(result.counts.proxy_accounts, 2);
    assert.equal(result.counts.user_pool_accounts, 2);
    assert.equal(result.counts.user_pool_leases, 2);
    assert.equal(result.counts.proxy_request_stats, 1);
    assert.equal(result.counts.user_pool_events, 1);
    assert.equal(result.counts.user_pool_catalog_cooldowns, 0);
    assert.deepEqual(preflightSqlite(f.outputPath), { dryRun: true, counts: result.counts });
    assert.ok(!JSON.stringify(result).includes(token));
    for (const path of [f.sourcePath, f.outputPath]) for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(existsSync(path + suffix), false);
    const outputHash = hash(f.outputPath);
    assert.throws(() => prepareLegacySqliteCopy({ ...f, confirmOfflineSource: true }), /Output already exists/);
    assert.equal(hash(f.outputPath), outputHash);
  } finally { f.close(); }
});

const schemaCases: [string, string][] = [
  ['extra column', 'ALTER TABLE proxy_accounts ADD COLUMN custom_token TEXT'],
  ['missing column', 'ALTER TABLE user_pool_accounts DROP COLUMN reauth_count'],
  ['extra table', 'CREATE TABLE unknown_table(id INTEGER)'],
  ['missing later table', 'DROP TABLE user_pool_events'],
  ['missing trigger', 'DROP TRIGGER user_pool_credential_fence'],
  ['altered trigger', 'DROP TRIGGER user_pool_credential_fence; CREATE TRIGGER user_pool_credential_fence AFTER UPDATE ON proxy_accounts BEGIN SELECT 1; END'],
  ['missing index', 'DROP INDEX user_pool_holds_lease'],
  ['conflicting cooldown table', 'CREATE TABLE user_pool_catalog_cooldowns(caller_id TEXT)'],
  ['conflicting cooldown index', 'CREATE INDEX user_pool_catalog_cooldown_expiry ON user_pool_events(at)'],
  ['view', 'CREATE VIEW unexpected_view AS SELECT 1'],
];
for (const [name, sql] of schemaCases) test(`refuses ${name} without source or output writes`, () => {
  const f = fixture();
  try {
    f.change(sql);
    const before = hash(f.sourcePath);
    assert.throws(() => prepareLegacySqliteCopy({ ...f, confirmOfflineSource: true }), /exact supported missing-cooldown legacy schema/);
    assert.equal(hash(f.sourcePath), before);
    assert.equal(existsSync(f.outputPath), false);
  } finally { f.close(); }
});

test('refuses absent confirmation, relative/same paths, existing file, hardlink and sidecars', () => {
  const f = fixture();
  try {
    const before = hash(f.sourcePath);
    assert.throws(() => prepareLegacySqliteCopy({ ...f, confirmOfflineSource: false }), /confirmation/);
    assert.throws(() => prepareLegacySqliteCopy({ ...f, outputPath: 'relative.sqlite', confirmOfflineSource: true }), /absolute/);
    assert.throws(() => prepareLegacySqliteCopy({ ...f, outputPath: f.sourcePath, confirmOfflineSource: true }), /different paths/);
    linkSync(f.sourcePath, f.outputPath);
    assert.throws(() => prepareLegacySqliteCopy({ ...f, confirmOfflineSource: true }), /already exists/);
    rmSync(f.outputPath);
    writeFileSync(f.outputPath, 'synthetic-output-sentinel');
    assert.throws(() => prepareLegacySqliteCopy({ ...f, confirmOfflineSource: true }), /already exists/);
    assert.equal(readFileSync(f.outputPath, 'utf8'), 'synthetic-output-sentinel');
    rmSync(f.outputPath);
    for (const path of [f.sourcePath, f.outputPath]) for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = path + suffix;
      writeFileSync(sidecar, 'synthetic-sidecar');
      assert.throws(() => prepareLegacySqliteCopy({ ...f, confirmOfflineSource: true }), /sidecars/);
      assert.equal(readFileSync(sidecar, 'utf8'), 'synthetic-sidecar');
      rmSync(sidecar);
    }
    assert.equal(hash(f.sourcePath), before);
    assert.equal(existsSync(f.outputPath), false);
  } finally { f.close(); }
});

test('unchanged importer rejects unsafe data after preparation; output retained unapproved and source immutable', () => {
  const f = fixture();
  try {
    f.change('UPDATE user_pool_settings SET paused=0');
    const before = hash(f.sourcePath);
    const beforeRows = rows(f.sourcePath);
    assert.throws(() => prepareLegacySqliteCopy({ ...f, confirmOfflineSource: true }), (error: Error) => {
      assert.match(error.message, /unapproved and retained/);
      assert.ok(!error.message.includes(token) && !error.message.includes(f.sourcePath));
      return true;
    });
    assert.equal(hash(f.sourcePath), before);
    assert.equal(existsSync(f.outputPath), true);
    assert.deepEqual(rows(f.outputPath), beforeRows);
    assert.throws(() => preflightSqlite(f.outputPath), /already be paused/);
  } finally { f.close(); }
});

test('rejects WAL headers and missing input without creating source or output', () => {
  const f = fixture();
  try {
    f.change('PRAGMA journal_mode=WAL');
    const before = hash(f.sourcePath);
    assert.throws(() => prepareLegacySqliteCopy({ ...f, confirmOfflineSource: true }), /rollback-journal/);
    assert.equal(hash(f.sourcePath), before);
    assert.equal(existsSync(f.outputPath), false);
    const absent = join(tmpdir(), `synthetic-absent-${randomUUID()}.sqlite`);
    assert.throws(() => prepareLegacySqliteCopy({ ...f, sourcePath: absent, confirmOfflineSource: true }), /details suppressed/);
    assert.equal(existsSync(absent), false);
    assert.equal(existsSync(f.outputPath), false);
  } finally { f.close(); }
});
