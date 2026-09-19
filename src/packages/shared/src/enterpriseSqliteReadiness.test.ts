import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createEnterpriseSqliteReadinessGuard } from './enterpriseSqliteReadiness.js';

function fixture(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE enterprise_schema(singleton INTEGER PRIMARY KEY, state TEXT);
    CREATE TABLE enterprise_registry(singleton INTEGER PRIMARY KEY, registry_revision INTEGER);
    CREATE TABLE enterprise_profiles(id TEXT PRIMARY KEY, profile_json TEXT);
    CREATE TABLE business_history(id INTEGER PRIMARY KEY, value TEXT);
    INSERT INTO enterprise_schema VALUES(1,'complete');
    INSERT INTO enterprise_registry VALUES(1,1);
    INSERT INTO enterprise_profiles VALUES('a','synthetic');`);
  return db;
}

test('readiness guard does not inspect growing business history or run integrity scans', t => {
  const db = fixture();
  t.after(() => db.close());
  const guard = createEnterpriseSqliteReadinessGuard(db);
  db.exec("INSERT INTO business_history(value) VALUES('allowed runtime write')");
  const sql: string[] = [];
  const prepare = db.prepare.bind(db), pragma = db.pragma.bind(db);
  t.mock.method(db, 'prepare', (query: string) => { sql.push(query); return prepare(query); });
  t.mock.method(db, 'pragma', (query: string, options: {simple?: boolean}) => {
    sql.push(query); return pragma(query, options);
  });
  for (let i = 0; i < 20; i++) guard();
  assert.equal(sql.length, 100);
  assert(sql.every(query => !/business_history|integrity_check|foreign_key_check/i.test(query)));
  assert(sql.filter(query => query.startsWith('SELECT')).every(query => /LIMIT (2|101)$/.test(query)));
});

test('readiness guard rejects schema, marker, registry, profile and FK drift', async t => {
  for (const mutation of [
    'CREATE TABLE unexpected(value TEXT)',
    "UPDATE enterprise_schema SET state='applying'",
    'UPDATE enterprise_registry SET registry_revision=2',
    "UPDATE enterprise_profiles SET profile_json='changed'",
    'PRAGMA foreign_keys=OFF',
  ]) {
    await t.test(mutation, () => {
      const db = fixture();
      try {
        const guard = createEnterpriseSqliteReadinessGuard(db);
        db.exec(mutation);
        assert.throws(guard, /enterprise_runtime_storage_changed/);
      } finally { db.close(); }
    });
  }
});

test('readiness guard never reopens a closed connection', () => {
  const db = fixture(), guard = createEnterpriseSqliteReadinessGuard(db);
  db.close();
  assert.throws(guard, /enterprise_storage_not_ready/);
});
