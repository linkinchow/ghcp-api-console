import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createConnection, type Connection } from 'mysql2/promise';
import { canonicalEnterpriseProfile } from '../../src/packages/shared/src/enterprise.js';
import { EnterpriseStorageError } from '../../src/packages/shared/src/enterpriseStorage.js';
import { initEnterpriseMysql, validateEnterpriseMysql } from '../../src/packages/shared/src/enterpriseMysql.js';
import { applyEnterpriseMysql, inspectEnterpriseMysql, preflightEnterpriseMysql, verifyEnterpriseMysqlMigration } from './mysql.js';
import { EnterpriseToolError, enterpriseManifestHash, insist, parseEnterpriseManifest, type EnterpriseManifest, type MysqlService } from './manifest.js';
import { applyEnterpriseSqlite, initEnterpriseSqliteFile, inspectEnterpriseSqlite, preflightEnterpriseSqlite, validateAdminsFile, verifyEnterpriseSqlite } from './sqlite.js';

export type EnterpriseCommand = 'init' | 'preflight' | 'apply' | 'verify' | 'inspect';
export interface EnterpriseCommandResult {
  command: EnterpriseCommand;
  ready: boolean;
  pairedProfile: boolean;
  components: Record<string, unknown>[];
  admins: { checked: boolean; count?: number; unchanged?: true };
}
/** Driver details and arbitrary errors may contain credentials. Never expose them. */
export function safeEnterpriseToolError(error: unknown): string {
  if ((error instanceof EnterpriseToolError || error instanceof EnterpriseStorageError) && /^[a-z][a-z0-9_]{1,100}$/.test(error.message)) return error.message;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && /^enterprise_[a-z0-9_]{1,90}$/.test(error.code)) return error.code;
  return 'enterprise_operation_failed_details_suppressed_inspect_before_retry';
}
async function mysqlConnection(service: MysqlService, env: NodeJS.ProcessEnv): Promise<Connection> {
  const value = env[service.location.connectionEnv];
  insist(value, 'mysql_explicit_connection_environment_required');
  let url: URL;
  try { url = new URL(value); } catch { throw new EnterpriseToolError('mysql_invalid_connection_environment'); }
  insist(url.protocol === 'mysql:' && !url.search && !url.hash
    && url.hostname.toLowerCase() === service.location.host.toLowerCase()
    && Number(url.port || 3306) === service.location.port
    && decodeURIComponent(url.pathname.slice(1)) === service.location.database, 'mysql_manifest_location_mismatch');
  const local = ['127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  const ca = env[`${service.location.connectionEnv}_CA_FILE`];
  insist(local || !!ca, 'mysql_verified_tls_required');
  const connection = await createConnection({ uri: value, timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    charset: 'utf8mb4', connectTimeout: 10000,
    ...(ca ? { ssl: { ca: readFileSync(ca, 'utf8'), rejectUnauthorized: true, verifyIdentity: true } } : {}),
  });
  if (!ca) {
    const transport = (connection as unknown as { connection: { stream?: { remoteAddress?: string }; config?: { socketPath?: string } } }).connection;
    if (transport.config?.socketPath || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(transport.stream?.remoteAddress ?? '')) {
      connection.destroy(); throw new EnterpriseToolError('mysql_literal_loopback_peer_required');
    }
  }
  return connection;
}
export async function runEnterpriseCommand(command: EnterpriseCommand, value: unknown,
  options: { resume?: boolean; env?: NodeJS.ProcessEnv; planOut?: string } = {}): Promise<EnterpriseCommandResult> {
  insist(['init', 'preflight', 'apply', 'verify', 'inspect'].includes(command), 'enterprise_invalid_command');
  insist(!options.resume || command === 'apply', 'enterprise_resume_only_apply');
  insist(!options.planOut || command === 'preflight' && isAbsolute(options.planOut), 'enterprise_plan_out_requires_preflight_absolute_path');
  const manifest = parseEnterpriseManifest(value);
  const admins = validateAdminsFile(manifest);
  // Screen every standalone source before any component is changed. MySQL is
  // ordered first and rechecks its own locked snapshot immediately before DDL.
  if (command === 'apply') {
    for (const service of manifest.services) if (service.driver === 'sqlite') preflightEnterpriseSqlite(service, manifest.profile);
  }
  const components: Record<string, unknown>[] = [];
  const observedProfiles: string[] = [];
  for (const service of manifest.services) {
    if (service.driver === 'sqlite') {
      const result = command === 'init' ? initEnterpriseSqliteFile(service, manifest)
        : command === 'preflight' ? preflightEnterpriseSqlite(service, manifest.profile)
        : command === 'apply' ? applyEnterpriseSqlite(service, manifest)
        : command === 'verify' ? verifyEnterpriseSqlite(service, manifest)
        : inspectEnterpriseSqlite(service, manifest.profile);
      components.push({ ...result });
      if (['initialized', 'verified', 'complete', 'already-complete'].includes(result.state)) observedProfiles.push(canonicalEnterpriseProfile(manifest.profile));
      continue;
    }
    const connection = await mysqlConnection(service, options.env ?? process.env);
    try {
      if (command === 'init') {
        insist(service.init !== undefined, 'mysql_explicit_init_options_required');
        await initEnterpriseMysql(connection, 'proxy', manifest.profile, { ...service.init, layout: service.layout });
        const result = await validateEnterpriseMysql(connection, 'proxy', manifest.profile);
        components.push({ component: 'proxy', driver: 'mysql', state: 'initialized', layout: result.layout });
        observedProfiles.push(canonicalEnterpriseProfile(result.profile));
      } else if (command === 'preflight') {
        insist(service.init === undefined, 'mysql_migrate_cannot_seed');
        const result = await preflightEnterpriseMysql(connection, manifest.profile, service.layout);
        insist(result.database === service.location.database, 'mysql_source_binding_mismatch');
        if (service.sourceSha256 !== undefined) insist(result.sourceSha256 === service.sourceSha256, 'mysql_source_binding_mismatch');
        insist(service.sourceSha256 !== undefined || options.planOut, 'mysql_preflight_plan_output_required');
        service.sourceSha256 = result.sourceSha256;
        components.push({ component: 'proxy', driver: 'mysql', state: 'preflight', layout: result.layout, counts: result.counts });
      } else if (command === 'apply') {
        insist(service.init === undefined && service.sourceSha256 && service.backup, 'mysql_bound_plan_required');
        const result = await applyEnterpriseMysql(connection, manifest.profile, {
          migrationId: '8ad76d5-enterprise-schema2-contract1', confirmOffline: true, confirmBackup: true, confirmDrained: true,
          expectedSourceSha256: service.sourceSha256, manifestSha256: enterpriseManifestHash(manifest),
          backupReference: service.backup.reference, backupSha256: service.backup.sha256,
          expectedDatabase: service.location.database, resume: options.resume, layout: service.layout,
        });
        const verified = await validateEnterpriseMysql(connection, 'proxy', manifest.profile);
        components.push({ component: 'proxy', driver: 'mysql', state: 'complete', layout: verified.layout, counts: result.counts });
        observedProfiles.push(canonicalEnterpriseProfile(verified.profile));
      } else if (command === 'verify') {
        if (service.init === undefined) {
          insist(service.sourceSha256 && service.backup, 'mysql_bound_plan_required');
          await verifyEnterpriseMysqlMigration(connection, manifest.profile, {
            migrationId: '8ad76d5-enterprise-schema2-contract1', expectedSourceSha256: service.sourceSha256,
            manifestSha256: enterpriseManifestHash(manifest), backupReference: service.backup.reference,
            backupSha256: service.backup.sha256, expectedDatabase: service.location.database, layout: service.layout,
          });
        }
        const result = await validateEnterpriseMysql(connection, 'proxy', manifest.profile);
        insist(result.layout === service.layout, 'mysql_layout_mismatch');
        components.push({ component: 'proxy', driver: 'mysql', state: 'verified', layout: result.layout });
        observedProfiles.push(canonicalEnterpriseProfile(result.profile));
      } else {
        const result = await inspectEnterpriseMysql(connection);
        components.push({ component: 'proxy', driver: 'mysql', ...result });
      }
    } finally { try { await connection.end(); } catch { /* Timeout path may already destroy the socket. */ } }
  }
  validateAdminsFile(manifest); // Includes a second unchanged-file check across component operations.
  if (options.planOut) {
    // This protected artifact is the apply manifest. Never print credential-derived
    // source digests; use exclusive creation, preserve failures, never overwrite.
    const fd = openSync(options.planOut, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(manifest, null, 2) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  const pairedProfile = observedProfiles.length === 3 && new Set(observedProfiles).size === 1;
  return { command, ready: ['init', 'apply', 'verify'].includes(command) && pairedProfile, pairedProfile, components, admins };
}
