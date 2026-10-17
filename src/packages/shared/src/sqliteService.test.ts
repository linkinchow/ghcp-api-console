import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import {
  addColumnIfMissing,
  openServiceDb,
  rebuildSqliteTable,
  runSqliteMigrations,
  type SqliteMigrationStep,
  type SqliteTableRebuild,
} from './sqliteService.js';

function memoryDb(t: TestContext): Database.Database {
  const db = openServiceDb(':memory:');
  t.after(() => db.close());
  return db;
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghcp-sqlite-service-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function appliedIds(db: Database.Database): string[] {
  return (db.prepare('SELECT id FROM schema_migrations ORDER BY rowid').all() as Array<{ id: string }>)
    .map((row) => row.id);
}

function parentChild(db: Database.Database): void {
  db.exec(`
    CREATE TABLE parents (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE children (
      id INTEGER PRIMARY KEY,
      parent_id TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE
    );
    INSERT INTO parents VALUES ('p1', 'one'), ('p2', 'two');
    INSERT INTO children (parent_id) VALUES ('p1'), ('p2'), ('p2');
  `);
}

const PARENT_REBUILD: SqliteTableRebuild = {
  table: 'parents',
  createSql: (name) => `
    CREATE TABLE ${name} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enterprise_id TEXT NOT NULL DEFAULT 'default'
    )
  `,
  copyColumns: ['id', 'name'],
  afterSql: ['CREATE INDEX idx_parents_enterprise ON parents(enterprise_id)'],
};

test('openServiceDb creates the parent directory and applies WAL and pragmas', (t) => {
  const path = join(tempDir(t), 'nested', 'deeper', 'service.db');
  const db = openServiceDb(path, { secureDelete: true });
  try {
    assert.ok(existsSync(path));
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('secure_delete', { simple: true }), 1);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  } finally {
    db.close();
  }
});

test('openServiceDb defaults secure_delete off and can leave foreign keys off', (t) => {
  const db = openServiceDb(join(tempDir(t), 'login.db'), { foreignKeys: false });
  try {
    assert.equal(db.pragma('secure_delete', { simple: true }), 0);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 0);
  } finally {
    db.close();
  }
});

test('migrations run in order once and record their ids', (t) => {
  const db = memoryDb(t);
  const runs: string[] = [];
  const createItems = (d: Database.Database) => {
    runs.push('create');
    d.exec('CREATE TABLE items (id TEXT PRIMARY KEY)');
  };
  const addName = (d: Database.Database) => {
    runs.push('add');
    addColumnIfMissing(d, 'items', 'name', 'TEXT');
  };
  const steps: SqliteMigrationStep[] = [{ id: 'create-items', up: createItems }, { id: 'add-items-name', up: addName }];
  assert.deepEqual(runSqliteMigrations(db, steps), ['create-items', 'add-items-name']);
  assert.deepEqual(runSqliteMigrations(db, steps), []);
  assert.deepEqual(runs, ['create', 'add']);
  assert.deepEqual(appliedIds(db), ['create-items', 'add-items-name']);
  const row = db.prepare('SELECT applied_at FROM schema_migrations LIMIT 1').get() as { applied_at: string };
  assert.ok(!Number.isNaN(Date.parse(row.applied_at)));
});

test('a failing step rolls back alone and the next run resumes from it', (t) => {
  const db = memoryDb(t);
  let fail = true;
  const steps: SqliteMigrationStep[] = [
    { id: 'one', up: (d) => d.exec('CREATE TABLE one (id INTEGER)') },
    {
      id: 'two',
      up: (d) => {
        d.exec('CREATE TABLE two (id INTEGER)');
        if (fail) throw new Error('crash');
      },
    },
    { id: 'three', up: (d) => d.exec('CREATE TABLE three (id INTEGER)') },
  ];
  assert.throws(() => runSqliteMigrations(db, steps), /crash/);
  assert.deepEqual(appliedIds(db), ['one']);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'two'").get(), undefined);
  fail = false;
  assert.deepEqual(runSqliteMigrations(db, steps), ['two', 'three']);
  assert.deepEqual(runSqliteMigrations(db, steps), []);
});

