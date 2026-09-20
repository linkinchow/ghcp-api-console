import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { publicCommand } from '../enterprise-phase5/migration-chain.js';
import { legacySource, seedLegacySqlite } from '../enterprise-phase5/db-fixtures.js';
import { snapshotSqlite } from '../enterprise-phase5/db-snapshot.js';
import { hashFile, writePrivate } from '../enterprise-phase5/db-gate.js';
import { createFixtureDescription } from '../enterprise-phase5/prepare.js';
import { createEnterpriseV1SqliteSchema } from '../../src/packages/shared/src/enterpriseSqliteV1.js';
import { registryV3 } from '../../upgrade/multi-enterprise/fixtures.js';
import { accountName } from '../../upgrade/v1-frozen/userPool/names.js';
// @ts-ignore Host-only MJS controller intentionally has no runtime TypeScript dependency.
import { STAGES, migrationQualification, parseQualificationArgs, qualificationPlan, validateQualificationState } from './migration-qualification.mjs';

const input = { state: '/opt/ghcp-test/phase5-20260920m/fixture/state.json', 'legacy-source': '/opt/ghcp-test/phase5-20260919a/legacy-source', stage: 'seed' };
test('qualification plans every final stage using only existing phase5 entrypoints and actual backup receipts', async () => {
  for (const stage of STAGES) {
    const plan = await migrationQualification({ ...input, stage });
    assert.equal(plan.execution, 'PLAN_ONLY'); assert.equal(plan.realMysqlExecuted, false);
    assert.ok(plan.steps.every((step: { kind: string; entry: string }) => step.kind === 'backup' || ['migration-chain.ts', 'db-run.ts', 'registration.ts'].includes(step.entry)));
    assert.ok(plan.steps.every((step: { kind: string; entry: string }) => !JSON.stringify(step).includes('reset')));
  }
  for (const [previous, current] of [['v1', 'v2'], ['v2', 'v3'], ['v3', 'v4']]) {
    const { steps } = qualificationPlan({ ...input, stage: current });
    assert.equal(steps.length, 2); assert.equal(steps[0].operation, 'dump');
    assert.ok(steps[0].output.endsWith(`phase7-${previous}.sql`));
    assert.equal(steps[1].args.backup, `/backups/phase7-${previous}.sql`);
  }
  const final = qualificationPlan({ ...input, stage: 'verify' });
  assert.equal(final.steps[0].args.stage, 'verify'); assert.equal(final.steps[1].operation, 'dump');
  const restore = qualificationPlan({ ...input, stage: 'restore' });
  assert.equal(restore.steps[0].service, 'mysql-restore'); assert.equal(restore.steps[0].schema, 'ghcp_enterprise_test_phase5_chain');
  assert.ok(restore.steps[0].backup.endsWith('phase7-v4.sql'));
  const verify = qualificationPlan({ ...input, stage: 'restore-verify' });
  assert.equal(verify.steps[0].args.directory, '/fixture/phase7-restored');
  assert.equal(verify.steps[0].service, 'mysql-restore');
  assert.ok(STAGES.indexOf('names') < STAGES.indexOf('register'), 'Retained registration schema must be last');
});
test('qualification refuses malformed args and missing explicit main gate without executing', () => {
  assert.deepEqual(parseQualificationArgs(['--stage', 'seed']), { stage: 'seed' });
  for (const args of [['--stage'], ['--stage', 'seed', '--stage', 'v2'], ['--execute', '1', '--shell', 'anything']]) assert.throws(() => parseQualificationArgs(args));
  for (const change of [{ stage: 'reset' }, { execute: 'yes' }, { state: '/tmp/old/state.json' }, { 'legacy-source': '/tmp/../old' }]) {
    assert.throws(() => qualificationPlan({ ...input, ...change }));
  }
  assert.throws(() => validateQualificationState({}, qualificationPlan(input), {}), /explicit_main_gate_required/);
});

test('qualification accepts actual phase5 description only with offline ownership and rejects missing or application owners', () => {
  const root = join(tmpdir(), 'phase5-20260920m');
  const { state } = createFixtureDescription({ runId: '20260920m', root, mode: 'migration',
    head: '9cbdae111f524a552ee607df4900e5c96189b16d', sourceSha256: 'a'.repeat(64), dryRun: true });
  const env = { PHASE7_MIGRATION_QUALIFICATION: '1', PHASE5_SYNTHETIC_ONLY: '1', PHASE5_DB_ALLOW_DDL: '1' };
  const plan = { ...qualificationPlan(input), root };
  const owned = state as any;
  owned.ownership.containers.mysql = { id: 'a'.repeat(64), name: `${state.project}-mysql-1` };
  assert.doesNotThrow(() => validateQualificationState(owned, plan, env));
  for (const mutation of [
    (s: any) => { s.mode = 'init'; },
    (s: any) => { delete s.ownership.containers.mysql; },
    (s: any) => { s.ownership.containers['proxy-1'] = { id: 'b'.repeat(64), name: `${s.project}-proxy-1-1` }; },
    (s: any) => { s.ownership.containers['mysql-restore'] = { id: s.ownership.containers.mysql.id, name: `${s.project}-mysql-restore-1` }; },
  ]) { const bad = structuredClone(owned); mutation(bad); assert.throws(() => validateQualificationState(bad, plan, env)); }
  assert.throws(() => validateQualificationState(owned, { ...plan, steps: [{ service: 'mysql-restore' }] }, env), /owned_mysql_required/);
  assert.throws(() => validateQualificationState(owned, plan, { ...env, PHASE5_DB_ALLOW_DDL: '0' }), /explicit_main_gate_required/);
});

