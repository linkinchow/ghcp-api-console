import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { args, connect, databaseUrl, hashFile, insist, loadDbGate, resultPath, safeError, sha256, validatePeer, writePrivate } from './db-gate.js';
import { assertLegacySharedRuntime, importLegacy, legacySource, poolOptions, seedLegacyMysql } from './db-fixtures.js';

/** Actual frozen 8ad76d5 startup/storage paths. No HTTP server, worker or external provider is started. */
export async function compatibility(input = args()): Promise<void> {
  const state = await loadDbGate(input.state, input.inspect);
  resultPath(state, input.output);
  insist(['direct', 'pool'].includes(input.layout) && ['seed', 'run'].includes(input.stage), 'invalid_compatibility_mode');
  const layout = input.layout as 'direct' | 'pool', schema = `ghcp_enterprise_test_phase5_compat_${layout}`;
  const root = legacySource(), fixture = input.state.startsWith('/fixture/') ? '/fixture' : state.hostPaths.fixture;
  assertLegacySharedRuntime(root);
  const registry = JSON.parse(readFileSync(existsSync(state.registryFile) ? state.registryFile : join(fixture, 'registry.json'), 'utf8'));
  const profile = registry.profiles.find((p: any) => p.id === registry.legacyEnterpriseId);
  const legacy = Object.fromEntries(['id', 'slug', 'shortcode', 'accountDomain', 'revision', 'routes'].map(k => [k, profile[k]]));
  const c = await connect(state, schema);
  const { createPool } = await import('mysql2/promise');
  const livePool = createPool({ uri: databaseUrl(state, schema), connectionLimit: 3, timezone: 'Z', dateStrings: true,
    supportBigNumbers: true, bigNumberStrings: true, charset: 'utf8mb4', connectTimeout: 5000 });
  const peer = await livePool.getConnection(); try { validatePeer(peer); } finally { peer.release(); }
  try {
    if (input.stage === 'seed') {
      await seedLegacyMysql(c, root, profile, layout);
      writePrivate(input.output, { status: 'PASS', syntheticOnly: true, runId: state.runId, stage: 'compat-seed', schema, layout,
        nextAction: 'Dump exact schema, then run compatibility with actual --backup path; retains old initialized objects across migration' }); return;
    }
    const backup = JSON.parse(readFileSync(input.backup + '.json', 'utf8'));
    insist(backup.status === 'PASS' && backup.operation === 'dump' && backup.schema === schema && backup.runId === state.runId
      && backup.containerId === state.ownership.containers.mysql.id && backup.sha256 === hashFile(input.backup), 'compat_backup_binding_mismatch');
    const { MysqlStorage } = await importLegacy(root, 'src/proxy/src/db/mysqlStorage.ts');
    const { MysqlPoolStore } = await importLegacy(root, 'src/proxy/src/userPool/mysqlStore.ts');
    const { accountName } = await importLegacy(root, 'src/proxy/src/userPool/names.ts'); const identity = accountName(0);
    const startedStorage = new MysqlStorage(livePool, 100);
    await startedStorage.initialize();
    const startedPool = layout === 'pool' ? new MysqlPoolStore(livePool, poolOptions(profile)) : undefined;
    if (startedPool) await startedPool.initialize();
    const outcomes: any[] = [];
    async function observe(version: number, name: string, operation: () => Promise<unknown>) {
      try { await operation(); outcomes.push({ schemaVersion: version, path: name, outcome: 'ALLOWED' }); }
      catch (error) { outcomes.push({ schemaVersion: version, path: name, outcome: 'REJECTED', code: safeError(error) }); }
    }
    const common = { confirmOffline: true, confirmBackup: true, confirmDrained: true, expectedDatabase: schema, layout,
      backupReference: `phase5-${state.runId}-compat-v1-${layout}`, backupSha256: backup.sha256 };
    for (const version of [2, 3, 4]) {
      if (version === 2) {
        const { preflightEnterpriseMysql, applyEnterpriseMysql } = await import('../../upgrade/default-enterprise/mysql.js');
        const plan = await preflightEnterpriseMysql(c, legacy as any, layout);
        await applyEnterpriseMysql(c, legacy as any, { ...common, migrationId: 'phase5-compat-v2', expectedSourceSha256: plan.sourceSha256, manifestSha256: sha256(JSON.stringify({ version, schema, backup })) });
      } else if (version === 3) {
        const { preflightEnterpriseMysqlV3, applyEnterpriseMysqlV3 } = await import('../../upgrade/multi-enterprise/mysql.js');
        const plan = await preflightEnterpriseMysqlV3(c, registry, layout);
        await applyEnterpriseMysqlV3(c, registry, { ...common, migrationId: 'phase5-compat-v3', expectedSourceSha256: plan.sourceSha256,
          accountIncarnations: plan.accountIncarnations, manifestSha256: sha256(JSON.stringify({ version, schema, backup })) });
      } else {
        const { preflightEnterpriseMysqlV4, applyEnterpriseMysqlV4 } = await import('../../upgrade/multi-enterprise-pool/mysql.js');
        const plan = await preflightEnterpriseMysqlV4(c, registry, layout);
        await applyEnterpriseMysqlV4(c, registry, { ...common, migrationId: 'phase5-compat-v4', expectedSourceSha256: plan.sourceSha256, manifestSha256: sha256(JSON.stringify({ version, schema, backup })) });
      }
      await observe(version, 'cold-direct-initialize', () => new MysqlStorage(livePool, 100).initialize());
      if (startedPool) await observe(version, 'cold-caller-lease-initialize', () => new MysqlPoolStore(livePool, poolOptions(profile)).initialize());
      await observe(version, 'already-running-get-account', () => startedStorage.getAccount(identity));
      await observe(version, 'already-running-list-prepared-limit-offset', () => startedStorage.listAccounts({ page: 1, pageSize: 1 }));
      // Valid status update exercises an existing-row legacy WRITE, which some old binaries cannot self-refuse.
      await observe(version, 'already-running-existing-account-write', () => startedStorage.markCopilotOauthStatus(identity, 'valid'));
      await observe(version, 'already-running-record-stat', () => startedStorage.recordRequestStat({ identity, path: '/v1/messages', model: 'synthetic', success: true, inputTokens: 1 }));
      await observe(version, 'already-running-create-new-account', () => startedStorage.createAccount({ identity: `phase5-old-new-${version}`, ssoUser: `phase5-old-new-${version}` }));
      if (startedPool) {
        await observe(version, 'already-running-pool-settings-read', () => startedPool.settings());
        await observe(version, 'already-running-pool-reserve-paused', () => startedPool.reserve());
      }
    }
    writePrivate(input.output, { status: 'PASS', syntheticOnly: true, runId: state.runId, schema, layout, baseline: '8ad76d5',
      qualification: 'actual pristine legacy initialization and storage classes, same live instances retained across all migrations',
      fullHttpServerStartup: 'NOT_EXECUTED', outcomes, maintenanceIsolationRequired: true,
      note: 'PASS means observations recorded; ALLOWED legacy writes are a compatibility hazard, not a safety-gate pass. No external HTTP.',
      intermediateBackupPolicy: 'v1 recovery dump protects this disposable compatibility copy; full stage-by-stage backups qualified by migration-chain' });
  } finally { await c.end().catch(() => c.destroy()); await livePool.end(); }
}
if (process.argv[1]?.endsWith('compatibility.ts')) compatibility().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
