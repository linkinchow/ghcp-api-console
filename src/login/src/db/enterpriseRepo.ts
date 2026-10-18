import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson, nowIso, type EnterpriseId, type EnterpriseProfile } from '@ghcp/shared';

/** What storage needs to create or verify a `login_enterprises` row (design §4.4). */
export interface LoginEnterpriseSeed {
  id: EnterpriseId;
  /** sha256 of the canonical `{ id, githubBaseUrl, slug }`; the slug only counts on GHE.com. */
  fingerprint: string;
}

export type EnterpriseIdentityErrorCode = 'enterprise_identity_changed' | 'enterprise_missing_from_registry';

/** Startup failure of design §3.6; the message carries the code so logs show it without a stack walk. */
export class EnterpriseIdentityError extends Error {
  constructor(readonly code: EnterpriseIdentityErrorCode, readonly enterpriseId: string, detail: string) {
    super(`${code}: enterprise "${enterpriseId}" ${detail}`);
    this.name = 'EnterpriseIdentityError';
  }
}

export const CREATE_LOGIN_ENTERPRISES_SQL = `
  CREATE TABLE IF NOT EXISTS login_enterprises (
    id TEXT NOT NULL PRIMARY KEY,
    profile_fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`;

interface EnterpriseRow {
  id: string;
  profile_fingerprint: string;
}

export function loginEnterpriseSeed(profile: EnterpriseProfile): LoginEnterpriseSeed {
  return { id: profile.id, fingerprint: loginProfileFingerprint(profile) };
}

/**
 * Login uses the slug only on GHE.com (enterprise SSO entry). On github.com it is ignored, so adding or changing it
 * there must not look like an identity change (r4 Login often ran without ENTERPRISE_SLUG). Slugs are
 * case-insensitive, so the slug is hashed in lower case.
 */
export function loginProfileFingerprint(profile: EnterpriseProfile): string {
  const slug = profile.github.isGheCom ? profile.github.slug?.toLowerCase() ?? null : null;
  const identity = { id: profile.id, githubBaseUrl: profile.github.baseUrl, slug };
  return createHash('sha256').update(canonicalJson(identity)).digest('hex');
}

/** Inserts the enterprise row when missing; returns whether it was inserted. */
export function insertEnterpriseIfMissing(db: Database.Database, seed: LoginEnterpriseSeed): boolean {
  return db.prepare(`
    INSERT OR IGNORE INTO login_enterprises (id, profile_fingerprint, created_at)
    VALUES (?, ?, ?)
  `).run(seed.id, seed.fingerprint, nowIso()).changes === 1;
}

/**
 * Creates or verifies a row for every registry enterprise, then refuses to start when an enterprise with tasks
 * changed identity or left the registry (design §3.6).
 */
export function syncEnterprises(db: Database.Database, seeds: readonly LoginEnterpriseSeed[]): void {
  for (const seed of seeds) {
    insertEnterpriseIfMissing(db, seed);
    verifyEnterpriseIdentity(db, seed);
  }
  assertNoRemovedEnterpriseWithTasks(db, seeds);
}

/** A fingerprint change is fatal only once the enterprise has tasks; otherwise the row follows the registry. */
export function verifyEnterpriseIdentity(db: Database.Database, seed: LoginEnterpriseSeed): void {
  const row = enterpriseRow(db, seed.id);
  if (!row) throw new Error(`Enterprise "${seed.id}" is missing from login_enterprises.`);
  if (row.profile_fingerprint === seed.fingerprint) return;
  if (hasTasks(db, seed.id)) {
    const detail = 'already has Login tasks, but its GitHub base URL or slug changed. Restore the previous values.';
    throw new EnterpriseIdentityError('enterprise_identity_changed', seed.id, detail);
  }
  db.prepare(`
    UPDATE login_enterprises
    SET profile_fingerprint = ?
    WHERE id = ?
  `).run(seed.fingerprint, seed.id);
}

function assertNoRemovedEnterpriseWithTasks(db: Database.Database, seeds: readonly LoginEnterpriseSeed[]): void {
  const configured = new Set<string>(seeds.map((seed) => seed.id));
  const rows = db.prepare(`
    SELECT id
    FROM login_enterprises
    ORDER BY id
  `).all() as Array<{ id: string }>;
  const removed = rows.find((row) => !configured.has(row.id) && hasTasks(db, row.id));
  if (!removed) return;
  const detail = 'has Login tasks but is missing from the enterprise registry. Restore its registry entry.';
  throw new EnterpriseIdentityError('enterprise_missing_from_registry', removed.id, detail);
}

function enterpriseRow(db: Database.Database, id: string): EnterpriseRow | undefined {
  return db.prepare(`
    SELECT id, profile_fingerprint
    FROM login_enterprises
    WHERE id = ?
  `).get(id) as EnterpriseRow | undefined;
}

function hasTasks(db: Database.Database, id: string): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM login_tasks
    WHERE enterprise_id = ?
    LIMIT 1
  `).get(id);
  return row !== undefined;
}