test('migration state survives reopening a file database', (t) => {
  const path = join(tempDir(t), 'service.db');
  const steps: SqliteMigrationStep[] = [{ id: 'create', up: (d) => d.exec('CREATE TABLE items (id INTEGER)') }];
  const first = openServiceDb(path);
  assert.deepEqual(runSqliteMigrations(first, steps), ['create']);
  first.close();
  const second = openServiceDb(path);
  try {
    assert.deepEqual(runSqliteMigrations(second, steps), []);
  } finally {
    second.close();
  }
});

test('duplicate or empty step ids are rejected before anything runs', (t) => {
  const db = memoryDb(t);
  const up = () => assert.fail('must not run');
  assert.throws(() => runSqliteMigrations(db, [{ id: 'a', up }, { id: 'a', up }]), /duplicate/);
  assert.throws(() => runSqliteMigrations(db, [{ id: '', up }]), /invalid/);
});

test('addColumnIfMissing adds once and reports whether it changed the table', (t) => {
  const db = memoryDb(t);
  db.exec('CREATE TABLE items (id TEXT PRIMARY KEY)');
  assert.equal(addColumnIfMissing(db, 'items', 'stage', "TEXT NOT NULL DEFAULT 'new'"), true);
  assert.equal(addColumnIfMissing(db, 'items', 'stage', "TEXT NOT NULL DEFAULT 'new'"), false);
  assert.deepEqual(columns(db, 'items'), ['id', 'stage']);
  assert.throws(() => addColumnIfMissing(db, 'items; DROP TABLE items', 'x', 'TEXT'), /invalid SQL identifier/);
});

test('rebuildSqliteTable keeps rows and does not cascade into child tables', (t) => {
  const db = memoryDb(t);
  parentChild(db);
  rebuildSqliteTable(db, PARENT_REBUILD);
  assert.deepEqual(columns(db, 'parents'), ['id', 'name', 'enterprise_id']);
  assert.deepEqual(db.prepare('SELECT * FROM parents ORDER BY id').all(), [
    { id: 'p1', name: 'one', enterprise_id: 'default' },
    { id: 'p2', name: 'two', enterprise_id: 'default' },
  ]);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM children').get() as { n: number }).n, 3);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_parents_enterprise'").get());
  db.prepare("DELETE FROM parents WHERE id = 'p2'").run();
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM children').get() as { n: number }).n, 1);
});

test('rebuildSqliteTable rolls back on a foreign key violation and restores the pragma', (t) => {
  const db = memoryDb(t);
  parentChild(db);
  const dropping: SqliteTableRebuild = { ...PARENT_REBUILD, afterSql: ["DELETE FROM parents WHERE id = 'p1'"] };
  assert.throws(() => rebuildSqliteTable(db, dropping), /foreign key violation/);
  assert.deepEqual(columns(db, 'parents'), ['id', 'name']);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});

test('rebuildSqliteTable refuses to run in a transaction while foreign keys are on', (t) => {
  const db = memoryDb(t);
  parentChild(db);
  const attempt = db.transaction(() => rebuildSqliteTable(db, PARENT_REBUILD));
  assert.throws(() => attempt(), /foreign_keys OFF/);
  assert.deepEqual(columns(db, 'parents'), ['id', 'name']);
});

test('a migration step with disableForeignKeys can rebuild a parent table', (t) => {
  const db = memoryDb(t);
  parentChild(db);
  const step = { id: 'rebuild-parents', disableForeignKeys: true, up: (d: Database.Database) => {
    rebuildSqliteTable(d, PARENT_REBUILD);
  } };
  assert.deepEqual(runSqliteMigrations(db, [step]), ['rebuild-parents']);
  assert.deepEqual(columns(db, 'parents'), ['id', 'name', 'enterprise_id']);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM children').get() as { n: number }).n, 3);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});

test('a disableForeignKeys step with a violation is rolled back and not recorded', (t) => {
  const db = memoryDb(t);
  parentChild(db);
  const step = { id: 'orphan', disableForeignKeys: true, up: (d: Database.Database) => {
    d.exec("DELETE FROM parents WHERE id = 'p1'");
  } };
  assert.throws(() => runSqliteMigrations(db, [step]), /foreign key violation/);
  assert.deepEqual(appliedIds(db), []);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM parents').get() as { n: number }).n, 2);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});
