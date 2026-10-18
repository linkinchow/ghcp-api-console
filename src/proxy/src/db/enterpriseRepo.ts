import type Database from 'better-sqlite3';
import { DEFAULT_ENTERPRISE_ID, type EnterpriseId, type EnterpriseLifecycleState } from '@ghcp/shared';
import type { EnterpriseSeed } from './enterpriseSeed.js';
import type { ProxyEnterpriseRecord } from './storageTypes.js';

interface EnterpriseRow {
  id: string;
  state: EnterpriseLifecycleState;
  max_accounts: number;
  inventory_count: number;
  policy_version: number;
  profile_fingerprint: string;
  created_at: number;
  updated_at: number;
}

/** A `proxy_enterprises.inventory_count` that differed from the actual number of pool members. */
export interface InventoryDrift {
  enterpriseId: EnterpriseId;
  stored: number;
  actual: number;
}

export const CREATE_PROXY_ENTERPRISES_SQL = `
  CREATE TABLE IF NOT EXISTS proxy_enterprises (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    max_accounts INTEGER NOT NULL,
    inventory_count INTEGER NOT NULL DEFAULT 0,
    policy_version INTEGER NOT NULL DEFAULT 1,
    profile_fingerprint TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CONSTRAINT chk_proxy_enterprises_state CHECK (state IN ('draft', 'active', 'draining')),
    CONSTRAINT chk_proxy_enterprises_cap CHECK (max_accounts BETWEEN 1 AND 10000),
    CONSTRAINT chk_proxy_enterprises_inventory CHECK (inventory_count >= 0)
  )
`;

/**
 * Inserts the seeded enterprise when it is missing (design §4.2 step 02). An upgraded single-enterprise pool keeps
 * its persisted cap and starts with its current member count. Returns whether a row was inserted.
 */
export function ensureEnterprise(db: Database.Database, seed: EnterpriseSeed): boolean {
  if (enterpriseRow(db, seed.id)) return false;
  const now = Date.now();
  return db.prepare(`
    INSERT OR IGNORE INTO proxy_enterprises (
      id, state, max_accounts, inventory_count, policy_version, profile_fingerprint, created_at, updated_at
    )
    VALUES (?, 'active', ?, ?, 1, ?, ?, ?)
  `).run(
    seed.id,
    initialCap(db, seed),
    poolMemberCount(db, seed.id),
    seed.fingerprint,
    now,
    now,
  ).changes === 1;
}

/**
 * Fails closed when the enterprise's identity (base URL, shortcode, account domain) changed after it acquired pool
 * members (design §3.6). Without members the stored fingerprint follows the configuration.
 */
export function verifyEnterpriseIdentity(db: Database.Database, seed: EnterpriseSeed): void {
  const row = enterpriseRow(db, seed.id);
  if (!row) throw new Error(`Enterprise "${seed.id}" is missing from proxy_enterprises.`);
  if (row.profile_fingerprint === seed.fingerprint) return;
  if (row.inventory_count > 0) throw identityChanged(seed.id);
  db.prepare(`
    UPDATE proxy_enterprises
    SET profile_fingerprint = ?, updated_at = ?
    WHERE id = ?
  `).run(seed.fingerprint, Date.now(), seed.id);
}

export function listEnterpriseRecords(db: Database.Database): ProxyEnterpriseRecord[] {
  const rows = db.prepare(`
    SELECT *
    FROM proxy_enterprises
    ORDER BY id
  `).all() as EnterpriseRow[];
  return rows.map(toEnterpriseRecord);
}

export function getEnterpriseRecord(db: Database.Database, id: EnterpriseId): ProxyEnterpriseRecord | undefined {
  const row = enterpriseRow(db, id);
  return row ? toEnterpriseRecord(row) : undefined;
}

