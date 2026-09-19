import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureRegistry } from './test/enterpriseFixtures.js';
import { loadProxyEnterpriseProfile, loadProxyEnterpriseRegistry } from './enterprise.js';

test('Proxy pins its immutable registry until process restart, not each lookup', t => {
  const directory = mkdtempSync(join(tmpdir(), 'proxy-registry-cache-'));
  const original = process.env.ENTERPRISE_REGISTRY_FILE;
  t.after(() => {
    if (original === undefined) delete process.env.ENTERPRISE_REGISTRY_FILE;
    else process.env.ENTERPRISE_REGISTRY_FILE = original;
    rmSync(directory, { recursive: true, force: true });
  });
  process.env.ENTERPRISE_REGISTRY_FILE = join(directory, 'registry.json');
  assert.throws(loadProxyEnterpriseRegistry, /enterprise_registry_file_invalid/);
  writeFileSync(process.env.ENTERPRISE_REGISTRY_FILE, JSON.stringify(fixtureRegistry()));
  const registry = loadProxyEnterpriseRegistry();
  const profile = loadProxyEnterpriseProfile();
  assert.equal(profile.id, registry.legacyEnterpriseId);
  assert(Object.isFrozen(registry));
  assert(Object.isFrozen(profile.sso));
  writeFileSync(process.env.ENTERPRISE_REGISTRY_FILE, 'not a registry');
  for (let i = 0; i < 100; i++) {
    assert.equal(loadProxyEnterpriseRegistry(), registry);
    assert.equal(loadProxyEnterpriseProfile(profile.id), profile);
  }
  assert.throws(() => loadProxyEnterpriseProfile('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), /enterprise_not_found/);
});
