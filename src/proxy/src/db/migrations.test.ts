import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';
import { UserPoolStore } from '../userPool/store.js';
import { readPoolConfig } from '../userPool/config.js';

test('rebuilds legacy accounts without carrying old tokens and is idempotent', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE proxy_accounts (
      identity TEXT PRIMARY KEY,
      sso_user TEXT NOT NULL,
      gh_login TEXT,
      gh_token TEXT,
      gh_token_status TEXT NOT NULL DEFAULT 'missing',
      gh_token_updated_at TEXT,
      copilot_token TEXT,
      copilot_api TEXT,
      copilot_token_expires_at TEXT,
      copilot_token_status TEXT NOT NULL DEFAULT 'missing',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE proxy_request_stats (
      id TEXT PRIMARY KEY,
      identity TEXT NOT NULL,
      gh_login TEXT,
      requested_at TEXT NOT NULL,
      path TEXT NOT NULL,
      model TEXT,
      success INTEGER NOT NULL,
      failure_reason TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_tokens INTEGER
    );
    INSERT INTO proxy_accounts VALUES (
      'alice', 'alice', 'alice_octo', 'legacy-gh-token', 'valid', '2026-01-01T00:00:00.000Z',
      'legacy-copilot-token', 'https://api.githubcopilot.com', '2026-01-01T01:00:00.000Z', 'valid',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO proxy_request_stats (
      id, identity, requested_at, path, success
    ) VALUES ('request-1', 'alice', '2026-01-01T00:00:00.000Z', '/v1/models', 1);
  `);

  runMigrations(db);

  const columns = db.prepare('PRAGMA table_info(proxy_accounts)').all() as Array<{ name: string }>;
  assert.deepEqual(columns.map((column) => column.name), [
    'identity',
    'sso_user',
    'gh_login',
    'copilot_oauth_token',
    'copilot_oauth_status',
    'copilot_oauth_updated_at',
    'copilot_oauth_attempt_id',
    'created_at',
    'updated_at',
  ]);
  assert.deepEqual(
    db.prepare(`
      SELECT identity, sso_user, gh_login, copilot_oauth_token, copilot_oauth_status, copilot_oauth_updated_at
      FROM proxy_accounts
    `).get(),
    {
      identity: 'alice',
      sso_user: 'alice',
      gh_login: 'alice_octo',
      copilot_oauth_token: null,
      copilot_oauth_status: 'missing',
      copilot_oauth_updated_at: null,
    },
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM proxy_request_stats').get() as { count: number }).count, 1);
  assert.deepEqual(db.prepare('SELECT caller_id, lease_id FROM proxy_request_stats').get(), { caller_id: null, lease_id: null });

  db.prepare(`
    UPDATE proxy_accounts
    SET copilot_oauth_token = 'new-oauth-token', copilot_oauth_status = 'valid'
    WHERE identity = 'alice'
  `).run();
  runMigrations(db);
  assert.deepEqual(
    db.prepare('SELECT copilot_oauth_token, copilot_oauth_status FROM proxy_accounts WHERE identity = ?').get('alice'),
    { copilot_oauth_token: 'new-oauth-token', copilot_oauth_status: 'valid' },
  );
  db.close();
});

test('existing OAuth accounts preserve credentials and duplicate identity aliases without implicit pool enrollment', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    db.exec(`
      CREATE TABLE proxy_accounts (
        identity TEXT PRIMARY KEY, sso_user TEXT NOT NULL, gh_login TEXT,
        copilot_oauth_token TEXT, copilot_oauth_status TEXT NOT NULL,
        copilot_oauth_updated_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO proxy_accounts VALUES
        ('legacy.user','legacy.user','legacy-user_test','existing-oauth-token','valid','2026-08-01','2026-07-01','2026-08-01'),
        ('legacy.user@example.test','legacy.user','legacy-user_test','existing-oauth-token','valid','2026-08-02','2026-07-02','2026-08-02');
    `);
    const before = db.prepare('SELECT * FROM proxy_accounts ORDER BY identity').all();
    runMigrations(db);
    runMigrations(db);
    const after = db.prepare('SELECT identity,sso_user,gh_login,copilot_oauth_token,copilot_oauth_status,copilot_oauth_updated_at,created_at,updated_at FROM proxy_accounts ORDER BY identity').all();
    assert.deepEqual(after, before);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='user_pool_accounts'").get(), undefined);
    const pool = new UserPoolStore(db, readPoolConfig({ ACCOUNT_ROUTING_MODE: 'caller-lease',
      POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.example.test', POOL_WARMUP_MODEL: 'test-model', READY_IDLE_TARGET: '0' }));
    assert.equal(pool.counts().total, 0);
    assert.equal(pool.reserve(), undefined);
    assert.deepEqual(db.prepare('SELECT identity,sso_user,gh_login,copilot_oauth_token,copilot_oauth_status,copilot_oauth_updated_at,created_at,updated_at FROM proxy_accounts ORDER BY identity').all(), before);
  } finally { db.close(); }
});
