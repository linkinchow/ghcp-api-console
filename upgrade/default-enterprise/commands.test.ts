import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runEnterpriseCommand, safeEnterpriseToolError } from './commands.js';
import { EnterpriseToolError } from './manifest.js';

const here = dirname(fileURLToPath(import.meta.url));
const profile = { id: '84bdc214-ad8b-484f-9419-3d82b63d07c4', slug: 'synthetic-enterprise', shortcode: 'synth', accountDomain: 'fixture.invalid', revision: 1,
  routes: { proxyInternalUrl: 'http://127.0.0.1:14101', ssoInternalUrl: 'http://127.0.0.1:14102', loginInternalUrl: 'http://127.0.0.1:14103', ssoPublicUrl: 'https://sso.fixture.invalid' } };
function plan(dir: string) {
  return { manifestVersion: 1, baseline: '8ad76d5', profile,
    services: ['proxy', 'sso', 'login'].map(component => ({ component, driver: 'sqlite', layout: component === 'proxy' ? 'direct' : component,
      target: join(dir, component + '.sqlite') })),
    attestations: { writersStopped: true, externalOperationsDrained: true, backupVerified: true } };
}
test('three-service command pairing init/verify/inspect and wrong-profile rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'enterprise-command-'));
  try {
    const manifest = plan(dir);
    const initialized = await runEnterpriseCommand('init', manifest);
    assert.equal(initialized.ready, true); assert.equal(initialized.pairedProfile, true);
    const before = manifest.services.map(service => readFileSync(service.target));
    assert.equal((await runEnterpriseCommand('verify', manifest)).ready, true);
    const inspected = await runEnterpriseCommand('inspect', manifest);
    assert.equal(inspected.ready, false); assert.ok(inspected.components.every(component => component.state === 'complete'));
    for (const [index, service] of manifest.services.entries()) assert.deepEqual(readFileSync(service.target), before[index]);
    await assert.rejects(() => runEnterpriseCommand('verify', { ...manifest, profile: { ...profile, revision: 2 } }), /profile_mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('CLI help and malformed manifest fail without leaking source content', () => {
  const require = createRequire(import.meta.url);
  const tsxCli = resolve(dirname(require.resolve('tsx')), 'cli.mjs');
  const help = spawnSync(process.execPath, [tsxCli, join(here, 'index.ts'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /init\|preflight\|apply\|verify\|inspect/);
  const dir = mkdtempSync(join(tmpdir(), 'enterprise-cli-'));
  try {
    const path = join(dir, 'bad.json'); writeFileSync(path, '{"password":"SYNTHETIC_SECRET_IN_BAD_MANIFEST"');
    const failure = spawnSync(process.execPath, [tsxCli, join(here, 'index.ts'), 'verify', '--manifest', path], { encoding: 'utf8' });
    assert.equal(failure.status, 1); assert.doesNotMatch(failure.stderr + failure.stdout, /SYNTHETIC_SECRET/);
    assert.equal(JSON.parse(failure.stderr).ready, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('MySQL command rejects unbound endpoints or unverified remote TLS before a connection or SQLite output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'enterprise-mysql-command-'));
  try {
    const manifest = plan(dir);
    const remote = { component: 'proxy', driver: 'mysql', layout: 'direct',
      location: { host: 'db.example.invalid', port: 3306, database: 'fixture', connectionEnv: 'ENTERPRISE_MYSQL_FIXTURE' }, init: {} };
    const candidate = { ...manifest, services: [remote, ...manifest.services.slice(1)] };
    await assert.rejects(() => runEnterpriseCommand('init', candidate, { env: {} }), /mysql_explicit_connection_environment_required/);
    await assert.rejects(() => runEnterpriseCommand('init', candidate, {
      env: { ENTERPRISE_MYSQL_FIXTURE: 'mysql://synthetic:secret@db.example.invalid:3306/other' },
    }), /mysql_manifest_location_mismatch/);
    await assert.rejects(() => runEnterpriseCommand('init', candidate, {
      env: { ENTERPRISE_MYSQL_FIXTURE: 'mysql://synthetic:secret@db.example.invalid:3306/fixture' },
    }), /mysql_verified_tls_required/);
    const localhost = { ...remote, location: { ...remote.location, host: 'localhost' } };
    await assert.rejects(() => runEnterpriseCommand('init', { ...candidate, services: [localhost, ...manifest.services.slice(1)] }, {
      env: { ENTERPRISE_MYSQL_FIXTURE: 'mysql://synthetic:secret@localhost:3306/fixture' },
    }), /mysql_verified_tls_required/);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('operator initialization cannot silently enable pool prewarming', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'enterprise-paused-init-'));
  try {
    const manifest = plan(dir);
    const pool = { ...manifest.services[0], layout: 'pool', init: { maxAccounts: 2, pool: { settings: {
      version: 1, idle_target: 1, lease_seconds: 172800, paused: 0, next_ordinal: 0,
      account_domain: profile.accountDomain, owner: null, owner_until: 0,
    } } } };
    await assert.rejects(() => runEnterpriseCommand('init', { ...manifest, services: [pool, ...manifest.services.slice(1)] }), /manifest_init_must_remain_paused/);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('safe CLI errors never print driver details or credentials', () => {
  assert.equal(safeEnterpriseToolError(new EnterpriseToolError('manifest_unknown_or_missing_field')), 'manifest_unknown_or_missing_field');
  assert.equal(safeEnterpriseToolError(new Error('mysql://user:synthetic-secret@host/db')), 'enterprise_operation_failed_details_suppressed_inspect_before_retry');
});
