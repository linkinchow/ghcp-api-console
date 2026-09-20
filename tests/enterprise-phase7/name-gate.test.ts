import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readNameCatalogTestGate } from './name-gate.js';

const authorized = { GHCP_ENTERPRISE_NAME_CATALOG_TEST: '1', GHCP_ENTERPRISE_MYSQL_TEST_ALLOW_DDL: '1',
  GHCP_ENTERPRISE_MYSQL_TEST_SCHEMA: 'ghcp_enterprise_test_phase5_v4',
  GHCP_ENTERPRISE_MYSQL_TEST_URL: 'mysql://synthetic:synthetic@127.0.0.1:33195/ghcp_enterprise_test_phase5_v4' };
test('name qualification requires its dedicated opt-in as well as the existing empty-schema loopback gate', () => {
  assert.deepEqual(readNameCatalogTestGate({}), { enabled: false });
  const { GHCP_ENTERPRISE_NAME_CATALOG_TEST: _explicit, ...otherSuite } = authorized;
  assert.deepEqual(readNameCatalogTestGate(otherSuite), { enabled: false });
  assert.deepEqual(readNameCatalogTestGate({ MYSQL_URL: 'mysql://secret@customer/live', MYSQL_TEST_URL: 'mysql://secret@customer/live' }), { enabled: false });
  assert.equal(readNameCatalogTestGate(authorized).enabled, true);
  for (const patch of [{ GHCP_ENTERPRISE_NAME_CATALOG_TEST: 'true' }, { GHCP_ENTERPRISE_MYSQL_TEST_ALLOW_DDL: '0' },
    { GHCP_ENTERPRISE_MYSQL_TEST_SCHEMA: 'customer' }, { GHCP_ENTERPRISE_MYSQL_TEST_URL: 'mysql://secret@customer/live' },
    { GHCP_ENTERPRISE_MYSQL_TEST_URL: 'mysql://synthetic:synthetic@localhost:33195/ghcp_enterprise_test_phase5_v4' }]) {
    assert.throws(() => readNameCatalogTestGate({ ...authorized, ...patch }), /mysql_/);
  }
  assert.throws(() => readNameCatalogTestGate({ GHCP_ENTERPRISE_NAME_CATALOG_TEST: '1' }), /empty_schema_gate_required/);
});
test('integration filename with unrelated suite authorization skips all nine cases without connection or driver imports', () => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME']) if (process.env[key]) env[key] = process.env[key];
  // Malformed other-suite URL would throw if the integration test read that gate too early.
  env.GHCP_ENTERPRISE_MYSQL_TEST_URL = 'not-a-database-url';
  env.MYSQL_TEST_URL = 'mysql://synthetic@must-not-resolve.invalid/not-used';
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap',
    fileURLToPath(new URL('../../upgrade/multi-enterprise-pool/nameCatalog.integration.test.ts', import.meta.url))],
  { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /# tests 9\r?\n/); assert.match(child.stdout, /# pass 0\r?\n/);
  assert.match(child.stdout, /# fail 0\r?\n/); assert.match(child.stdout, /# skipped 9\r?\n/);
  assert.doesNotMatch(child.stdout + child.stderr, /ECONN|ENOTFOUND|mysql_test_invalid_url/);
});
