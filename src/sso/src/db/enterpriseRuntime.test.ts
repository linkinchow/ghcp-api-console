import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { initSsoFixture } from './enterpriseFixture.js';
import { runMigrations } from './migrations.js';

const OTHER = '3e316a51-3f1f-43ce-909c-aac7e5e9d546';

test('SSO enterprise gate is before writes and initialized users have immutable ownership', async () => {
  const scope = initSsoFixture();
  const profile = scope.profile;
  const { config } = await import('../config.js');
  const { getDb } = await import('./connection.js');
  const { requireEnterpriseInput } = await import('../enterprise.js');
  const { createUser, toDto } = await import('./usersRepo.js');
  const target = config.dbPath;
  const profileFile = config.enterpriseRegistryFile;
  config.enterpriseRegistryFile = undefined;
  assert.throws(getDb, /enterprise_registry_file_required/);
  config.enterpriseRegistryFile = profileFile;
  config.dbPath = `${target}.missing`;
  assert.throws(getDb, /enterprise_init_required/);
  assert.equal(existsSync(config.dbPath), false);

  config.dbPath = `${target}.legacy`;
  const legacy = new Database(config.dbPath);
  runMigrations(legacy);
  legacy.close();
  const before = readFileSync(config.dbPath);
  assert.throws(getDb, /enterprise_v3_partial_or_unknown_schema/);
  assert.deepEqual(readFileSync(config.dbPath), before);
  assert.equal(existsSync(`${config.dbPath}-wal`), false);

  // Failed connection was not cached: the next valid, explicitly initialized DB works.
  config.dbPath = target;
  const db = getDb();
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.throws(() => requireEnterpriseInput({ enterpriseId: OTHER }, scope), /unsupported_enterprise/);
  assert.throws(() => requireEnterpriseInput({ enterpriseRevision: 2 }, scope), /enterprise_revision_mismatch/);
  requireEnterpriseInput({}, scope);
  const user = createUser({ ssoUser: 'original-name', passwordHash: 'unchanged-hash', salt: 'unchanged-salt', email: 'user@separate-sso.example.com' }, scope);
  const dto = toDto(user);
  assert.equal(dto.enterpriseId, profile.id);
  assert.equal(user.passwordHash, 'unchanged-hash');
  assert.equal(user.salt, 'unchanged-salt');
  assert.equal('passwordHash' in dto, false);
  assert.throws(() => db.prepare('UPDATE sso_users SET enterprise_id = ?').run(OTHER), /enterprise_binding_immutable/);
  assert.throws(() => db.prepare('INSERT INTO sso_pool_managed_users (enterprise_id,sso_user) VALUES (?,?)').run(OTHER, user.ssoUser), /FOREIGN KEY/);
  db.close();
});
