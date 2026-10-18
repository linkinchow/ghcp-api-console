import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { serialize } from 'node:v8';
import Database from 'better-sqlite3';
import { canonicalSql } from '../../src/proxy/src/db/mysqlSchema.js';
import { preflightSqlite, type MigrationResult } from './migrate.js';
import { referenceSchema, schemaObjects as objects, type SchemaObject } from './sqlite-schema.js';

const COOLDOWN_DDL = `CREATE TABLE user_pool_catalog_cooldowns (
  caller_id TEXT PRIMARY KEY,
  member_identity TEXT NOT NULL REFERENCES user_pool_accounts(identity),
  expires_at INTEGER NOT NULL
);
CREATE INDEX user_pool_catalog_cooldown_expiry ON user_pool_catalog_cooldowns(expires_at);`;

// Reviewed legacy spelling: recovery columns were present in CREATE TABLE rather
// than appended by ALTER TABLE. Accept these two exact layouts, not arbitrary SQL.
const LEGACY_ACCOUNTS_DDL = `CREATE TABLE user_pool_accounts (
  identity TEXT PRIMARY KEY REFERENCES proxy_accounts(identity) ON DELETE RESTRICT,
  ordinal INTEGER UNIQUE NOT NULL, state TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'new',
  attempt_id TEXT NOT NULL, oauth_attempt_id TEXT, sso_created_at TEXT,
  task_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER NOT NULL,
  cooldown_until INTEGER NOT NULL DEFAULT 0, verified_at INTEGER,
  generation INTEGER NOT NULL DEFAULT 0, reauth_count INTEGER NOT NULL DEFAULT 0,
  reauth_window_at INTEGER NOT NULL DEFAULT 0,
  CHECK(state IN ('provisioning', 'ready', 'cooling', 'failed', 'disabled'))
)`;

export interface LegacyCopyOptions {
  sourcePath: string;
  outputPath: string;
  /** Attests that the standalone source backup has no concurrent writers. */
  confirmOfflineSource: boolean;
}
export interface LegacyCopyResult extends MigrationResult {
  sourceUnchanged: true;
  existingRowsUnchanged: true;
}
export class LegacyCopyError extends Error {}
function requireSafe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new LegacyCopyError(message);
}
function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function standalone(path: string): void {
  requireSafe(!['-wal', '-shm', '-journal'].some(suffix => exists(path + suffix)), 'SQLite sidecars are not supported.');
}
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function schemaKey(object: SchemaObject): string {
  return JSON.stringify([object.name, object.type, object.tbl_name, object.sql === null ? null : canonicalSql(object.sql)]);
}
function tableRows(db: Database.Database, tables: string[]): Map<string, string> {
  return new Map(tables.map(table => {
    const quoted = '"' + table.replaceAll('"', '""') + '"';
    // BigInts and BLOBs retain their exact types/bytes. Sort only for comparison;
    // no row values or hashes are returned or printed.
    const rows = db.prepare(`SELECT * FROM ${quoted}`).raw(true).safeIntegers(true).all();
    const encoded = rows.map(row => serialize(row).toString('hex')).sort();
    return [table, digest(Buffer.from(JSON.stringify(encoded)))];
  }));
}
function requireRowsUnchanged(db: Database.Database, before: Map<string, string>): void {
  const after = tableRows(db, [...before.keys()]);
  requireSafe([...before].every(([name, hash]) => after.get(name) === hash), 'Existing row preservation check failed.');
}
function validateLegacySchema(db: Database.Database): void {
  // The reviewed legacy schema predates both the cooldown table and multi-enterprise: the single-enterprise
  // reference (built only in memory, never on the source image or output) without the cooldown table.
  const wanted = referenceSchema('single-enterprise')
    .filter(object => object.tbl_name !== 'user_pool_catalog_cooldowns');
  const actual = objects(db);
  requireSafe(actual.length === wanted.length && actual.every((object, index) => {
    const match = wanted[index];
    if (schemaKey(object) === schemaKey(match)) return true;
    return object.name === 'user_pool_accounts' && object.type === 'table'
      && object.tbl_name === object.name && match.name === object.name
      && object.sql !== null && canonicalSql(object.sql) === canonicalSql(LEGACY_ACCOUNTS_DDL);
  }), 'Source is not the exact supported missing-cooldown legacy schema.');
}

