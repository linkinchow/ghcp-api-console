import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';

test('existing SSO passwords identities seat metadata and runtime settings survive upgrade', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    db.prepare(`INSERT INTO sso_users
      (sso_user,password_hash,salt,email,role,gh_login,gh_scim_id,emu_status,copilot_seat_status,
       copilot_seat_last_operation,copilot_seat_last_error,copilot_seat_updated_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('legacy.user','test-existing-hash','test-existing-salt','legacy@example.test','user',
        'legacy-user_test','test-scim-id','active','assigned','assign',null,'2026-08-01','2026-07-01','2026-08-01');
    db.prepare("UPDATE sso_runtime_settings SET user_prefix='existing', email_domain='existing.example.test', bulk_sync_concurrency=2, max_sso_users=50, version=7").run();
    const user = db.prepare('SELECT * FROM sso_users').get();
    const settings = db.prepare('SELECT * FROM sso_runtime_settings').get();
    // Model an upgrade from a database that predates pool ownership metadata.
    db.exec('DROP TABLE sso_pool_managed_users');
    runMigrations(db);
    runMigrations(db);
    assert.deepEqual(db.prepare('SELECT * FROM sso_pool_managed_users').all(), []);
    db.pragma('foreign_keys = ON');
    assert.throws(() => db.prepare('INSERT INTO sso_pool_managed_users VALUES (?)').run('missing'), /FOREIGN KEY/);
    db.prepare('INSERT INTO sso_pool_managed_users VALUES (?)').run('legacy.user');
    runMigrations(db);
    assert.deepEqual(db.prepare('SELECT * FROM sso_pool_managed_users').all(), [{ sso_user: 'legacy.user' }]);
    assert.throws(() => db.prepare('DELETE FROM sso_users WHERE sso_user = ?').run('legacy.user'), /FOREIGN KEY/);
    assert.deepEqual(db.prepare('SELECT * FROM sso_users').get(), user);
    assert.deepEqual(db.prepare('SELECT * FROM sso_runtime_settings').get(), settings);
  } finally { db.close(); }
});

test('adds Copilot seat status to existing EMU import plan rows', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE sso_emu_import_plan_rows (
        plan_id TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        sso_user TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        password_for_login TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (plan_id, row_index)
      );
      INSERT INTO sso_emu_import_plan_rows (
        plan_id, row_index, sso_user, status, detail, password_for_login, created_at, updated_at
      ) VALUES ('legacy-plan', 1, 'alice', 'created', 'legacy', 'plaintext-secret', 'now', 'now');
    `);

    runMigrations(db);

    const columns = db.prepare('PRAGMA table_info(sso_emu_import_plan_rows)').all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === 'copilot_seat_status'), true);
    assert.equal(columns.some((column) => column.name === 'password_for_login'), false);
    const settings = db.prepare('SELECT * FROM sso_runtime_settings WHERE id = 1').get() as Record<string, unknown>;
    assert.equal(settings.max_sso_users, null);
    assert.equal(settings.user_prefix, 'user');
    assert.equal(settings.email_domain, 'customsso.com');
    assert.equal(settings.bulk_sync_concurrency, 3);
    assert.equal(settings.scim_request_delay_ms, 250);
    assert.equal(settings.scim_max_retries, 3);
    assert.equal(settings.scim_retry_base_delay_ms, 1000);
    assert.equal(settings.version, 1);

    runMigrations(db);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM sso_runtime_settings').get() as { count: number }).count, 1);
  } finally {
    db.close();
  }
});
