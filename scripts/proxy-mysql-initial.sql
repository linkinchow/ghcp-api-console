-- GENERATED FILE: do not edit. Regenerate with `npm --workspace @ghcp/proxy run mysql:initial-sql`.
-- Prepares the Proxy MySQL schema for MYSQL_AUTO_MIGRATE=false. Run as an administrator account.
--
-- Runtime account privileges on this database:
--   SELECT, INSERT, UPDATE, DELETE
--   plus TRIGGER on proxy_accounts when the user pool is enabled (caller-lease mode):
--   MySQL only shows trigger metadata to accounts holding TRIGGER, and Proxy verifies the
--   credential fence trigger at startup.
--
-- The `default` row of proxy_enterprises is not created here: its identity fingerprint and cap
-- come from the deployment configuration. Proxy inserts it at its first start (INSERT only).

CREATE DATABASE IF NOT EXISTS ghcp_proxy
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE ghcp_proxy;

-- If the database already exists, start here.
CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `id` VARCHAR(191) COLLATE utf8mb4_bin,
  `applied_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `proxy_enterprises` (
  `id` VARCHAR(32) COLLATE ascii_bin,
  `state` VARCHAR(16) COLLATE ascii_bin NOT NULL,
  `max_accounts` INT NOT NULL,
  `inventory_count` INT NOT NULL DEFAULT 0,
  `policy_version` INT NOT NULL DEFAULT 1,
  `profile_fingerprint` CHAR(64) COLLATE ascii_bin NOT NULL,
  `created_at` BIGINT NOT NULL,
  `updated_at` BIGINT NOT NULL,
  PRIMARY KEY (`id`),
  CHECK (state IN ('draft', 'active', 'draining')),
  CHECK (max_accounts BETWEEN 1 AND 10000),
  CHECK (inventory_count >= 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `proxy_accounts` (
  `identity` VARCHAR(255) COLLATE utf8mb4_bin,
  `sso_user` VARCHAR(255) NOT NULL,
  `gh_login` VARCHAR(255),
  `copilot_oauth_token` TEXT COLLATE utf8mb4_bin,
  `copilot_oauth_status` VARCHAR(32) NOT NULL DEFAULT 'missing',
  `copilot_oauth_updated_at` DATETIME(3),
  `copilot_oauth_attempt_id` CHAR(36) COLLATE ascii_bin,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `enterprise_id` VARCHAR(32) COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (`identity`),
  UNIQUE uq_proxy_accounts_identity_enterprise (identity, enterprise_id),
  CONSTRAINT fk_proxy_accounts_enterprise FOREIGN KEY (enterprise_id) REFERENCES proxy_enterprises(id) ON DELETE RESTRICT,
  INDEX idx_proxy_accounts_sso_user (sso_user),
  INDEX idx_proxy_accounts_updated_at (updated_at),
  INDEX idx_proxy_accounts_enterprise_updated (enterprise_id, updated_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `proxy_request_stats` (
  `id` VARCHAR(64) COLLATE ascii_bin,
  `identity` VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  `gh_login` VARCHAR(255),
  `requested_at` DATETIME(3) NOT NULL,
  `path` VARCHAR(128) NOT NULL,
  `model` VARCHAR(255),
  `success` TINYINT(1) NOT NULL,
  `failure_reason` TEXT,
  `input_tokens` BIGINT,
  `output_tokens` BIGINT,
  `cache_tokens` BIGINT,
  `cache_input_tokens` BIGINT,
  `cache_write_tokens` BIGINT,
  `caller_id` VARCHAR(71) COLLATE ascii_bin,
  `lease_id` CHAR(36) COLLATE ascii_bin,
  `enterprise_id` VARCHAR(32) COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (`id`),
  INDEX idx_proxy_request_stats_identity_time (identity, requested_at DESC, id DESC),
  INDEX idx_proxy_request_stats_time (requested_at DESC, id DESC),
  INDEX idx_proxy_request_stats_enterprise_time (enterprise_id, requested_at DESC, id DESC)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `proxy_identity_initializations` (
  `identity` VARCHAR(255) COLLATE utf8mb4_bin,
  `claim_id` CHAR(36) COLLATE ascii_bin NOT NULL,
  `lease_expires_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `enterprise_id` VARCHAR(32) COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (`identity`),
  INDEX idx_proxy_identity_initializations_lease (lease_expires_at),
  INDEX idx_proxy_identity_initializations_enterprise (enterprise_id)
) ENGINE=InnoDB;

INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('2026-08-27-proxy-mysql-initial', UTC_TIMESTAMP(3));
INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('2026-08-27-proxy-token-binary-collation', UTC_TIMESTAMP(3));
INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('enterprise-v1/01-create-proxy-enterprises', UTC_TIMESTAMP(3));
INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('enterprise-v1/03-accounts-enterprise', UTC_TIMESTAMP(3));
INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('enterprise-v1/04-accounts-guards', UTC_TIMESTAMP(3));
INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('enterprise-v1/05-initializations-and-stats', UTC_TIMESTAMP(3));

-- User pool (caller-lease mode). Safe to apply even when the pool is disabled.
CREATE TABLE IF NOT EXISTS `user_pool_settings` (
  `id` TINYINT,
  `version` INT NOT NULL DEFAULT 1,
  `idle_target` INT NOT NULL,
  `max_accounts` INT NOT NULL,
  `lease_seconds` INT NOT NULL,
  `paused` TINYINT NOT NULL DEFAULT 0,
  `next_ordinal` INT NOT NULL DEFAULT 0,
  `account_domain` VARCHAR(253) COLLATE ascii_bin NOT NULL,
  `config_fingerprint` CHAR(64) COLLATE ascii_bin NOT NULL,
  `owner` VARCHAR(36) COLLATE ascii_bin,
  `owner_until` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  CHECK (id = 1),
  CHECK (paused IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `user_pool_accounts` (
  `identity` VARCHAR(255) COLLATE utf8mb4_bin,
  `ordinal` INT NOT NULL,
  `state` VARCHAR(16) COLLATE ascii_bin NOT NULL,
  `stage` VARCHAR(64) COLLATE ascii_bin NOT NULL DEFAULT 'new',
  `attempt_id` VARCHAR(36) COLLATE ascii_bin NOT NULL,
  `oauth_attempt_id` VARCHAR(36) COLLATE ascii_bin,
  `sso_created_at` VARCHAR(64),
  `task_id` VARCHAR(255) COLLATE utf8mb4_bin,
  `attempts` INT NOT NULL DEFAULT 0,
  `retry_at` BIGINT NOT NULL DEFAULT 0,
  `last_error` TEXT,
  `updated_at` BIGINT NOT NULL,
  `cooldown_until` BIGINT NOT NULL DEFAULT 0,
  `verified_at` BIGINT,
  `generation` BIGINT NOT NULL DEFAULT 0,
  `reauth_count` INT NOT NULL DEFAULT 0,
  `reauth_window_at` BIGINT NOT NULL DEFAULT 0,
  `enterprise_id` VARCHAR(32) COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (`identity`),
  UNIQUE (`ordinal`),
  CONSTRAINT fk_user_pool_account FOREIGN KEY (identity) REFERENCES proxy_accounts(identity) ON DELETE RESTRICT,
  CONSTRAINT fk_user_pool_account_enterprise FOREIGN KEY (identity, enterprise_id) REFERENCES proxy_accounts(identity, enterprise_id) ON DELETE RESTRICT,
  INDEX idx_user_pool_pending (state, retry_at, ordinal),
  INDEX idx_user_pool_available (state, updated_at, ordinal),
  INDEX idx_user_pool_cooling (state, cooldown_until),
  INDEX idx_user_pool_verification (state, verified_at),
  INDEX idx_user_pool_accounts_enterprise_state (enterprise_id, state),
  INDEX idx_user_pool_accounts_member_enterprise (identity, enterprise_id),
  CHECK (state IN ('provisioning', 'ready', 'cooling', 'failed', 'disabled'))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `user_pool_leases` (
  `caller_id` VARCHAR(71) COLLATE ascii_bin,
  `member_identity` VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  `lease_id` VARCHAR(36) COLLATE ascii_bin NOT NULL,
  `phase` VARCHAR(16) COLLATE ascii_bin NOT NULL,
  `assigned_at` BIGINT NOT NULL,
  `last_success_at` BIGINT,
  `expires_at` BIGINT NOT NULL,
  PRIMARY KEY (`caller_id`),
  UNIQUE (`member_identity`),
  UNIQUE (`lease_id`),
  CONSTRAINT fk_user_pool_lease_member FOREIGN KEY (member_identity) REFERENCES user_pool_accounts(identity) ON DELETE RESTRICT,
  INDEX idx_user_pool_lease_expiry (expires_at),
  INDEX idx_user_pool_lease_assigned (assigned_at),
  CHECK (phase IN ('provisional', 'active'))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `user_pool_holds` (
  `request_id` VARCHAR(36) COLLATE ascii_bin,
  `lease_id` VARCHAR(36) COLLATE ascii_bin NOT NULL,
  `expires_at` BIGINT NOT NULL,
  `deadline_at` BIGINT NOT NULL,
  `generation` BIGINT NOT NULL,
  PRIMARY KEY (`request_id`),
  CONSTRAINT fk_user_pool_hold_lease FOREIGN KEY (lease_id) REFERENCES user_pool_leases(lease_id) ON DELETE CASCADE,
  INDEX idx_user_pool_hold_lease (lease_id, expires_at),
  INDEX idx_user_pool_hold_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `user_pool_catalog_holds` (
  `request_id` VARCHAR(36) COLLATE ascii_bin,
  `lease_id` VARCHAR(36) COLLATE ascii_bin NOT NULL,
  `caller_id` VARCHAR(71) COLLATE ascii_bin NOT NULL,
  `member_identity` VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  `assigned_at` BIGINT NOT NULL,
  `expires_at` BIGINT NOT NULL,
  `deadline_at` BIGINT NOT NULL,
  `generation` BIGINT NOT NULL,
  PRIMARY KEY (`request_id`),
  UNIQUE (`lease_id`),
  CONSTRAINT fk_user_pool_catalog_member FOREIGN KEY (member_identity) REFERENCES user_pool_accounts(identity) ON DELETE RESTRICT,
  INDEX idx_user_pool_catalog_member (member_identity, expires_at),
  INDEX idx_user_pool_catalog_caller (caller_id, assigned_at),
  INDEX idx_user_pool_catalog_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `user_pool_catalog_cooldowns` (
  `caller_id` VARCHAR(71) COLLATE ascii_bin,
  `member_identity` VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  `expires_at` BIGINT NOT NULL,
  PRIMARY KEY (`caller_id`),
  CONSTRAINT fk_user_pool_cooldown_member FOREIGN KEY (member_identity) REFERENCES user_pool_accounts(identity) ON DELETE RESTRICT,
  INDEX idx_user_pool_catalog_cooldown_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `user_pool_events` (
  `id` BIGINT UNSIGNED AUTO_INCREMENT,
  `at` BIGINT NOT NULL,
  `action` VARCHAR(64) NOT NULL,
  `identity` VARCHAR(255) COLLATE utf8mb4_bin,
  `caller_id` VARCHAR(71) COLLATE ascii_bin,
  `lease_id` VARCHAR(36) COLLATE ascii_bin,
  `detail` TEXT,
  `enterprise_id` VARCHAR(32) COLLATE ascii_bin,
  PRIMARY KEY (`id`),
  INDEX idx_user_pool_event_time (at),
  INDEX idx_user_pool_event_member (identity, id),
  INDEX idx_user_pool_events_enterprise (enterprise_id, at, id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

DELIMITER //
CREATE TRIGGER user_pool_credential_fence AFTER UPDATE ON proxy_accounts FOR EACH ROW BEGIN
  IF NOT (CAST(OLD.copilot_oauth_token AS BINARY) <=> CAST(NEW.copilot_oauth_token AS BINARY))
    OR NOT (CAST(OLD.copilot_oauth_status AS BINARY) <=> CAST(NEW.copilot_oauth_status AS BINARY))
    OR NOT (CAST(OLD.copilot_oauth_attempt_id AS BINARY) <=> CAST(NEW.copilot_oauth_attempt_id AS BINARY))
    OR NOT (OLD.copilot_oauth_updated_at <=> NEW.copilot_oauth_updated_at)
    OR NOT (CAST(OLD.sso_user AS BINARY) <=> CAST(NEW.sso_user AS BINARY))
    OR NOT (CAST(OLD.gh_login AS BINARY) <=> CAST(NEW.gh_login AS BINARY)) THEN
    UPDATE user_pool_accounts SET generation = generation + 1, verified_at = NULL WHERE identity = NEW.identity;
  END IF;
END//
DELIMITER ;

INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('2026-09-12-user-pool-mysql-v1', UTC_TIMESTAMP(3));
INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('enterprise-v1/06-pool-accounts', UTC_TIMESTAMP(3));
INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('enterprise-v1/07-pool-events', UTC_TIMESTAMP(3));