/**
 * Prepare a NEW standalone copy of the one reviewed missing-cooldown schema.
 * No CLI, network, runtime startup, source-path SQLite connection, or importer
 * relaxation. Source bytes are deserialized into an independent in-memory DB.
 * Any output created before failure is retained but UNAPPROVED; never auto-retry
 * or import that output. Existing paths (including symlinks) are never replaced.
 */
export function prepareLegacySqliteCopy(options: LegacyCopyOptions): LegacyCopyResult {
  let db: Database.Database | undefined;
  let outputDb: Database.Database | undefined;
  let fd: number | undefined;
  try {
    requireSafe(options.confirmOfflineSource === true, 'Explicit offline-source confirmation is required.');
    requireSafe(isAbsolute(options.sourcePath) && isAbsolute(options.outputPath), 'Explicit absolute source and output paths are required.');
    requireSafe(resolve(options.sourcePath) !== resolve(options.outputPath), 'Source and output must be different paths.');
    requireSafe(lstatSync(options.sourcePath).isFile(), 'Source must be a regular standalone backup file.');
    requireSafe(!exists(options.outputPath), 'Output already exists; it will not be overwritten.');
    standalone(options.sourcePath);
    standalone(options.outputPath);
    const source = readFileSync(options.sourcePath);
    const sourceHash = digest(source);
    requireSafe(source.subarray(0, 16).toString() === 'SQLite format 3\0' && source[18] === 1 && source[19] === 1,
      'Source must be a standalone rollback-journal SQLite backup.');
    db = new Database(source);
    db.pragma('foreign_keys = ON');
    validateLegacySchema(db);
    const oldObjects = objects(db);
    const before = tableRows(db, oldObjects.filter(object => object.type === 'table').map(object => object.name));
    const memory = db;
    db.transaction(() => {
      memory.exec(COOLDOWN_DDL);
      requireRowsUnchanged(memory, before); // Includes schema_migrations and sqlite_sequence.
      const after = objects(memory);
      requireSafe(oldObjects.every(object => after.some(candidate => schemaKey(candidate) === schemaKey(object))),
        'Existing schema preservation check failed.');
    }).immediate();
    standalone(options.sourcePath);
    requireSafe(digest(readFileSync(options.sourcePath)) === sourceHash, 'Source changed during copy preparation.');
    standalone(options.outputPath);
    fd = openSync(options.outputPath, 'wx', 0o600);
    writeFileSync(fd, db.serialize());
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    // The unchanged importer checks ALL source shape/data and maintenance gates.
    // Its separate readonly connection sees the committed, standalone new file.
    const result = preflightSqlite(options.outputPath);
    outputDb = new Database(readFileSync(options.outputPath));
    requireRowsUnchanged(outputDb, before);
    requireSafe(result.counts.user_pool_catalog_cooldowns === 0, 'New cooldown table must be empty.');
    standalone(options.sourcePath);
    requireSafe(digest(readFileSync(options.sourcePath)) === sourceHash, 'Source changed during copy preparation.');
    return { ...result, sourceUnchanged: true, existingRowsUnchanged: true };
  } catch (error) {
    const reason = error instanceof LegacyCopyError ? error.message : 'Validation or I/O failed; details suppressed.';
    throw new LegacyCopyError(`${reason} Any newly created output is unapproved and retained; do not import it. No source writes are performed by this helper.`);
  } finally {
    if (fd !== undefined) closeSync(fd);
    outputDb?.close();
    db?.close();
  }
}
