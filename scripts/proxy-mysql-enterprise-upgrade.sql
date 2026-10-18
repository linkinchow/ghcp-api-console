-- GENERATED FILE: do not edit. Regenerate with
-- `npm --workspace @ghcp/proxy run mysql:enterprise-upgrade-sql`.
--
-- Upgrades a single-enterprise (r4) Proxy MySQL schema to multi-enterprise for MYSQL_AUTO_MIGRATE=false.
-- Back up the database and stop every Proxy replica first. Run once, as an administrator account,
-- against the Proxy database, e.g. `mysql ghcp_proxy < proxy-mysql-enterprise-upgrade.sql`.
-- The statements are not idempotent. If the script stops part way, either restore the backup, or start
-- one Proxy replica with MYSQL_AUTO_MIGRATE=true: it detects the applied statements and finishes the rest.
--
-- The `default` enterprise row is inserted with an empty profile_fingerprint and a placeholder cap.
-- At its next start Proxy completes it from its configuration: fingerprint, the pool cap persisted in
-- user_pool_settings, and the pool member count. It also rewrites the pool configuration fingerprint
-- (step 08). Both need only the runtime privileges; replicas of the previous release then fail to start.
-- No new triggers and no new privileges are required.

-- enterprise-v1/01-create-proxy-enterprises
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

INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('enterprise-v1/01-create-proxy-enterprises', UTC_TIMESTAMP(3));

-- enterprise-v1/02-seed-default
INSERT IGNORE INTO proxy_enterprises (
  id, state, max_accounts, inventory_count, profile_fingerprint, created_at, updated_at
)
SELECT
  'default', 'active', 100, 0, '', now_ms, now_ms
FROM (SELECT (TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000) AS now_ms) AS clock;

INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('enterprise-v1/02-seed-default', UTC_TIMESTAMP(3));

-- enterprise-v1/03-accounts-enterprise
ALTER TABLE proxy_accounts
  ADD COLUMN enterprise_id VARCHAR(32) COLLATE ascii_bin NOT NULL DEFAULT 'default';

ALTER TABLE proxy_accounts
  ADD UNIQUE uq_proxy_accounts_identity_enterprise (identity, enterprise_id);

ALTER TABLE proxy_accounts
  ADD INDEX idx_proxy_accounts_enterprise_updated (enterprise_id, updated_at);

ALTER TABLE proxy_accounts
  ADD CONSTRAINT fk_proxy_accounts_enterprise
  FOREIGN KEY (enterprise_id)
  REFERENCES proxy_enterprises(id) ON DELETE RESTRICT;

INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('enterprise-v1/03-accounts-enterprise', UTC_TIMESTAMP(3));

-- enterprise-v1/04-accounts-guards
ALTER TABLE proxy_accounts
  ALTER COLUMN enterprise_id DROP DEFAULT;

INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('enterprise-v1/04-accounts-guards', UTC_TIMESTAMP(3));

-- enterprise-v1/05-initializations-and-stats
ALTER TABLE proxy_identity_initializations
  ADD COLUMN enterprise_id VARCHAR(32) COLLATE ascii_bin NOT NULL DEFAULT 'default';

ALTER TABLE proxy_identity_initializations
  ADD INDEX idx_proxy_identity_initializations_enterprise (enterprise_id);

ALTER TABLE proxy_identity_initializations
  ALTER COLUMN enterprise_id DROP DEFAULT;

ALTER TABLE proxy_request_stats
  ADD COLUMN enterprise_id VARCHAR(32) COLLATE ascii_bin NOT NULL DEFAULT 'default';

ALTER TABLE proxy_request_stats
  ADD INDEX idx_proxy_request_stats_enterprise_time (enterprise_id, requested_at DESC, id DESC),
  ALGORITHM=INPLACE,
  LOCK=NONE;

ALTER TABLE proxy_request_stats
  ALTER COLUMN enterprise_id DROP DEFAULT;

INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('enterprise-v1/05-initializations-and-stats', UTC_TIMESTAMP(3));

-- User pool tables. Skip this section if the database has no user_pool_accounts table; the pool section
-- of proxy-mysql-initial.sql creates the final tables if the pool is enabled later.

-- enterprise-v1/06-pool-accounts
ALTER TABLE user_pool_accounts
  ADD COLUMN enterprise_id VARCHAR(32) COLLATE ascii_bin NOT NULL DEFAULT 'default';

ALTER TABLE user_pool_accounts
  ADD INDEX idx_user_pool_accounts_enterprise_state (enterprise_id, state);

ALTER TABLE user_pool_accounts
  ADD INDEX idx_user_pool_accounts_member_enterprise (identity, enterprise_id);

ALTER TABLE user_pool_accounts
  ADD CONSTRAINT fk_user_pool_account_enterprise
  FOREIGN KEY (identity, enterprise_id)
  REFERENCES proxy_accounts(identity, enterprise_id) ON DELETE RESTRICT;

ALTER TABLE user_pool_accounts
  ALTER COLUMN enterprise_id DROP DEFAULT;

INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('enterprise-v1/06-pool-accounts', UTC_TIMESTAMP(3));

-- enterprise-v1/07-pool-events
ALTER TABLE user_pool_events
  ADD COLUMN enterprise_id VARCHAR(32) COLLATE ascii_bin;

UPDATE user_pool_events
SET enterprise_id = 'default'
WHERE enterprise_id IS NULL;

ALTER TABLE user_pool_events
  ADD INDEX idx_user_pool_events_enterprise (enterprise_id, at, id);

INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('enterprise-v1/07-pool-events', UTC_TIMESTAMP(3));
