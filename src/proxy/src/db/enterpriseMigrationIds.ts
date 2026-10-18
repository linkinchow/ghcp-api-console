/**
 * `schema_migrations` ids of the multi-enterprise upgrade (design §4.2). SQLite and MySQL record the same ids;
 * `accountGuards` is the SQLite trigger step and the MySQL "drop the temporary default" step.
 */
export const ENTERPRISE_MIGRATION_IDS = {
  createEnterprises: 'enterprise-v1/01-create-proxy-enterprises',
  seedDefault: 'enterprise-v1/02-seed-default',
  accounts: 'enterprise-v1/03-accounts-enterprise',
  accountGuards: 'enterprise-v1/04-accounts-guards',
  initializationsAndStats: 'enterprise-v1/05-initializations-and-stats',
  poolAccounts: 'enterprise-v1/06-pool-accounts',
  poolEvents: 'enterprise-v1/07-pool-events',
  /** MySQL only: `user_pool_settings.config_fingerprint` no longer covers per-enterprise fields. */
  poolConfigFingerprint: 'enterprise-v1/08-pool-config-fingerprint',
} as const;
