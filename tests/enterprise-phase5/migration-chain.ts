import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args, connect, databaseUrl, hashFile, inside, insist, loadDbGate, noSymlinkPath, resultPath, safeError, writePrivate } from './db-gate.js';
import { certificateEvidence, historicalPoolConfig, legacySeedPoolConfig, legacySource, seedLegacyMysql, seedLegacySqlite } from './db-fixtures.js';
import { snapshotMysql, snapshotSqlite } from './db-snapshot.js';
const sourceRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const schema = 'ghcp_enterprise_test_phase5_chain';
const tools = { v2: 'default-enterprise', v3: 'multi-enterprise', v4: 'multi-enterprise-pool' };
const attestations = { writersStopped: true, externalOperationsDrained: true, backupVerified: true };
function cleanEnv(): NodeJS.ProcessEnv {
  // Never inherit deployment, test DB or provider variables in a public migration subprocess.
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME']) if (process.env[name]) env[name] = process.env[name];
  return env;
}
export function publicCommand(version: keyof typeof tools, command: string, manifest: string, env: NodeJS.ProcessEnv, planOut?: string, resume = false) {
  const argv = ['--import', 'tsx', join(sourceRoot, 'upgrade', tools[version], 'index.ts'), command, '--manifest', manifest,
    ...(planOut ? ['--plan-out', planOut] : []), ...(resume ? ['--resume'] : [])];
  try {
    const stdout = execFileSync(process.execPath, argv, { cwd: sourceRoot, env: { ...cleanEnv(), ...env }, encoding: 'utf8',
      timeout: 120_000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(stdout);
  } catch (error) {
    const stderr = (error as any).stderr?.toString() ?? '';
    let code = 'phase5_public_command_failed';
    try { const r = JSON.parse(stderr); code = safeError(new Error(r.error ?? r.code)); } catch { /* suppress raw driver output */ }
    throw new Error(code);
  }
}
export async function migrationChain(input = args()): Promise<void> {
  const state = await loadDbGate(input.state, input.inspect, input.service ?? 'mysql');
  resultPath(state, input.output);
  insist(['seed', 'v2', 'v3', 'v4', 'verify', 'restore-verify'].includes(input.stage), 'invalid_chain_stage');
  const fixtureRoot = input.state.startsWith('/fixture/') ? '/fixture' : state.hostPaths.fixture;
  const directory = inside(fixtureRoot, input.directory ?? join(fixtureRoot, 'chain'));
  noSymlinkPath(directory);
  const registryFile = existsSync(state.registryFile) ? state.registryFile : join(fixtureRoot, 'registry.json');
  const { parseEnterpriseRegistryV3 } = await import('../../src/packages/shared/src/enterpriseV3.js');
  const registry = parseEnterpriseRegistryV3(JSON.parse(readFileSync(registryFile, 'utf8')));
  const profile = registry.profiles.find(p => p.id === registry.legacyEnterpriseId)!;
  const location = { host: '127.0.0.1', port: input.service === 'mysql-restore' ? state.database.restoreHostPort! : state.database.hostPort,
    database: schema, connectionEnv: 'ENTERPRISE_MYSQL_PHASE5_CHAIN' };
  const env = { ENTERPRISE_MYSQL_PHASE5_CHAIN: databaseUrl(state, schema, input.service ?? 'mysql') };
  const c = await connect(state, schema, input.service ?? 'mysql');
  try {
    if (input.stage === 'seed') {
      insist(!existsSync(directory), 'chain_directory_already_exists');
      const root = legacySource();
      const runtimeSeed = state.mode === 'migration';
      const credentials = state.credentials as { consoleUsername: string; consolePassword: string };
      let seedConfig;
      if (runtimeSeed) {
        insist(state.poolConfig && typeof state.poolConfig === 'object' && credentials, 'migration_preseed_state_required');
        seedConfig = historicalPoolConfig(state.poolConfig as any, registry);
        const expected = await legacySeedPoolConfig(root, profile, seedConfig);
        insist(expected.fingerprint === state.fingerprint, 'migration_preseed_runtime_fingerprint_mismatch');
      }
      mkdirSync(directory, { mode: 0o700 });
      const fixture = await seedLegacyMysql(c, root, profile, 'pool', seedConfig);
      const files = await seedLegacySqlite(root, directory, profile, fixture.identity, runtimeSeed
        ? { username: credentials.consoleUsername, password: credentials.consolePassword } : undefined);
      const baseline = { fixture, mysql: await snapshotMysql(c), sso: await snapshotSqlite(files.sso), login: await snapshotSqlite(files.login),
        adminsSha256: hashFile(files.admins), certificates: certificateEvidence(state, registry), registrySha256: hashFile(registryFile),
        stateSha256: hashFile(input.state),
        legacySource: { baseline: '8ad76d5', initialization: 'actual-pristine-source-functions' } };
      writePrivate(join(directory, 'baseline.json'), baseline);
      writePrivate(input.output, { status: 'PASS', stage: 'seed', syntheticOnly: true, runId: state.runId, schema,
        actualLegacyBuilders: true, originalTables: baseline.mysql.tables.map(t => ({ table: t.name, count: t.count })),
        nextAction: 'host backup-restore.mjs dump --schema ghcp_enterprise_test_phase5_chain; then stage v2 with actual dump path' });
      return;
    }
    const baselinePath = join(directory, 'baseline.json'), baselineHash = hashFile(baselinePath);
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    assert.equal(hashFile(registryFile), baseline.registrySha256, 'Original registry bytes changed');
    if (state.mode === 'migration') assert.equal(hashFile(input.state), baseline.stateSha256, 'Migration fixture state changed since seed');
    assert.deepEqual(certificateEvidence(state, registry), baseline.certificates, 'Original certificate/key bytes changed');
    assert.equal(hashFile(join(directory, 'admins.json')), baseline.adminsSha256, 'Original administrator hash/salt file changed');
    const trace: any[] = [];
    if (['v2', 'v3', 'v4'].includes(input.stage)) {
      const version = input.stage as keyof typeof tools, previous = version === 'v2' ? 'v1' : version === 'v3' ? 'v2' : 'v3';
      insist(input.backup && existsSync(input.backup), 'actual_mysql_dump_required');
      const backupRecord = JSON.parse(readFileSync(input.backup + '.json', 'utf8'));
      insist(backupRecord.status === 'PASS' && backupRecord.operation === 'dump' && backupRecord.runId === state.runId
        && backupRecord.schema === schema && backupRecord.sha256 === hashFile(input.backup)
        && backupRecord.containerId === state.ownership.containers[input.service ?? 'mysql'].id && backupRecord.bytes > 1000, 'verified_dump_record_required');
      const sqlite = ['sso', 'login'].map(component => {
        const file = join(directory, `${component}-${previous}.sqlite`);
        return { component, driver: 'sqlite', layout: component, source: file, target: join(directory, `${component}-${version}.sqlite`),
          backup: { reference: `phase5-${component}-${previous}`, sha256: hashFile(file) } };
      });
      const mysql = { component: 'proxy', driver: 'mysql', layout: 'pool', location,
        backup: { reference: `phase5-${state.runId}-${previous}-mysql`, sha256: hashFile(input.backup) } };
      const manifest = version === 'v2'
        ? { manifestVersion: 1, baseline: '8ad76d5', profile: Object.fromEntries(['id', 'slug', 'shortcode', 'accountDomain', 'revision', 'routes'].map(k => [k, (profile as any)[k]])),
          services: [mysql, ...sqlite], attestations, admins: { path: join(directory, 'admins.json'), backup: { reference: 'phase5-original-admins', sha256: baseline.adminsSha256 } } }
        : { manifestVersion: version === 'v3' ? 3 : 4, sourceSchemaVersion: version === 'v3' ? 2 : 3, registry, services: [mysql, ...sqlite], attestations };
      const manifestPath = join(directory, `${version}-manifest.json`), planPath = join(directory, `${version}-plan.json`);
      writePrivate(manifestPath, manifest);
      trace.push(publicCommand(version, 'preflight', manifestPath, env, planPath));
      for (const [index, command] of ['apply', 'verify', 'inspect', 'apply', 'verify'].entries()) {
        // Repeated MySQL apply intentionally requires explicit --resume, even when complete.
        const result = publicCommand(version, command, planPath, env, undefined, index === 3);
        insist(command === 'inspect' || result.ready === true, 'public_command_not_paired_ready'); trace.push(result);
      }
      const originalAfter = await snapshotMysql(c, baseline.mysql);
      assert.deepEqual(originalAfter, baseline.mysql, 'Every original MySQL column, typed bytes and AUTO_INCREMENT must survive');
      for (const component of ['sso', 'login']) assert.deepEqual(await snapshotSqlite(join(directory, `${component}-${version}.sqlite`), baseline[component], registry.legacyEnterpriseId), baseline[component]);
      const [accounts] = version !== 'v2' ? await c.query<any[]>('SELECT identity,account_incarnation FROM proxy_accounts ORDER BY identity') : [[]];
      if (version === 'v3') writePrivate(join(directory, 'v3-incarnations.json'), accounts);
      if (version === 'v4') assert.deepEqual(accounts, JSON.parse(readFileSync(join(directory, 'v3-incarnations.json'), 'utf8')), 'v4 must not regenerate incarnation mappings');
      writePrivate(input.output, { status: 'PASS', stage: version, syntheticOnly: true, runId: state.runId, schema,
        commands: trace.map(r => ({ command: r.command, ready: r.ready, paired: r.pairedRegistry ?? r.pairedProfile,
          components: r.components.map((s: any) => ({ component: s.component, state: s.state, schemaVersion: s.schemaVersion })) })),
        originalMysqlColumnsTypedByteEqual: true, originalSqliteStorageClassesEqual: true, adminAndCertificateBytesEqual: true,
        actualMysqlBackupSha256: backupRecord.sha256, incarnationMappingPreserved: version === 'v4' ? true : undefined });
      return;
    }
    // A restored server has a different port, but the ORIGINAL protected manifests/receipts are not rewritten.
    // Lower-level verification binds the original manifest hash and the same database name to the restored connection.
    const plan = JSON.parse(readFileSync(join(directory, 'v4-plan.json'), 'utf8'));
    const { enterpriseManifestHashV4, parseEnterpriseManifestV4 } = await import('../../upgrade/multi-enterprise-pool/manifest.js');
    const { verifyEnterpriseMysqlMigrationV4 } = await import('../../upgrade/multi-enterprise-pool/mysql.js');
    const { validateEnterpriseMysqlV4 } = await import('../../src/packages/shared/src/enterpriseMysqlV4.js');
    const parsed = parseEnterpriseManifestV4(plan), s = parsed.services.find((row: any) => row.driver === 'mysql') as any;
    await verifyEnterpriseMysqlMigrationV4(c, registry, { migrationId: 'enterprise-schema4-contract2', expectedSourceSha256: s.sourceSha256,
      manifestSha256: enterpriseManifestHashV4(parsed), backupReference: s.backup.reference, backupSha256: s.backup.sha256,
      expectedDatabase: schema, layout: 'pool' });
    await validateEnterpriseMysqlV4(c, 'proxy', registry);
    assert.deepEqual(await snapshotMysql(c, baseline.mysql), baseline.mysql);
    const [incarnations] = await c.query<any[]>('SELECT identity,account_incarnation FROM proxy_accounts ORDER BY identity');
    assert.deepEqual(incarnations, JSON.parse(readFileSync(join(directory, 'v3-incarnations.json'), 'utf8')));
    const [stats] = await c.query<any[]>('SELECT id,enterprise_id,input_tokens FROM proxy_request_stats ORDER BY id');
    assert.equal(stats.find(row => row.id === 'phase5-known')?.enterprise_id, registry.legacyEnterpriseId);
    assert.equal(String(stats.find(row => row.id === 'phase5-known')?.input_tokens), '9007199254740993');
    assert.equal(stats.find(row => row.id === 'phase5-before-recreated')?.enterprise_id, null);
    assert.equal(stats.find(row => row.id === 'phase5-deleted-account')?.enterprise_id, null);
    for (const component of ['sso', 'login']) assert.deepEqual(await snapshotSqlite(join(directory, `${component}-v4.sqlite`), baseline[component], registry.legacyEnterpriseId), baseline[component]);
    assert.equal(hashFile(baselinePath), baselineHash, 'Original baseline changed during verification');
    if (state.mode === 'migration' && input.stage === 'verify') {
      insist((input.service ?? 'mysql') === 'mysql' && directory === join(fixtureRoot, 'chain'), 'adoption_primary_fixed_chain_required');
      insist(baseline.fixture.explicitPreseedRuntimeConfig === true && baseline.fixture.poolFingerprint === state.fingerprint,
        'adoption_requires_preseed_runtime_fingerprint');
      const files = Object.fromEntries([['sso', 'sso-v4.sqlite'], ['login', 'login-v4.sqlite'], ['admins', 'admins.json']].map(([component, file]) =>
        [component, { path: `/fixture/chain/${file}`, sha256: hashFile(join(directory, file)) }]));
      // Private evidence is exclusively created only after exact DB/SQLite/admin/cert
      // verification. It is not a public report, nor permission to rewrite markers.
      writePrivate(join(directory, 'adoption.json'), { version: 1, status: 'PASS', stage: 'verify', syntheticOnly: true,
        runId: state.runId, project: state.project, mysqlContainerId: state.ownership.containers.mysql.id, schema,
        registrySha256: hashFile(registryFile), v4PlanSha256: hashFile(join(directory, 'v4-plan.json')),
        baselineSha256: baselineHash, stateSha256: hashFile(input.state), sourceBundleSha256: (state.source as any).bundleSha256,
        files, runtimeStarted: false });
    }
    writePrivate(input.output, { status: 'PASS', stage: input.stage, syntheticOnly: true, runId: state.runId, schema,
      exactSchemaTriggersAndReceiptVerified: true, originalMysqlColumnsTypedByteEqual: true, originalSqliteStorageClassesEqual: true,
      adminAndCertificateBytesEqual: true, incarnationMappingPreserved: true, oldActiveLeasePreserved: true, databaseNamePreserved: true,
      receiptOrMarkerRewritten: false, attributionKnownAndUnattributed: true, runtimeStarted: false });
  } finally { await c.end().catch(() => c.destroy()); }
}
if (process.argv[1]?.endsWith('migration-chain.ts')) migrationChain().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