/** Changes an enterprise's cap; every policy write bumps `policy_version` for compare-and-set editors. */
export function setEnterpriseCap(db: Database.Database, id: EnterpriseId, maxAccounts: number): void {
  const changes = db.prepare(`
    UPDATE proxy_enterprises
    SET max_accounts = ?, policy_version = policy_version + 1, updated_at = ?
    WHERE id = ?
  `).run(maxAccounts, Date.now(), id).changes;
  if (changes !== 1) throw new Error(`Enterprise "${id}" is missing from proxy_enterprises.`);
}

/** N_e += 1, in the caller's transaction, for a newly inserted pool member. */
export function incrementInventory(db: Database.Database, id: EnterpriseId): void {
  const changes = db.prepare(`
    UPDATE proxy_enterprises
    SET inventory_count = inventory_count + 1
    WHERE id = ?
  `).run(id).changes;
  if (changes !== 1) throw new Error(`Enterprise "${id}" is missing from proxy_enterprises.`);
}

/** Recomputes every `inventory_count` from `user_pool_accounts` and returns the corrections. */
export function correctInventoryCounts(db: Database.Database): InventoryDrift[] {
  const drifts = db.prepare(`
    SELECT e.id AS enterpriseId, e.inventory_count AS stored, COUNT(p.identity) AS actual
    FROM proxy_enterprises e
    LEFT JOIN user_pool_accounts p ON p.enterprise_id = e.id
    GROUP BY e.id, e.inventory_count
    HAVING e.inventory_count <> COUNT(p.identity)
    ORDER BY e.id
  `).all() as InventoryDrift[];
  const update = db.prepare(`
    UPDATE proxy_enterprises
    SET inventory_count = ?
    WHERE id = ?
  `);
  for (const drift of drifts) update.run(drift.actual, drift.enterpriseId);
  return drifts;
}

function enterpriseRow(db: Database.Database, id: string): EnterpriseRow | undefined {
  return db.prepare(`
    SELECT *
    FROM proxy_enterprises
    WHERE id = ?
  `).get(id) as EnterpriseRow | undefined;
}

function toEnterpriseRecord(row: EnterpriseRow): ProxyEnterpriseRecord {
  return {
    id: row.id as EnterpriseId,
    state: row.state,
    maxAccounts: row.max_accounts,
    inventoryCount: row.inventory_count,
    policyVersion: row.policy_version,
    profileFingerprint: row.profile_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The single-enterprise pool persisted its cap in `user_pool_settings`; it belongs to `default`. */
function initialCap(db: Database.Database, seed: EnterpriseSeed): number {
  if (seed.id !== DEFAULT_ENTERPRISE_ID || !tableExists(db, 'user_pool_settings')) return seed.maxAccounts;
  const row = db.prepare(`
    SELECT max_accounts
    FROM user_pool_settings
    WHERE id = 1
  `).get() as { max_accounts: number } | undefined;
  return row?.max_accounts ?? seed.maxAccounts;
}

/** Pool members without an enterprise column (or value) predate multi-enterprise and belong to `default`. */
function poolMemberCount(db: Database.Database, id: EnterpriseId): number {
  if (!tableExists(db, 'user_pool_accounts')) return 0;
  if (!hasColumn(db, 'user_pool_accounts', 'enterprise_id')) return id === DEFAULT_ENTERPRISE_ID ? countAll(db) : 0;
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM user_pool_accounts
    WHERE COALESCE(enterprise_id, ?) = ?
  `).get(DEFAULT_ENTERPRISE_ID, id) as { count: number };
  return row.count;
}

function countAll(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM user_pool_accounts').get() as { count: number }).count;
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table'
      AND name = ?
  `).get(table);
  return row !== undefined;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function identityChanged(id: EnterpriseId): Error {
  return new Error(
    `enterprise_identity_changed: enterprise "${id}" already has pool accounts, but its GitHub base URL, `
    + 'shortcode or pool account email domain changed. Restore the previous values.',
  );
}
