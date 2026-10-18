import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DEFAULT_ENTERPRISE_ID, type EnterpriseId } from '@ghcp/shared';
import { readPoolConfig } from '../userPool/config.js';
import { enterpriseSeeds, type EnterpriseSeed } from './enterpriseSeed.js';
import { SqliteStorage } from './sqliteStorage.js';

const BETA = 'beta' as EnterpriseId;
const DEFAULT_SEED: EnterpriseSeed = { id: DEFAULT_ENTERPRISE_ID, fingerprint: 'a'.repeat(64), maxAccounts: 50 };
const BETA_SEED: EnterpriseSeed = { id: BETA, fingerprint: 'b'.repeat(64), maxAccounts: 20 };
const POOL_OPTIONS = readPoolConfig({
  ACCOUNT_ROUTING_MODE: 'caller-lease',
  POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.example.test',
  POOL_WARMUP_MODEL: 'test-model',
  READY_IDLE_TARGET: '5',
});

/** One database file; every storage opened on it is closed before the directory is removed. */
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'proxy-enterprise-registry-'));
  const storages: SqliteStorage[] = [];
  t.after(async () => {
    for (const storage of storages) await storage.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const open = (seeds: readonly EnterpriseSeed[]) => {
    const storage = new SqliteStorage(join(directory, 'proxy.sqlite'), 10, seeds);
    storages.push(storage);
    return storage;
  };
  const start = async (seeds: readonly EnterpriseSeed[]) => {
    const storage = open(seeds);
    await storage.initialize();
    return storage;
  };
  return { open, start };
}

/** Activates `beta` and gives it one pool member. */
async function enrollBeta(storage: SqliteStorage): Promise<void> {
  const pool = storage.userPool(POOL_OPTIONS);
  pool.updateEnterprisePolicy(BETA, 1, { state: 'active' });
  assert.equal(pool.reserve([BETA])?.enterprise_id, BETA);
}

test('enterpriseSeeds lists every registry enterprise, default first', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'proxy-registry-file-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'enterprises.json');
  writeFileSync(file, JSON.stringify({ version: 1, enterprises: [{
    id: 'contoso-eu',
    github: { baseUrl: 'https://contoso.ghe.com', slug: 'contoso' },
    pool: { accountDomain: 'contoso.example.test', initialMaxAccounts: 12 },
  }] }));
  const env = { ENTERPRISE_REGISTRY_FILE: file, POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.example.test' };
  const seeds = enterpriseSeeds(env);
  assert.deepEqual(seeds.map(({ id, maxAccounts }) => ({ id, maxAccounts })), [
    { id: DEFAULT_ENTERPRISE_ID, maxAccounts: 100 },
    { id: 'contoso-eu', maxAccounts: 12 },
  ]);
  assert.match(seeds[1].fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(enterpriseSeeds({}).map((seed) => seed.id), [DEFAULT_ENTERPRISE_ID]);
});

test('registry enterprises besides default start as drafts with their initial cap, once', async (t) => {
  const f = fixture(t);
  const first = await f.start([DEFAULT_SEED, BETA_SEED]);
  const states = (await first.listEnterprises()).map(({ id, state, maxAccounts }) => ({ id, state, maxAccounts }));
  assert.deepEqual(states, [
    { id: BETA, state: 'draft', maxAccounts: 20 },
    { id: DEFAULT_ENTERPRISE_ID, state: 'active', maxAccounts: 50 },
  ]);
  await first.close();
  const restarted = await f.start([DEFAULT_SEED, { ...BETA_SEED, maxAccounts: 30 }]);
  const beta = (await restarted.listEnterprises()).find((row) => row.id === BETA);
  assert.equal(beta?.maxAccounts, 20, 'the initial cap only seeds a new row');
});

test('each enterprise identity may change only while that enterprise has no pool members', async (t) => {
  const f = fixture(t);
  await (await f.start([DEFAULT_SEED, BETA_SEED])).close();
  const changed = { ...BETA_SEED, fingerprint: 'c'.repeat(64) };
  const adopted = await f.start([DEFAULT_SEED, changed]);
  const beta = (await adopted.listEnterprises()).find((row) => row.id === BETA);
  assert.equal(beta?.profileFingerprint, changed.fingerprint);
  await enrollBeta(adopted);
  await adopted.close();
  const storage = f.open([DEFAULT_SEED, BETA_SEED]);
  await assert.rejects(storage.initialize(), /^Error: enterprise_identity_changed: enterprise "beta"/);
});

test('an enterprise with pool members cannot leave the registry; one without members may', async (t) => {
  const f = fixture(t);
  await (await f.start([DEFAULT_SEED, BETA_SEED])).close();
  const withoutBeta = await f.start([DEFAULT_SEED]);
  const remaining = (await withoutBeta.listEnterprises()).map((row) => row.id);
  assert.deepEqual(remaining, [BETA, DEFAULT_ENTERPRISE_ID], 'the row stays; only registry enterprises activate');
  await withoutBeta.close();
  await enrollBeta(await f.start([DEFAULT_SEED, BETA_SEED]));
  const storage = f.open([DEFAULT_SEED]);
  await assert.rejects(storage.initialize(), /^Error: enterprise_missing_from_registry: enterprise "beta"/);
});

test('seeding an enterprise cannot push the caps past the shared name capacity', async (t) => {
  const f = fixture(t);
  await (await f.start([{ ...DEFAULT_SEED, maxAccounts: 9_990 }])).close();
  const storage = f.open([DEFAULT_SEED, BETA_SEED]);
  await assert.rejects(storage.initialize(), /^Error: name_capacity_exceeded/);
  const fits = await f.start([DEFAULT_SEED, { ...BETA_SEED, maxAccounts: 10 }]);
  assert.equal((await fits.listEnterprises()).length, 2);
});

test('storage requires the default enterprise among its seeds', async () => {
  const storage = new SqliteStorage(':memory:', 10, [BETA_SEED]);
  await assert.rejects(storage.initialize(), /no default enterprise/);
});

test('management reads, statistics and SSO-user deletion stay inside one enterprise', async (t) => {
  const storage = await fixture(t).start([DEFAULT_SEED, BETA_SEED]);
  await storage.createAccount({ enterpriseId: DEFAULT_ENTERPRISE_ID, identity: 'default-user', ssoUser: 'Shared' });
  await storage.createAccount({ enterpriseId: BETA, identity: 'beta-user', ssoUser: 'shared' });
  for (const [enterpriseId, identity] of [[DEFAULT_ENTERPRISE_ID, 'default-user'], [BETA, 'beta-user']] as const) {
    await storage.recordRequestStat({ enterpriseId, identity, path: '/v1/models', success: true });
  }
  assert.deepEqual((await storage.listAccounts(BETA)).items.map((row) => row.identity), ['beta-user']);
  assert.equal((await storage.summarizeAccounts(BETA)).total, 1);
  assert.deepEqual((await storage.listRequestStats(BETA)).map((row) => row.identity), ['beta-user']);
  assert.equal((await storage.listRequestStats(BETA, 'default-user')).length, 0);
  assert.equal((await storage.listRequestStatsPage(DEFAULT_ENTERPRISE_ID, { pageSize: 10 })).total, 1);
  await storage.withReadSnapshot(async (reader) => {
    assert.deepEqual((await reader.listAccounts(BETA)).items.map((row) => row.identity), ['beta-user']);
    assert.equal((await reader.listRequestStatsPage(BETA)).total, 1);
  });
  const deleted = await storage.deleteAccountsBySsoUser(BETA, 'SHARED');
  assert.deepEqual(deleted, { ssoUser: 'SHARED', matchedAccounts: 1, deletedAccounts: 1, deletedRequestStats: 1 });
  assert.ok(await storage.getAccount('default-user'), 'the same SSO user in another enterprise is untouched');
  assert.equal((await storage.listRequestStats(DEFAULT_ENTERPRISE_ID)).length, 1);
});
