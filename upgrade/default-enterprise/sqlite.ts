import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { serialize } from 'node:v8';
import Database from 'better-sqlite3';
import type { EnterpriseComponent, EnterpriseProfile } from '../../src/packages/shared/src/enterprise.js';
import {
  checkSqliteIntegrity, completeEnterpriseSqlite, createEnterpriseSqliteSchema, enterpriseSqliteObjects,
  initEnterpriseSqlite, registerEnterpriseSqliteProfile, validateEnterprisePoolSettings,
  validateEnterpriseSqlite, validateEnterpriseV1Sqlite, type EnterpriseLayout, type EnterprisePoolInitSettings,
} from '../../src/packages/shared/src/enterpriseStorage.js';
import { ENTERPRISE_V1_BASELINE, enterpriseOwnedTables } from '../../src/packages/shared/src/enterpriseSqliteV1.js';
import { EnterpriseToolError, enterpriseManifestHash, insist, type EnterpriseManifest, type SqliteService } from './manifest.js';
import { accountName, NAME_CAPACITY } from '../v1-frozen/userPool/names.js';

export interface SqliteToolResult {
  component: EnterpriseComponent; layout: EnterpriseLayout; state: 'initialized' | 'preflight' | 'complete' | 'already-complete' | 'verified';
  counts: Record<string, number>; sourceUnchanged?: true; originalColumnsPreserved?: true;
}
export function sha256(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export function standalone(path: string): void {
  insist(!['-wal', '-shm', '-journal'].some(suffix => exists(path + suffix)), 'sqlite_standalone_backup_required');
}
/** Never opens the source path with SQLite: deserialize a validated standalone image. */
export function readStandaloneSqlite(path: string): { db: Database.Database; sourceSha256: string } {
  standalone(path);
  insist(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'sqlite_regular_backup_required');
  const bytes = readFileSync(path);
  insist(bytes.subarray(0, 16).toString() === 'SQLite format 3\0' && bytes[18] === 1 && bytes[19] === 1, 'sqlite_standalone_backup_required');
  const db = new Database(bytes);
  db.pragma('foreign_keys = ON');
  return { db, sourceSha256: sha256(bytes) };
}
function unchanged(path: string, hash: string): void {
  standalone(path);
  insist(sha256(readFileSync(path)) === hash, 'sqlite_source_changed');
}
function tables(db: Database.Database): string[] {
  return enterpriseSqliteObjects(db).filter(object => object.type === 'table').map(object => object.name);
}
function quote(value: string): string { return '"' + value.replaceAll('"', '""') + '"'; }
function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all() as { name: string }[]).map(row => row.name);
}
function counts(db: Database.Database): Record<string, number> {
  return Object.fromEntries(tables(db).filter(table => !table.startsWith('enterprise_')).map(table => [table,
    (db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get() as { n: number }).n]));
}
/** Type-tagged sorted tuples retain all original values, including BLOB and INTEGER precision. */
function originalRowsHash(db: Database.Database, original: Map<string, string[]>, poolCap?: number): string {
  return sha256(JSON.stringify([...original].map(([table, names]) => {
    const selected = names.map(name => table === 'user_pool_settings' && name === 'max_accounts' && poolCap !== undefined
      ? `${poolCap} AS max_accounts` : quote(name)).join(',');
    const rows = db.prepare(`SELECT ${selected} FROM ${quote(table)}`).raw(true).safeIntegers(true).all();
    return [table, names, rows.map(row => serialize(row).toString('hex')).sort()];
  })));
}
function caseUnique(db: Database.Database, table: string, field: string): void {
  const names = (db.prepare(`SELECT ${quote(field)} AS value FROM ${quote(table)}`).all() as { value: unknown }[]).map(row => row.value);
  insist(names.every(value => typeof value === 'string'), 'sqlite_invalid_identity');
  insist(new Set((names as string[]).map(value => value.normalize('NFKC').toLowerCase())).size === names.length, 'sqlite_case_ambiguous_identity');
}
function noRows(db: Database.Database, sql: string, code: string): void { insist(!db.prepare(sql).get(), code); }
export function preflightSqliteData(db: Database.Database, component: EnterpriseComponent, profile: EnterpriseProfile, layout: EnterpriseLayout): void {
  checkSqliteIntegrity(db);
  // SQLite legacy tables are not all STRICT. Reject stored values that do not
  // obey their declared column affinity before blessing the new schema.
  for (const table of tables(db).filter(name => name !== 'sqlite_sequence')) {
    const fields = db.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string; type: string; notnull: number; pk: number }[];
    for (const field of fields) {
      const identifier = quote(field.name);
      const types = field.type === 'INTEGER' ? "'integer'" : field.type === 'REAL' ? "'real','integer'" : "'text'";
      noRows(db, `SELECT 1 FROM ${quote(table)} WHERE (${identifier} IS NOT NULL AND typeof(${identifier}) NOT IN (${types}))`
        + (field.notnull || field.pk ? ` OR ${identifier} IS NULL` : '') + ' LIMIT 1', 'sqlite_invalid_stored_type');
    }
  }
  if (component === 'proxy') {
    caseUnique(db, 'proxy_accounts', 'identity');
    noRows(db, "SELECT 1 FROM proxy_accounts WHERE copilot_oauth_status NOT IN ('valid','expired','missing','failed') OR copilot_oauth_attempt_id IS NOT NULL LIMIT 1", 'sqlite_pending_oauth');
    noRows(db, "SELECT 1 FROM proxy_accounts WHERE copilot_oauth_status='valid' AND (copilot_oauth_token IS NULL OR length(copilot_oauth_token)=0 OR copilot_oauth_updated_at IS NULL) LIMIT 1", 'sqlite_incomplete_credentials');
    noRows(db, 'SELECT 1 FROM proxy_identity_initializations LIMIT 1', 'sqlite_undrained_initialization_claims');
    if (layout === 'pool') {
      const settings = db.prepare('SELECT * FROM user_pool_settings').all() as (EnterprisePoolInitSettings & { id: number; max_accounts: number })[];
      insist(settings.length === 1 && settings[0].id === 1, 'sqlite_invalid_pool_settings');
      const row = settings[0];
      validateEnterprisePoolSettings(row, row.max_accounts);
      insist(row.account_domain === profile.accountDomain, 'sqlite_pool_domain_mismatch');
      insist(row.paused === 1 && row.owner_until <= Date.now(), 'sqlite_pool_not_quiescent');
      const inventory = db.prepare('SELECT identity,ordinal FROM user_pool_accounts').all() as { identity: string; ordinal: number }[];
      insist(inventory.every(member => Number.isInteger(member.ordinal) && member.ordinal >= 0 && member.ordinal < NAME_CAPACITY
        && member.ordinal < row.next_ordinal && member.identity === accountName(member.ordinal)), 'sqlite_pool_identity_ordinal_invalid');
      noRows(db, `SELECT 1 FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity WHERE a.sso_user<>p.identity
        OR p.attempts<0 OR p.retry_at<0 OR p.updated_at<0 OR p.cooldown_until<0 OR p.generation<0 OR p.reauth_count<0 OR p.reauth_window_at<0
        OR (p.verified_at IS NOT NULL AND p.verified_at<0) LIMIT 1`, 'sqlite_pool_inventory_invalid');
      noRows(db, `SELECT 1 FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity WHERE p.state IN ('ready','cooling')
        AND NOT(p.stage='ready' AND p.verified_at IS NOT NULL AND p.sso_created_at IS NOT NULL AND a.gh_login IS NOT NULL
          AND length(a.gh_login)>0 AND a.copilot_oauth_status='valid') LIMIT 1`, 'sqlite_pool_available_unverified');
      noRows(db, `SELECT 1 FROM user_pool_leases WHERE assigned_at<0 OR expires_at<assigned_at
        OR (phase='active' AND (last_success_at IS NULL OR last_success_at<assigned_at OR last_success_at>expires_at))
        OR (phase='provisional' AND last_success_at IS NOT NULL) LIMIT 1`, 'sqlite_pool_lease_invalid');
      for (const table of ['user_pool_leases', 'user_pool_catalog_cooldowns']) {
        const callers = db.prepare(`SELECT caller_id FROM ${table}`).all() as { caller_id: string }[];
        insist(callers.every(caller => /^sha256:[0-9a-f]{64}$/.test(caller.caller_id)), 'sqlite_pool_caller_invalid');
      }
      noRows(db, `SELECT 1 FROM proxy_request_stats s LEFT JOIN proxy_accounts a ON a.identity=s.identity
        WHERE a.identity IS NULL OR s.success NOT IN (0,1) OR ((s.caller_id IS NULL)<>(s.lease_id IS NULL)) LIMIT 1`, 'sqlite_stats_invalid');
      noRows(db, 'SELECT 1 FROM user_pool_events WHERE id<=0 LIMIT 1', 'sqlite_pool_event_invalid');
      for (const table of ['user_pool_holds', 'user_pool_catalog_holds']) noRows(db, `SELECT 1 FROM ${table} LIMIT 1`, 'sqlite_undrained_holds');
      noRows(db, `SELECT 1 FROM user_pool_accounts WHERE state='provisioning'
        OR stage NOT IN ('new','sso-created','scim-synced','synced','warmup','ready')
        OR lower(coalesce(last_error,'')) LIKE '%ambiguous%' OR lower(coalesce(last_error,'')) LIKE '%unconfirmed%'
        OR lower(coalesce(last_error,'')) LIKE '%stalled%' OR lower(coalesce(last_error,'')) LIKE '%sso_name_conflict%'
        OR lower(coalesce(last_error,'')) LIKE '%oauth_task_invalid%' LIMIT 1`, 'sqlite_pending_external_operation');
      noRows(db, `SELECT 1 FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity
        WHERE (p.task_id IS NOT NULL OR p.oauth_attempt_id IS NOT NULL)
        AND NOT (p.state IN ('ready','cooling') AND p.stage='ready' AND p.verified_at IS NOT NULL
          AND p.sso_created_at IS NOT NULL AND p.task_id IS NOT NULL AND p.oauth_attempt_id IS NOT NULL
          AND a.gh_login IS NOT NULL AND length(a.gh_login)>0 AND a.copilot_oauth_status='valid') LIMIT 1`, 'sqlite_pending_login_evidence');
    }
  } else if (component === 'login') {
    noRows(db, "SELECT 1 FROM login_tasks WHERE status NOT IN ('success','failed','cancelled') LIMIT 1", 'sqlite_pending_login_tasks');
    insist((db.prepare('SELECT COUNT(*) AS n FROM login_runtime_settings WHERE id=1').get() as { n: number }).n === 1, 'sqlite_missing_runtime_settings');
    noRows(db, 'SELECT 1 FROM login_tasks WHERE length(id)=0 OR length(identity)=0 OR length(sso_user)=0 OR attempts<0 LIMIT 1', 'sqlite_invalid_login_task');
  } else {
    caseUnique(db, 'sso_users', 'sso_user');
    insist((db.prepare('SELECT COUNT(*) AS n FROM sso_runtime_settings WHERE id=1').get() as { n: number }).n === 1, 'sqlite_missing_runtime_settings');
    noRows(db, `SELECT 1 FROM sso_runtime_settings WHERE version<1 OR bulk_sync_concurrency<1 OR scim_request_delay_ms<0
      OR scim_max_retries<0 OR scim_retry_base_delay_ms<0 OR (max_sso_users IS NOT NULL AND max_sso_users<1) LIMIT 1`, 'sqlite_invalid_sso_settings');
    noRows(db, 'SELECT 1 FROM sso_users WHERE length(sso_user)=0 OR length(password_hash)=0 OR length(salt)=0 OR length(email)=0 LIMIT 1', 'sqlite_invalid_sso_user');
    noRows(db, "SELECT 1 FROM sso_emu_import_plans WHERE status IN ('applying','running','pending') LIMIT 1", 'sqlite_pending_sso_import');
    noRows(db, "SELECT 1 FROM sso_emu_import_plan_rows WHERE status IN ('applying','running') LIMIT 1", 'sqlite_pending_sso_import');
  }
}
function loadSource(service: SqliteService, profile: EnterpriseProfile): { db: Database.Database; hash: string } {
  insist(service.source && service.backup, 'sqlite_source_backup_required');
  const { db, sourceSha256: hash } = readStandaloneSqlite(service.source);
  try {
    insist(hash === service.backup.sha256, 'sqlite_backup_hash_mismatch');
    const layout = validateEnterpriseV1Sqlite(db, service.component);
    insist(layout === service.layout, 'sqlite_layout_mismatch');
    preflightSqliteData(db, service.component, profile, layout);
    unchanged(service.source, hash);
    return { db, hash };
  } catch (error) { db.close(); throw error; }
}
export function preflightEnterpriseSqlite(service: SqliteService, profile: EnterpriseProfile): SqliteToolResult {
  const { db } = loadSource(service, profile);
  try { return { component: service.component, layout: service.layout, state: 'preflight', counts: counts(db), sourceUnchanged: true }; }
  finally { db.close(); }
}
function exclusiveReserve(path: string): number {
  standalone(path);
  insist(!exists(path), 'sqlite_output_exists');
  return openSync(path, 'wx', 0o600);
}
function flushDatabase(db: Database.Database, fd: number): void {
  writeFileSync(fd, db.serialize());
  fsyncSync(fd);
}
function receipt(db: Database.Database, service: SqliteService, manifest: EnterpriseManifest, hash: string, rowsHash: string): void {
  db.prepare(`INSERT INTO enterprise_migration_receipt
    (singleton,manifest_sha256,source_sha256,backup_reference,baseline,original_columns_sha256) VALUES(1,?,?,?,?,?)`)
    .run(enterpriseManifestHash(manifest), hash, service.backup!.reference, ENTERPRISE_V1_BASELINE, rowsHash);
}
function verifyOriginal(source: Database.Database, target: Database.Database, layout: EnterpriseLayout, cap?: number): string {
  const original = new Map(tables(source).map(table => [table, columns(source, table)]));
  const expected = originalRowsHash(source, original);
  insist(expected === originalRowsHash(target, original, layout === 'pool' ? cap : undefined), 'sqlite_original_columns_changed');
  return expected;
}
export function applyEnterpriseSqlite(service: SqliteService, manifest: EnterpriseManifest): SqliteToolResult {
  const { db: source, hash } = loadSource(service, manifest.profile);
  let target: Database.Database | undefined;
  let fd: number | undefined;
  try {
    if (exists(service.target)) {
      const verified = verifyEnterpriseSqlite(service, manifest);
      return { ...verified, state: 'already-complete' };
    }
    fd = exclusiveReserve(service.target);
    target = new Database(':memory:');
    target.pragma('foreign_keys = ON');
    const cap = service.layout === 'pool' ? (source.prepare('SELECT max_accounts FROM user_pool_settings WHERE id=1').get() as { max_accounts: number }).max_accounts : undefined;
    const output = target;
    target.transaction(() => {
      createEnterpriseSqliteSchema(output, service.layout);
      registerEnterpriseSqliteProfile(output, manifest.profile, cap);
      const pending = new Set(tables(source).filter(table => table !== 'sqlite_sequence'));
      // Dependency order comes from the frozen schema FK graph, never user-provided SQL.
      while (pending.size) {
        const next = [...pending].find(table => (source.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all() as { table: string }[])
          .every(foreign => !pending.has(foreign.table)));
        insist(next, 'sqlite_unsupported_fk_cycle');
        pending.delete(next);
        const names = columns(source, next).filter(name => next !== 'user_pool_settings' || name !== 'max_accounts');
        const owned = enterpriseOwnedTables(service.layout).includes(next);
        const outputNames = owned ? ['enterprise_id', ...names] : names;
        const insert = output.prepare(`INSERT INTO ${quote(next)} (${outputNames.map(quote).join(',')}) VALUES (${outputNames.map(() => '?').join(',')})`);
        const rows = source.prepare(`SELECT ${names.map(quote).join(',')} FROM ${quote(next)}`).raw(true).safeIntegers(true).all() as (string | number | bigint | Buffer | null)[][];
        for (const row of rows) insert.run(...(owned ? [manifest.profile.id, ...row] : row));
      }
      if (tables(source).includes('sqlite_sequence')) {
        output.exec('DELETE FROM sqlite_sequence');
        const seq = source.prepare('SELECT name,seq FROM sqlite_sequence').safeIntegers(true).all() as { name: string; seq: bigint }[];
        for (const row of seq) output.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row.name, row.seq);
      }
      const rowsHash = verifyOriginal(source, output, service.layout, cap);
      checkSqliteIntegrity(output);
      receipt(output, service, manifest, hash, rowsHash);
      completeEnterpriseSqlite(output, service.component, manifest.profile, service.layout);
      validateEnterpriseSqlite(output, service.component, manifest.profile);
    }).immediate();
    unchanged(service.source!, hash);
    flushDatabase(target, fd);
    closeSync(fd); fd = undefined;
    unchanged(service.source!, hash);
    const verified = verifyEnterpriseSqlite(service, manifest);
    return { ...verified, state: 'complete' };
  } catch (error) {
    // A reserved or partially written output remains evidence and is never overwritten.
    throw error instanceof EnterpriseToolError ? error : new EnterpriseToolError('sqlite_apply_failed_output_unapproved');
  } finally { if (fd !== undefined) closeSync(fd); target?.close(); source.close(); }
}
export function verifyEnterpriseSqlite(service: SqliteService, manifest: EnterpriseManifest): SqliteToolResult {
  const { db: target } = readStandaloneSqlite(service.target);
  let source: Database.Database | undefined;
  try {
    const state = validateEnterpriseSqlite(target, service.component, manifest.profile);
    insist(state.layout === service.layout, 'sqlite_layout_mismatch');
    if (service.source) {
      const loaded = loadSource(service, manifest.profile); source = loaded.db;
      const rowsHash = verifyOriginal(source, target, service.layout, state.maxAccounts);
      const receipts = target.prepare('SELECT * FROM enterprise_migration_receipt').all() as Record<string, unknown>[];
      insist(receipts.length === 1 && receipts[0].manifest_sha256 === enterpriseManifestHash(manifest)
        && receipts[0].source_sha256 === loaded.hash && receipts[0].backup_reference === service.backup!.reference
        && receipts[0].baseline === ENTERPRISE_V1_BASELINE && receipts[0].original_columns_sha256 === rowsHash, 'sqlite_receipt_mismatch');
      unchanged(service.source, loaded.hash);
    } else {
      insist((target.prepare('SELECT COUNT(*) n FROM enterprise_migration_receipt').get() as { n: number }).n === 0, 'sqlite_unexpected_migration_receipt');
    }
    return { component: service.component, layout: service.layout, state: 'verified', counts: counts(target),
      ...(service.source ? { sourceUnchanged: true as const, originalColumnsPreserved: true as const } : {}) };
  } finally { source?.close(); target.close(); }
}
export function initEnterpriseSqliteFile(service: SqliteService, manifest: EnterpriseManifest): SqliteToolResult {
  insist(service.source === undefined && service.backup === undefined, 'sqlite_init_cannot_migrate');
  const fd = exclusiveReserve(service.target);
  const db = new Database(':memory:');
  try {
    initEnterpriseSqlite(db, service.component, manifest.profile, { ...service.init, layout: service.layout });
    flushDatabase(db, fd);
    return { ...verifyEnterpriseSqlite(service, manifest), state: 'initialized' };
  } finally { closeSync(fd); db.close(); }
}
export function inspectEnterpriseSqlite(service: SqliteService, profile: EnterpriseProfile): {
  component: EnterpriseComponent; state: 'absent' | 'empty' | 'legacy' | 'complete' | 'unapproved'; layout?: EnterpriseLayout;
} {
  if (!exists(service.target)) return { component: service.component, state: 'absent' };
  let db: Database.Database | undefined;
  try {
    const loaded = readStandaloneSqlite(service.target); db = loaded.db;
    if (enterpriseSqliteObjects(db).length === 0) return { component: service.component, state: 'empty' };
    try {
      const state = validateEnterpriseSqlite(db, service.component, profile);
      return { component: service.component, state: 'complete', layout: state.layout };
    } catch {
      const layout = validateEnterpriseV1Sqlite(db, service.component);
      return { component: service.component, state: 'legacy', layout };
    }
  } catch { return { component: service.component, state: 'unapproved' }; }
  finally { db?.close(); }
}
export function validateAdminsFile(manifest: EnterpriseManifest): { checked: boolean; count?: number; unchanged?: true } {
  if (!manifest.admins) return { checked: false };
  const path = manifest.admins.path;
  insist(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'admins_regular_file_required');
  const bytes = readFileSync(path), hash = sha256(bytes);
  insist(hash === manifest.admins.backup.sha256, 'admins_backup_hash_mismatch');
  let rows: unknown;
  try { rows = JSON.parse(bytes.toString('utf8')); } catch { throw new EnterpriseToolError('admins_invalid_json'); }
  insist(Array.isArray(rows), 'admins_invalid_format');
  const names = new Set<string>();
  for (const row of rows) {
    insist(row && typeof row === 'object' && !Array.isArray(row), 'admins_invalid_format');
    const item = row as Record<string, unknown>;
    insist(Object.keys(item).length === 5 && ['username', 'password_hash', 'salt', 'role', 'enabled'].every(key => Object.hasOwn(item, key))
      && typeof item.username === 'string' && item.username.trim() === item.username && item.username.length > 0
      && typeof item.password_hash === 'string' && /^[0-9a-f]{128}$/.test(item.password_hash)
      && typeof item.salt === 'string' && /^[0-9a-f]{32}$/.test(item.salt)
      && item.role === 'admin' && typeof item.enabled === 'boolean', 'admins_invalid_format');
    insist(!names.has(item.username as string), 'admins_duplicate_username'); names.add(item.username as string);
  }
  insist(rows.some(row => (row as Record<string, unknown>).enabled === true), 'admins_no_recovery_admin');
  insist(sha256(readFileSync(path)) === hash, 'admins_changed');
  return { checked: true, count: rows.length, unchanged: true };
}
