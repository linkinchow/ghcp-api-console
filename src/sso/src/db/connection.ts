import { existsSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { EnterpriseRegistryV3 } from '@ghcp/shared';
import { EnterpriseContractError } from '@ghcp/shared';
import { validateEnterpriseSqliteV3 } from '@ghcp/shared/enterpriseStorageV3';
import { createEnterpriseSqliteReadinessGuard } from '@ghcp/shared/enterpriseSqliteReadiness';
import { config, readConfiguredEnterpriseRegistry } from '../config.js';

let db: Database.Database | undefined;
let registry: EnterpriseRegistryV3 | undefined;
let readinessGuard: (() => void) | undefined;

export function getDb(): Database.Database {
  if (db?.open) return db;
  db = undefined;
  registry = undefined;
  readinessGuard = undefined;
  const expected = readConfiguredEnterpriseRegistry();
  // Validation must precede any journal mode change or application write.
  if (!existsSync(config.dbPath)) throw new EnterpriseContractError('enterprise_init_required');
  if (hasBytes(`${config.dbPath}-journal`) || (hasBytes(`${config.dbPath}-wal`) && !existsSync(`${config.dbPath}-shm`))) {
    throw new EnterpriseContractError('enterprise_offline_snapshot_required');
  }
  const probe = new Database(config.dbPath, { readonly: true, fileMustExist: true });
  try {
    probe.pragma('foreign_keys = ON');
    validateEnterpriseSqliteV3(probe, 'sso', expected);
  } finally { probe.close(); }
  const candidate = new Database(config.dbPath, { fileMustExist: true });
  try {
    candidate.pragma('foreign_keys = ON');
    validateEnterpriseSqliteV3(candidate, 'sso', expected);
    candidate.pragma('journal_mode = WAL');
    candidate.pragma('secure_delete = ON');
    readinessGuard = createEnterpriseSqliteReadinessGuard(candidate);
    // This is the immutable trusted registry, not a mutable current-enterprise slot.
    registry = expected;
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
  if (!db?.open || !registry || !readinessGuard) throw new EnterpriseContractError('enterprise_storage_not_ready');
  readinessGuard();
  return registry;
}

function hasBytes(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0;
}
