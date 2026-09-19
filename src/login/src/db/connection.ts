import { existsSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';
import { EnterpriseContractError, resolveEnterpriseScope, type EnterpriseProfileV3, type EnterpriseRegistryV3 } from '@ghcp/shared';
import { validateEnterpriseSqliteV3 } from '@ghcp/shared/enterpriseStorageV3';
import { createEnterpriseSqliteReadinessGuard } from '@ghcp/shared/enterpriseSqliteReadiness';
import { config, readConfiguredEnterpriseRegistry } from '../config.js';

let db: Database.Database | undefined;
let registry: EnterpriseRegistryV3 | undefined;
let assertReadiness: (() => void) | undefined;

export function getDb(): Database.Database {
  if (db?.open) return db;
  db = undefined;
  registry = undefined;
  assertReadiness = undefined;
  const expected = readConfiguredEnterpriseRegistry();
  if (!existsSync(config.dbPath)) throw new EnterpriseContractError('enterprise_init_required');
  if (hasBytes(`${config.dbPath}-journal`) || (hasBytes(`${config.dbPath}-wal`) && !existsSync(`${config.dbPath}-shm`))) {
    throw new EnterpriseContractError('enterprise_offline_snapshot_required');
  }
  // Gate schema3/contract2 before any writable connection, WAL switch or recovery.
  const probe = new Database(config.dbPath, { readonly: true, fileMustExist: true });
  try {
    probe.pragma('foreign_keys = ON');
    validateEnterpriseSqliteV3(probe, 'login', expected);
  } finally { probe.close(); }
  const candidate = new Database(config.dbPath, { fileMustExist: true });
  try {
    candidate.pragma('foreign_keys = ON');
    validateEnterpriseSqliteV3(candidate, 'login', expected);
    candidate.pragma('journal_mode = WAL');
    assertReadiness = createEnterpriseSqliteReadinessGuard(candidate);
    registry = deepFreeze(expected);
    db = candidate;
    return candidate;
  } catch (error) {
    candidate.close();
    throw error;
  }
}

export function getEnterpriseRegistry(): EnterpriseRegistryV3 {
  getDb();
  return registry!;
}

export function getValidatedEnterpriseRegistry(): EnterpriseRegistryV3 {
  if (!db?.open || !registry || !assertReadiness) throw new EnterpriseContractError('enterprise_storage_not_ready');
  assertReadiness();
  return registry;
}

export function getEnterpriseProfile(enterpriseId?: string): EnterpriseProfileV3 {
  return resolveEnterpriseScope(getEnterpriseRegistry(), enterpriseId).profile;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function hasBytes(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0;
}
