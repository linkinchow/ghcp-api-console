import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { canonicalEnterpriseProfile, parseEnterpriseProfile, type EnterpriseComponent, type EnterpriseProfile } from '../../src/packages/shared/src/enterprise.js';
import { enterpriseComponentLayout, validateEnterprisePoolSettings, type EnterpriseInitOptions, type EnterpriseLayout } from '../../src/packages/shared/src/enterpriseStorage.js';

export class EnterpriseToolError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'EnterpriseToolError'; }
}
export function insist(value: unknown, code: string): asserts value {
  if (!value) throw new EnterpriseToolError(code);
}
function record(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  insist(value && typeof value === 'object' && !Array.isArray(value), 'manifest_invalid_object');
  const result = value as Record<string, unknown>;
  insist(required.every(key => Object.hasOwn(result, key)) && Object.keys(result).every(key => [...required, ...optional].includes(key)), 'manifest_unknown_or_missing_field');
  return result;
}
function text(value: unknown, pattern: RegExp, code = 'manifest_invalid_value'): string {
  insist(typeof value === 'string' && pattern.test(value), code);
  return value;
}
function path(value: unknown): string {
  insist(typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f]/.test(value), 'manifest_absolute_path_required');
  return resolve(value);
}
export interface BackupAttestation { reference: string; sha256: string }
export interface SqliteService {
  component: EnterpriseComponent; driver: 'sqlite'; layout: EnterpriseLayout;
  source?: string; target: string; backup?: BackupAttestation; init?: EnterpriseInitOptions;
}
export interface MysqlService {
  component: 'proxy'; driver: 'mysql'; layout: 'direct' | 'pool';
  location: { host: string; port: number; database: string; connectionEnv: string };
  backup?: BackupAttestation; sourceSha256?: string; init?: EnterpriseInitOptions;
}
export interface EnterpriseManifest {
  manifestVersion: 1; baseline: '8ad76d5'; profile: EnterpriseProfile;
  services: [SqliteService | MysqlService, SqliteService, SqliteService];
  attestations: { writersStopped: true; externalOperationsDrained: true; backupVerified: true };
  admins?: { path: string; backup: BackupAttestation };
}
function backup(value: unknown): BackupAttestation {
  const row = record(value, ['reference', 'sha256']);
  return { reference: text(row.reference, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/), sha256: text(row.sha256, /^[a-f0-9]{64}$/) };
}
function initOptions(value: unknown, layout: EnterpriseLayout, profile: EnterpriseProfile, mysql: boolean): EnterpriseInitOptions {
  const row = record(value, [], ['maxAccounts', 'pool']);
  if (layout !== 'pool') { insist(Object.keys(row).length === 0, 'manifest_unexpected_pool_options'); return { layout }; }
  insist(Number.isInteger(row.maxAccounts), 'manifest_invalid_capacity');
  const p = record(row.pool, ['settings'], ['fingerprint']);
  const s = record(p.settings, ['version', 'idle_target', 'lease_seconds', 'paused', 'next_ordinal', 'account_domain', 'owner', 'owner_until']);
  insist(s.account_domain === profile.accountDomain, 'manifest_pool_domain_mismatch');
  const settings = s as unknown as NonNullable<EnterpriseInitOptions['pool']>['settings'];
  validateEnterprisePoolSettings(settings, row.maxAccounts as number);
  insist(settings.owner === null && settings.owner_until === 0 && settings.next_ordinal === 0, 'manifest_init_must_be_empty');
  insist(settings.paused === 1, 'manifest_init_must_remain_paused');
  const fingerprint = p.fingerprint === undefined ? undefined : text(p.fingerprint, /^[0-9a-f]{64}$/);
  insist(!mysql || fingerprint !== undefined, 'manifest_mysql_fingerprint_required');
  return { layout, maxAccounts: row.maxAccounts as number, pool: { settings, ...(fingerprint ? { fingerprint } : {}) } };
}
export function parseEnterpriseManifest(value: unknown): EnterpriseManifest {
  const row = record(value, ['manifestVersion', 'baseline', 'profile', 'services', 'attestations'], ['admins']);
  insist(row.manifestVersion === 1 && row.baseline === '8ad76d5', 'manifest_unsupported_version');
  const profile = parseEnterpriseProfile(row.profile);
  const attestations = record(row.attestations, ['writersStopped', 'externalOperationsDrained', 'backupVerified']);
  insist(Object.values(attestations).every(value => value === true), 'manifest_operator_attestation_required');
  insist(Array.isArray(row.services) && row.services.length === 3, 'manifest_three_services_required');
  const components = new Set<string>();
  const services = row.services.map((value: unknown) => {
    const item = record(value, ['component', 'driver', 'layout'], ['source', 'target', 'backup', 'init', 'location', 'sourceSha256']);
    insist(['proxy', 'sso', 'login'].includes(item.component as string) && !components.has(item.component as string), 'manifest_service_pairing_invalid');
    components.add(item.component as string);
    const component = item.component as EnterpriseComponent;
    const layout = enterpriseComponentLayout(component, item.layout as EnterpriseLayout);
    insist(item.layout === layout, 'manifest_layout_required');
    if (item.driver === 'sqlite') {
      insist(item.location === undefined && item.sourceSha256 === undefined, 'manifest_driver_field_mismatch');
      const target = path(item.target);
      const source = item.source === undefined ? undefined : path(item.source);
      insist(source !== target, 'manifest_source_target_same');
      insist((source === undefined) === (item.backup === undefined), 'manifest_sqlite_backup_required');
      insist(!(source !== undefined && item.init !== undefined), 'manifest_migrate_cannot_seed');
      return { component, driver: 'sqlite', layout, target,
        ...(source ? { source, backup: backup(item.backup) } : {}),
        ...(item.init === undefined ? {} : { init: initOptions(item.init, layout, profile, false) }),
      } as SqliteService;
    }
    insist(item.driver === 'mysql' && component === 'proxy' && ['direct', 'pool'].includes(layout)
      && item.source === undefined && item.target === undefined, 'manifest_driver_not_supported');
    const location = record(item.location, ['host', 'port', 'database', 'connectionEnv']);
    const host = text(location.host, /^(?:[a-zA-Z0-9.-]+|\[::1\])$/);
    insist(Number.isInteger(location.port) && Number(location.port) > 0 && Number(location.port) <= 65535, 'manifest_invalid_mysql_port');
    insist(item.init === undefined ? item.backup !== undefined : item.backup === undefined && item.sourceSha256 === undefined,
      'manifest_mysql_init_migrate_fields');
    return { component: 'proxy', driver: 'mysql', layout: layout as 'direct' | 'pool', location: {
      host, port: location.port as number, database: text(location.database, /^[a-zA-Z0-9_]{1,64}$/),
      connectionEnv: text(location.connectionEnv, /^ENTERPRISE_MYSQL_[A-Z0-9_]+$/),
    }, ...(item.backup === undefined ? {} : { backup: backup(item.backup) }),
    ...(item.sourceSha256 === undefined ? {} : { sourceSha256: text(item.sourceSha256, /^[a-f0-9]{64}$/) }),
    ...(item.init === undefined ? {} : { init: initOptions(item.init, layout, profile, true) }),
    } as MysqlService;
  });
  const localPaths = services.flatMap(service => service.driver === 'sqlite' ? [service.source, service.target].filter((value): value is string => !!value) : []);
  const pathKeys = localPaths.map(value => process.platform === 'win32' ? value.toLowerCase() : value);
  insist(new Set(pathKeys).size === pathKeys.length, 'manifest_path_reused');
  let admins: EnterpriseManifest['admins'];
  if (row.admins !== undefined) {
    const entry = record(row.admins, ['path', 'backup']);
    admins = { path: path(entry.path), backup: backup(entry.backup) };
    insist(!pathKeys.includes(process.platform === 'win32' ? admins.path.toLowerCase() : admins.path), 'manifest_path_reused');
  }
  // Stable service ordering is part of plan binding, not an execution-order guess.
  services.sort((a, b) => ['proxy', 'sso', 'login'].indexOf(a.component) - ['proxy', 'sso', 'login'].indexOf(b.component));
  return { manifestVersion: 1, baseline: '8ad76d5', profile, services: services as EnterpriseManifest['services'],
    attestations: attestations as EnterpriseManifest['attestations'], ...(admins ? { admins } : {}) };
}
export function enterpriseManifestHash(manifest: EnterpriseManifest): string {
  return createHash('sha256').update(JSON.stringify({ ...manifest, profile: JSON.parse(canonicalEnterpriseProfile(manifest.profile)) })).digest('hex');
}
