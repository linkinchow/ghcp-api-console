import type Database from 'better-sqlite3';
import { EnterpriseContractError } from './enterprise.js';

/** Install only after exhaustive startup validation on this connection. */
export function createEnterpriseSqliteReadinessGuard(db: Database.Database): () => void {
  const snapshot = (): string => JSON.stringify({
    schemaVersion: db.pragma('schema_version', { simple: true }),
    registry: db.prepare('SELECT * FROM enterprise_registry LIMIT 2').all(),
    marker: db.prepare('SELECT * FROM enterprise_schema LIMIT 2').all(),
    profiles: db.prepare('SELECT * FROM enterprise_profiles ORDER BY id LIMIT 101').all(),
  });
  const expected = snapshot();
  return () => {
    if (!db.open) throw new EnterpriseContractError('enterprise_storage_not_ready');
    try {
      if (db.pragma('foreign_keys', { simple: true }) !== 1 || snapshot() !== expected) {
        throw new Error();
      }
    } catch {
      throw new EnterpriseContractError('enterprise_runtime_storage_changed');
    }
  };
}
