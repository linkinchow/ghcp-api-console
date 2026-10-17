import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export interface ServiceDbOptions {
  /** Overwrite deleted content with zeros (SSO keeps secrets in its database). Default false. */
  secureDelete?: boolean;
  /** Default true. Set explicitly either way: better-sqlite3 builds with foreign keys on. */
  foreignKeys?: boolean;
}

export interface SqliteMigrationStep {
  /** Stable, unique name recorded in `schema_migrations`; never rename an applied step. */
  id: string;
  /** Runs inside the step's own transaction. */
  up: (db: Database.Database) => void;
  /**
   * Turns `foreign_keys` off around the step, which table rebuilds need (the pragma is a no-op
   * inside a transaction). Violations are still checked before the step commits.
   */
  disableForeignKeys?: boolean;
}

export interface SqliteTableRebuild {
  table: string;
  /** Builds the CREATE TABLE statement for the given (temporary) table name. */
  createSql: (tableName: string) => string;
  /** Columns copied by name; new columns take their DEFAULT. */
  copyColumns: readonly string[];
  /** Run after the rename, e.g. CREATE INDEX / CREATE TRIGGER (dropped with the old table). */
  afterSql?: readonly string[];
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Opens a service database the way SSO and Login do: parent directory created, WAL, pragmas. */
export function openServiceDb(path: string, options: ServiceDbOptions = {}): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma(`secure_delete = ${options.secureDelete ? 'ON' : 'OFF'}`);
    db.pragma(`foreign_keys = ${(options.foreignKeys ?? true) ? 'ON' : 'OFF'}`);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * Applies `steps` in order, skipping ids already recorded in `schema_migrations`. Each step and its
 * record commit together under an immediate (write-locked) transaction, so a failed step leaves no
 * trace and concurrent openers cannot apply the same step twice. Returns the ids applied now.
 */
export function runSqliteMigrations(db: Database.Database, steps: readonly SqliteMigrationStep[]): string[] {
  assertUniqueStepIds(steps);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const applied: string[] = [];
  for (const step of steps) {
    if (applyStep(db, step)) applied.push(step.id);
  }
  return applied;
}

export function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): boolean {
  if (hasColumn(db, table, column)) return false;
  db.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${definition}`);
  return true;
}

/**
 * SQLite's documented table rebuild: create `<table>_rebuild`, copy, drop the old table, rename.
 * Runs in a transaction (a savepoint when nested). With `foreign_keys` ON, dropping a parent would
 * cascade into its children, so the pragma is switched off around the rebuild; that is impossible
 * inside an open transaction, so callers there must use a step with `disableForeignKeys`.
 */
export function rebuildSqliteTable(db: Database.Database, rebuild: SqliteTableRebuild): void {
  if (!foreignKeysEnabled(db)) {
    db.transaction(() => rebuildTable(db, rebuild))();
    return;
  }
  if (db.inTransaction) throw new Error('rebuildSqliteTable needs foreign_keys OFF inside a transaction');
  withForeignKeysOff(db, () => {
    db.transaction(() => {
      rebuildTable(db, rebuild);
      assertNoForeignKeyViolations(db);
    })();
  });
}

function applyStep(db: Database.Database, step: SqliteMigrationStep): boolean {
  const run = db.transaction(() => {
    if (isApplied(db, step.id)) return false;
    step.up(db);
    if (step.disableForeignKeys) assertNoForeignKeyViolations(db);
    db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(step.id, new Date().toISOString());
    return true;
  });
  if (!step.disableForeignKeys || !foreignKeysEnabled(db)) return run.immediate();
  return withForeignKeysOff(db, () => run.immediate());
}

function isApplied(db: Database.Database, id: string): boolean {
  return db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(id) !== undefined;
}

function rebuildTable(db: Database.Database, rebuild: SqliteTableRebuild): void {
  const table = quoteIdentifier(rebuild.table);
  const temporary = quoteIdentifier(`${rebuild.table}_rebuild`);
  const columns = rebuild.copyColumns.map(quoteIdentifier).join(', ');
  db.exec(`DROP TABLE IF EXISTS ${temporary}`);
  db.exec(rebuild.createSql(temporary));
  db.exec(`
    INSERT INTO ${temporary} (${columns})
    SELECT ${columns}
    FROM ${table}
  `);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${temporary} RENAME TO ${table}`);
  for (const sql of rebuild.afterSql ?? []) db.exec(sql);
}

function withForeignKeysOff<T>(db: Database.Database, action: () => T): T {
  db.pragma('foreign_keys = OFF');
  try {
    return action();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function foreignKeysEnabled(db: Database.Database): boolean {
  return db.pragma('foreign_keys', { simple: true }) === 1;
}

function assertNoForeignKeyViolations(db: Database.Database): void {
  const violations = db.pragma('foreign_key_check') as Array<{ table: string; parent: string }>;
  if (violations.length === 0) return;
  const first = violations[0]!;
  throw new Error(`foreign key violation: ${first.table} -> ${first.parent} (${violations.length} rows)`);
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function quoteIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`invalid SQL identifier: ${name}`);
  return `"${name}"`;
}

function assertUniqueStepIds(steps: readonly SqliteMigrationStep[]): void {
  const ids = new Set<string>();
  for (const step of steps) {
    if (!step.id || ids.has(step.id)) throw new Error(`invalid or duplicate migration id: ${step.id}`);
    ids.add(step.id);
  }
}
