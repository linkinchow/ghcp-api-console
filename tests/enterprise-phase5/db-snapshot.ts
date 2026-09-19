import { serialize } from 'node:v8';
import { readFileSync } from 'node:fs';
import type { Connection } from 'mysql2/promise';
import { insist, sha256 } from './db-gate.js';
export interface MysqlSnapshot { tables: { name: string; columns: { name: string; type: string }[]; hash: string; count: number }[]; eventSequence: string | null }
const q = (s: string) => { insist(/^[a-z_][a-z0-9_]*$/.test(s), 'unsafe_identifier'); return '`' + s + '`'; };
/** SQL HEX preserves byte values; original COLUMN_TYPE tags distinguish numeric/text/NULL. */
export async function snapshotMysql(c: Connection, original?: MysqlSnapshot): Promise<MysqlSnapshot> {
  const [tables] = await c.query<any[]>('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME');
  const result: MysqlSnapshot = { tables: [], eventSequence: null };
  for (const table of original?.tables ?? tables.filter(row => !row.name.startsWith('enterprise_'))) {
    const [metadata] = await c.query<any[]>('SELECT COLUMN_NAME AS name,COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table.name]);
    const columns = original ? (table as MysqlSnapshot['tables'][number]).columns : metadata;
    const [caps] = table.name === 'user_pool_settings' && !metadata.some(row => row.name === 'max_accounts')
      ? await c.query<any[]>(tables.some(row => row.name === 'enterprise_registry')
        ? 'SELECT max_accounts FROM enterprise_profiles WHERE id=(SELECT legacy_enterprise_id FROM enterprise_registry WHERE singleton=1)'
        : 'SELECT max_accounts FROM enterprise_profiles WHERE singleton=1') : [[]];
    // v2 has no registry row, so fall back only to its exact singleton representation.
    const selections = columns.map(col => {
      if (table.name === 'user_pool_settings' && col.name === 'max_accounts' && !metadata.some(row => row.name === col.name)) {
        insist(caps.length === 1 && Number.isInteger(Number(caps[0].max_accounts)), 'original_capacity_not_resolved');
        return `HEX(CAST(${Number(caps[0].max_accounts)} AS BINARY)) AS ${q(col.name)}`;
      }
      insist(metadata.some(row => row.name === col.name && row.type.toLowerCase().replace(/\b(tinyint|int|bigint)\(\d+\)/g, '$1') === col.type.toLowerCase().replace(/\b(tinyint|int|bigint)\(\d+\)/g, '$1')), 'original_column_type_changed');
      return `HEX(CAST(${q(col.name)} AS BINARY)) AS ${q(col.name)}`;
    });
    const [rows] = await c.query<any[]>(`SELECT ${selections.join(',')} FROM ${q(table.name)}`);
    const values = rows.map(row => columns.map(col => row[col.name] === null ? ['null'] : [col.type, row[col.name]])).map(row => JSON.stringify(row)).sort();
    result.tables.push({ name: table.name, columns, hash: sha256(JSON.stringify(values)), count: rows.length });
  }
  if (tables.some(row => row.name === 'user_pool_events')) {
    const [rows] = await c.query<any[]>("SELECT AUTO_INCREMENT AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user_pool_events'");
    result.eventSequence = String(rows[0].n);
  }
  return result;
}
export interface SqliteSnapshot { tables: { name: string; columns: string[]; hash: string; count: number }[] }
export async function snapshotSqlite(file: string, original?: SqliteSnapshot, legacyEnterpriseId?: string): Promise<SqliteSnapshot> {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(readFileSync(file));
  try {
    const result: SqliteSnapshot = { tables: [] };
    const tables = original?.tables ?? db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string; columns?: string[] }[];
    for (const table of tables) {
      const columns = table.columns ?? (db.prepare(`PRAGMA table_xinfo(${q(table.name)})`).all() as any[]).map(row => row.name);
      // New enterprise settings rows are intentionally added by v3. Preserve and
      // compare the ORIGINAL legacy row, never fold new-profile defaults into it.
      const scoped = !!original && table.name === 'sso_runtime_settings'
        && (db.prepare(`PRAGMA table_xinfo(${q(table.name)})`).all() as any[]).some(row => row.name === 'enterprise_id');
      if (scoped) insist(legacyEnterpriseId, 'legacy_settings_scope_required');
      const statement = db.prepare(`SELECT ${columns.map(q).join(',')} FROM ${q(table.name)}${scoped ? ' WHERE enterprise_id=?' : ''}`).raw(true).safeIntegers(true);
      const rows = scoped ? statement.all(legacyEnterpriseId!) : statement.all();
      result.tables.push({ name: table.name, columns, hash: sha256(JSON.stringify(rows.map(row => serialize(row).toString('hex')).sort())), count: rows.length });
    }
    return result;
  } finally { db.close(); }
}
