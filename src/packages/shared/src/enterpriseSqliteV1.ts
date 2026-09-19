import type Database from 'better-sqlite3';

/** Frozen 8ad76d547c9d067aac79f99391859cc67dcd7b44 DDL. Never import service migrations here. */
export const ENTERPRISE_V1_BASELINE = '8ad76d547c9d067aac79f99391859cc67dcd7b44';
export type EnterpriseLayout = 'direct' | 'pool' | 'sso' | 'login';
export const V1_PROXY_SQL = `
CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE proxy_accounts (
  identity TEXT PRIMARY KEY, sso_user TEXT NOT NULL, gh_login TEXT, copilot_oauth_token TEXT,
  copilot_oauth_status TEXT NOT NULL DEFAULT 'missing', copilot_oauth_updated_at TEXT,
  copilot_oauth_attempt_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE proxy_request_stats (
  id TEXT PRIMARY KEY, identity TEXT NOT NULL, gh_login TEXT, requested_at TEXT NOT NULL,
  path TEXT NOT NULL, model TEXT, success INTEGER NOT NULL, failure_reason TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_tokens INTEGER,
  cache_input_tokens INTEGER, cache_write_tokens INTEGER
);
CREATE INDEX idx_proxy_request_stats_identity_time ON proxy_request_stats(identity, requested_at DESC);
ALTER TABLE proxy_request_stats ADD COLUMN caller_id TEXT;
ALTER TABLE proxy_request_stats ADD COLUMN lease_id TEXT;
CREATE TABLE proxy_identity_initializations (
  identity TEXT PRIMARY KEY, claim_id TEXT NOT NULL, lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_proxy_identity_initializations_lease ON proxy_identity_initializations(lease_expires_at);
`;
export const V1_POOL_SQL = `
CREATE TABLE user_pool_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL DEFAULT 1,
  idle_target INTEGER NOT NULL, max_accounts INTEGER NOT NULL, lease_seconds INTEGER NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0, next_ordinal INTEGER NOT NULL DEFAULT 0,
  account_domain TEXT NOT NULL, owner TEXT, owner_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE user_pool_accounts (
  identity TEXT PRIMARY KEY REFERENCES proxy_accounts(identity) ON DELETE RESTRICT,
  ordinal INTEGER UNIQUE NOT NULL, state TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'new',
  attempt_id TEXT NOT NULL, oauth_attempt_id TEXT, sso_created_at TEXT,
  task_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, updated_at INTEGER NOT NULL, cooldown_until INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER, generation INTEGER NOT NULL DEFAULT 0,
  CHECK(state IN ('provisioning', 'ready', 'cooling', 'failed', 'disabled'))
);
CREATE TABLE user_pool_leases (
  caller_id TEXT PRIMARY KEY, member_identity TEXT UNIQUE NOT NULL REFERENCES user_pool_accounts(identity),
  lease_id TEXT UNIQUE NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('provisional', 'active')),
  assigned_at INTEGER NOT NULL, last_success_at INTEGER, expires_at INTEGER NOT NULL
);
CREATE TABLE user_pool_holds (
  request_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL REFERENCES user_pool_leases(lease_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT -1
);
CREATE INDEX user_pool_holds_lease ON user_pool_holds(lease_id, expires_at);
CREATE TABLE user_pool_catalog_holds (
  request_id TEXT PRIMARY KEY, lease_id TEXT UNIQUE NOT NULL, caller_id TEXT NOT NULL,
  member_identity TEXT NOT NULL REFERENCES user_pool_accounts(identity), assigned_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL, generation INTEGER NOT NULL
);
CREATE INDEX user_pool_catalog_member ON user_pool_catalog_holds(member_identity, expires_at);
CREATE INDEX user_pool_catalog_caller ON user_pool_catalog_holds(caller_id);
CREATE TABLE user_pool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL,
  identity TEXT, caller_id TEXT, lease_id TEXT, detail TEXT
);
ALTER TABLE user_pool_accounts ADD COLUMN reauth_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_pool_accounts ADD COLUMN reauth_window_at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE user_pool_catalog_cooldowns (
  caller_id TEXT PRIMARY KEY, member_identity TEXT NOT NULL REFERENCES user_pool_accounts(identity), expires_at INTEGER NOT NULL
);
CREATE INDEX user_pool_catalog_cooldown_expiry ON user_pool_catalog_cooldowns(expires_at);
CREATE TRIGGER user_pool_credential_fence
  AFTER UPDATE OF copilot_oauth_token, copilot_oauth_status, copilot_oauth_attempt_id,
    copilot_oauth_updated_at, sso_user, gh_login ON proxy_accounts
  WHEN OLD.copilot_oauth_token IS NOT NEW.copilot_oauth_token
    OR OLD.copilot_oauth_status IS NOT NEW.copilot_oauth_status
    OR OLD.copilot_oauth_attempt_id IS NOT NEW.copilot_oauth_attempt_id
    OR OLD.copilot_oauth_updated_at IS NOT NEW.copilot_oauth_updated_at
    OR OLD.sso_user IS NOT NEW.sso_user OR OLD.gh_login IS NOT NEW.gh_login
  BEGIN
    UPDATE user_pool_accounts SET generation = generation + 1, verified_at = NULL WHERE identity = NEW.identity;
  END;
`;
export const V1_SSO_SQL = `
CREATE TABLE sso_users (
  sso_user TEXT PRIMARY KEY, password_hash TEXT NOT NULL, salt TEXT NOT NULL, email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', gh_login TEXT, gh_scim_id TEXT,
  emu_status TEXT NOT NULL DEFAULT 'not_synced', copilot_seat_status TEXT NOT NULL DEFAULT 'unknown',
  copilot_seat_last_operation TEXT, copilot_seat_last_error TEXT, copilot_seat_updated_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE sso_pool_managed_users (sso_user TEXT PRIMARY KEY REFERENCES sso_users(sso_user) ON DELETE RESTRICT);
CREATE TABLE sso_runtime_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), max_sso_users INTEGER, user_prefix TEXT NOT NULL,
  email_domain TEXT NOT NULL, bulk_sync_concurrency INTEGER NOT NULL, scim_request_delay_ms INTEGER NOT NULL,
  scim_max_retries INTEGER NOT NULL, scim_retry_base_delay_ms INTEGER NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE sso_budget_cache (
  period_key TEXT PRIMARY KEY, year INTEGER NOT NULL, month INTEGER NOT NULL, quantity REAL NOT NULL DEFAULT 0,
  unit_type TEXT, raw_json TEXT NOT NULL, fetched_at TEXT NOT NULL
);
CREATE TABLE sso_emu_import_plans (
  id TEXT PRIMARY KEY, sso_user TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, applied_at TEXT
);
CREATE TABLE sso_emu_import_plan_rows (
  plan_id TEXT NOT NULL, row_index INTEGER NOT NULL, sso_user TEXT NOT NULL, email TEXT, gh_login TEXT,
  gh_scim_id TEXT, emu_status TEXT, copilot_seat_status TEXT, status TEXT NOT NULL, detail TEXT NOT NULL,
  action TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, row_index), FOREIGN KEY (plan_id) REFERENCES sso_emu_import_plans(id) ON DELETE CASCADE
);
CREATE INDEX idx_sso_emu_import_plan_rows_status ON sso_emu_import_plan_rows (plan_id, status, row_index);
`;
export const V1_LOGIN_SQL = `
CREATE TABLE login_tasks (
  id TEXT PRIMARY KEY, identity TEXT NOT NULL, sso_user TEXT NOT NULL, gh_login TEXT, oauth_attempt_id TEXT,
  sso_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT, log_path TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
CREATE INDEX idx_login_tasks_status_created_at ON login_tasks(status, created_at);
CREATE TABLE login_runtime_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), concurrency INTEGER NOT NULL DEFAULT 1 CHECK (concurrency BETWEEN 1 AND 20),
  auth_timeout_ms INTEGER NOT NULL DEFAULT 60000 CHECK (auth_timeout_ms BETWEEN 5000 AND 600000),
  auth_debug_logs INTEGER NOT NULL DEFAULT 0 CHECK (auth_debug_logs IN (0, 1)),
  auth_debug_artifacts INTEGER NOT NULL DEFAULT 0 CHECK (auth_debug_artifacts IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1), updated_at TEXT NOT NULL
) STRICT;
`;

export function createEnterpriseV1SqliteSchema(db: Database.Database, layout: EnterpriseLayout): void {
  if (layout === 'direct' || layout === 'pool') db.exec(V1_PROXY_SQL);
  if (layout === 'pool') db.exec(V1_POOL_SQL);
  if (layout === 'sso') db.exec(V1_SSO_SQL);
  if (layout === 'login') db.exec(V1_LOGIN_SQL);
}

export function enterpriseOwnedTables(layout: EnterpriseLayout): readonly string[] {
  return layout === 'direct' || layout === 'pool' ? ['proxy_accounts'] : layout === 'login' ? ['login_tasks']
    : ['sso_users', 'sso_pool_managed_users', 'sso_runtime_settings', 'sso_budget_cache', 'sso_emu_import_plans', 'sso_emu_import_plan_rows'];
}