test('final public CLI v1→v2→v3→v4: retained pool inventory plus original SSO/Login typed bytes', { timeout: 120_000 }, async t => {
  if (!process.env.PHASE5_LEGACY_SOURCE_ROOT) { t.skip('Explicit pristine 8ad76d5 source required; no legacy qualification claimed'); return; }
  const legacy = legacySource(), dir = mkdtempSync(join(tmpdir(), 'phase7-public-chain-'));
  try {
    const registry = registryV3(), profile = registry.profiles.find(p => p.id === registry.legacyEnterpriseId)!;
    const identity = accountName(0), files = await seedLegacySqlite(legacy, dir, profile, identity);
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys=ON'); createEnterpriseV1SqliteSchema(db, 'pool');
      const stamp = '2026-01-02T03:04:05.006Z';
      db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run('2026-07-23-copilot-oauth-direct', stamp);
      db.prepare(`INSERT INTO proxy_accounts(identity,sso_user,gh_login,copilot_oauth_token,copilot_oauth_status,copilot_oauth_updated_at,created_at,updated_at)
        VALUES(?,?,?,?,'valid',?,?,?)`).run(identity, identity, `${identity}_${profile.shortcode}`, '  synthetic\0Aaß☃  ', stamp, stamp, stamp);
      db.prepare('INSERT INTO user_pool_settings VALUES(1,7,0,5,120,1,1,?,NULL,0)').run(profile.accountDomain);
      db.prepare(`INSERT INTO user_pool_accounts(identity,ordinal,state,stage,attempt_id,sso_created_at,updated_at,verified_at,generation)
        VALUES(?,0,'ready','ready',?,?,1700000000000,1700000000000,7)`).run(identity, randomUUID(), stamp);
      db.prepare("INSERT INTO user_pool_leases VALUES(?,?,?,'active',1700000000000,1700000000123,4102444800000)")
        .run(`sha256:${'a'.repeat(64)}`, identity, randomUUID());
      db.prepare(`INSERT INTO proxy_request_stats(id,identity,requested_at,path,success,input_tokens)
        VALUES('original-known',?,?,'/synthetic',1,9007199254740993),('original-unattributed',?,'2020-01-01T00:00:00.000Z','/synthetic',0,NULL)`)
        .run(identity, '2026-01-03T03:04:05.006Z', identity);
      db.prepare("INSERT INTO user_pool_events(id,at,action,identity) VALUES(47,1800000000000,'original-known',?)").run(identity);
      writeFileSync(join(dir, 'proxy-v1.sqlite'), db.serialize(), { flag: 'wx' });
    } finally { db.close(); }
    const baseline = { sso: await snapshotSqlite(files.sso), login: await snapshotSqlite(files.login) };
    const admins = readFileSync(files.admins), originalHashes = new Map<string, string>();
    const attestations = { writersStopped: true, externalOperationsDrained: true, backupVerified: true };
    let incarnations: unknown;
    for (const version of [2, 3, 4] as const) {
      const services = ['proxy', 'sso', 'login'].map(component => {
        const source = join(dir, `${component}-v${version - 1}.sqlite`);
        originalHashes.set(source, hashFile(source));
        return { component, driver: 'sqlite', layout: component === 'proxy' ? 'pool' : component,
          source, target: join(dir, `${component}-v${version}.sqlite`), backup: { reference: `local-standalone-${component}-v${version - 1}`, sha256: hashFile(source) } };
      });
      const manifest = version === 2 ? { manifestVersion: 1, baseline: '8ad76d5', profile: Object.fromEntries(['id', 'slug', 'shortcode', 'accountDomain', 'revision', 'routes'].map(key => [key, (profile as any)[key]])),
        services, attestations, admins: { path: files.admins, backup: { reference: 'local-original-admins', sha256: hashFile(files.admins) } } }
        : { manifestVersion: version, sourceSchemaVersion: version - 1, registry, services, attestations };
      const manifestPath = join(dir, `v${version}-manifest.json`), plan = join(dir, `v${version}-plan.json`);
      writePrivate(manifestPath, manifest);
      const tool = `v${version}` as 'v2' | 'v3' | 'v4';
      assert.equal(publicCommand(tool, 'preflight', manifestPath, {}, plan).command, 'preflight');
      for (const [index, command] of ['apply', 'verify', 'inspect', 'apply', 'verify'].entries()) {
        const result = publicCommand(tool, command, plan, {}, undefined, index === 3);
        if (command !== 'inspect') assert.equal(result.ready, true);
      }
      for (const component of ['sso', 'login'] as const) assert.deepEqual(await snapshotSqlite(join(dir, `${component}-v${version}.sqlite`), baseline[component], registry.legacyEnterpriseId), baseline[component]);
      assert.deepEqual(readFileSync(files.admins), admins);
      for (const [source, sha] of originalHashes) assert.equal(hashFile(source), sha);
      const output = new Database(readFileSync(join(dir, `proxy-v${version}.sqlite`)));
      try {
        assert.deepEqual(output.prepare('SELECT identity,ordinal,generation FROM user_pool_accounts').get(), { identity, ordinal: 0, generation: 7 });
        assert.equal((output.prepare('SELECT next_ordinal FROM user_pool_settings').get() as any).next_ordinal, 1);
        assert.equal((output.prepare('SELECT input_tokens FROM proxy_request_stats WHERE id=?').safeIntegers(true).get('original-known') as any).input_tokens, 9007199254740993n);
        if (version === 3) incarnations = output.prepare('SELECT identity,account_incarnation FROM proxy_accounts ORDER BY identity').all();
        if (version === 4) assert.deepEqual(output.prepare('SELECT identity,account_incarnation FROM proxy_accounts ORDER BY identity').all(), incarnations);
      } finally { output.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
