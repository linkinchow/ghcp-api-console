import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson, nowIso, type EnterpriseId, type EnterpriseProfile } from '@ghcp/shared';

/** What storage needs to create or verify an `sso_enterprises` row (design §4.3). */
export interface SsoEnterpriseSeed {
  id: EnterpriseId;
  /** sha256 of the canonical `{ id, githubBaseUrl, slug, shortcode }`. */
  fingerprint: string;
  /** Seed values of the enterprise's `sso_runtime_settings` row; used only when that row is first created. */
  userPrefix: string;
  emailDomain: string;
}

export type EnterpriseIdentityErrorCode = 'enterprise_identity_changed' | 'enterprise_missing_from_registry';

/** Startup failure of design §3.6; the message carries the code so logs show it without a stack walk. */
export class EnterpriseIdentityError extends Error {
  constructor(readonly code: EnterpriseIdentityErrorCode, readonly enterpriseId: string, detail: string) {
    super(`${code}: enterprise "${enterpriseId}" ${detail}`);
    this.name = 'EnterpriseIdentityError';
  }
}

/** The baseline seeds of the single runtime settings row. */
export const DEFAULT_USER_PREFIX = 'user';
export const DEFAULT_EMAIL_DOMAIN = 'customsso.com';

export const CREATE_SSO_ENTERPRISES_SQL = `
  CREATE TABLE IF NOT EXISTS sso_enterprises (
    id TEXT NOT NULL PRIMARY KEY,
    profile_fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`;

interface EnterpriseRow {
  id: string;
  profile_fingerprint: string;
}

export function ssoEnterpriseSeed(profile: EnterpriseProfile): SsoEnterpriseSeed {
  return {
    id: profile.id,
    fingerprint: ssoProfileFingerprint(profile),
    userPrefix: profile.sso.userPrefix ?? DEFAULT_USER_PREFIX,
    emailDomain: profile.sso.emailDomain ?? DEFAULT_EMAIL_DOMAIN,
  };
}

/** GitHub slugs are case-insensitive, so the slug is hashed in lower case. */
export function ssoProfileFingerprint(profile: EnterpriseProfile): string {
  const identity = {
    id: profile.id,
    githubBaseUrl: profile.github.baseUrl,
    slug: profile.github.slug?.toLowerCase() ?? null,
    shortcode: profile.github.shortcode ?? null,
  };
  return createHash('sha256').update(canonicalJson(identity)).digest('hex');
}

/** Inserts the enterprise row when missing; returns whether it was inserted. */
export function insertEnterpriseIfMissing(db: Database.Database, seed: SsoEnterpriseSeed): boolean {
  return db.prepare(`
    INSERT OR IGNORE INTO sso_enterprises (id, profile_fingerprint, created_at)
    VALUES (?, ?, ?)
  `).run(seed.id, seed.fingerprint, nowIso()).changes === 1;
}

/**
 * Creates or verifies a row (and a runtime settings row) for every registry enterprise, then refuses to start
 * when an enterprise with users changed identity or left the registry (design §3.6).
 */
export function syncEnterprises(db: Database.Database, seeds: readonly SsoEnterpriseSeed[]): void {
  for (const seed of seeds) {
    insertEnterpriseIfMissing(db, seed);
    verifyEnterpriseIdentity(db, seed);
    insertRuntimeSettingsIfMissing(db, seed);
  }
  assertNoRemovedEnterpriseWithUsers(db, seeds);
}

/** A fingerprint change is fatal only once the enterprise has users; otherwise the row follows the registry. */
export function verifyEnterpriseIdentity(db: Database.Database, seed: SsoEnterpriseSeed): void {
  const row = enterpriseRow(db, seed.id);
  if (!row) throw new Error(`Enterprise "${seed.id}" is missing from sso_enterprises.`);
  if (row.profile_fingerprint === seed.fingerprint) return;
  if (hasUsers(db, seed.id)) {
    const detail = 'already has SSO users, but its GitHub base URL, slug or shortcode changed. '
      + 'Restore the previous values.';
    throw new EnterpriseIdentityError('enterprise_identity_changed', seed.id, detail);
  }
  db.prepare(`
    UPDATE sso_enterprises
    SET profile_fingerprint = ?
    WHERE id = ?
  `).run(seed.fingerprint, seed.id);
}

/** Seeds a runtime settings row with the baseline defaults; existing rows are never overwritten. */
export function insertRuntimeSettingsIfMissing(db: Database.Database, seed: SsoEnterpriseSeed): void {
  db.prepare(`
    INSERT OR IGNORE INTO sso_runtime_settings (
      enterprise_id, max_sso_users, user_prefix, email_domain, bulk_sync_concurrency,
      scim_request_delay_ms, scim_max_retries, scim_retry_base_delay_ms, version, updated_at
    )
    VALUES (?, NULL, ?, ?, 3, 250, 3, 1000, 1, ?)
  `).run(seed.id, seed.userPrefix, seed.emailDomain, nowIso());
}

function assertNoRemovedEnterpriseWithUsers(db: Database.Database, seeds: readonly SsoEnterpriseSeed[]): void {
  const configured = new Set<string>(seeds.map((seed) => seed.id));
  const rows = db.prepare(`
    SELECT id
    FROM sso_enterprises
    ORDER BY id
  `).all() as Array<{ id: string }>;
  const removed = rows.find((row) => !configured.has(row.id) && hasUsers(db, row.id));
  if (!removed) return;
  const detail = 'has SSO users but is missing from the enterprise registry. Restore its registry entry.';
  throw new EnterpriseIdentityError('enterprise_missing_from_registry', removed.id, detail);
}

function enterpriseRow(db: Database.Database, id: string): EnterpriseRow | undefined {
  return db.prepare(`
    SELECT id, profile_fingerprint
    FROM sso_enterprises
    WHERE id = ?
  `).get(id) as EnterpriseRow | undefined;
}

function hasUsers(db: Database.Database, id: string): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM sso_users
    WHERE enterprise_id = ?
    LIMIT 1
  `).get(id);
  return row !== undefined;
}
