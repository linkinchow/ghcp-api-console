import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { createSqlitePoolFixture, fixtureProfile, TEST_ENTERPRISE } from '../test/enterpriseFixtures.js';
import { readPoolConfig } from './config.js';
import { realProvisioner } from './provisioner.js';
import { PrewarmWorker } from './worker.js';

async function until(predicate: () => boolean, label: string) {
  for (let turn = 0; turn < 3000; turn++) { if (predicate()) return; await yieldTurn(); }
  assert.ok(predicate(), label);
}
function fixture(target: number, cap: number) {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  const options = readPoolConfig({ ACCOUNT_ROUTING_MODE: 'caller-lease', POOL_ACCOUNT_EMAIL_DOMAIN: 'synthetic.example.test',
    POOL_WARMUP_MODEL: 'synthetic', READY_IDLE_TARGET: String(target), POOL_MAX_ACCOUNTS: String(cap) });
  const store = createSqlitePoolFixture(db, options);
  return { db, options, store };
}

test('real worker does not reserve replacements while its real provisioner has live SSO-create intents', { timeout: 15000 }, async () => {
  const { db, options, store } = fixture(2, 4);
  const posts: string[] = [], releases = new Map<string, () => void>();
  const adapter = realProvisioner(store, options, {
    enterpriseProfile: () => fixtureProfile(options), verifyReadiness: async () => {}, creationCapacity: async () => true,
    async fetch(input, init) {
      const url = new URL(String(input));
      assert.ok(url.pathname.startsWith(`/api/profiles/${TEST_ENTERPRISE.id}/users`));
      if (init?.method === 'GET') return new Response('{}', { status: 404 });
      const body = JSON.parse(String(init?.body)); posts.push(body.ssoUser);
      assert.equal(store.inventory(body.ssoUser)!.stage, 'sso-creating');
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(init!.signal!.reason);
        init!.signal!.addEventListener('abort', abort, { once: true });
        releases.set(body.ssoUser, () => { init!.signal!.removeEventListener('abort', abort); resolve(); });
      });
      const now = new Date(store.now()).toISOString();
      return new Response(JSON.stringify({ enterpriseId: TEST_ENTERPRISE.id, userIncarnation: randomUUID(),
        ssoUser: body.ssoUser, email: body.email, role: 'user', createdAt: now, updatedAt: now }));
    },
  });
  // Real SSO intent/response/checkpoint logic; later steps are held out of this bounded reproduction.
  const worker = new PrewarmWorker(store, { ...adapter, async step(row, context) {
    const patch = await adapter.step(row, context); return { ...patch, retry_at: store.now() + 60000 };
  } }, 60000, 2);
  try {
    await worker.start(); await until(() => posts.length === 2, 'two original SSO requests must be in flight');
    assert.equal(store.counts().total, 2);
    assert.equal(store.enterpriseOverview().supply.pendingSupply, 0, 'Persisted unknown intent still excludes P; no SQL semantic weakening');
    await worker.tick(); assert.equal(store.counts().total, 2, 'periodic tick cannot replace this owner\'s two live intents');
    releases.get(posts[0])!();
    await until(() => store.inventory(posts[0])!.stage === 'sso-created', 'first completion must checkpoint');
    await worker.tick();
    assert.equal(store.counts().total, 2, 'completion wake while second POST is live must not allocate a third account');
    assert.equal(posts.length, 2);
    releases.get(posts[1])!();
    await until(() => posts.every(id => store.inventory(id)!.stage === 'sso-created'), 'both original requests must complete');
    await worker.tick();
    assert.equal(store.enterpriseOverview().supply.pendingSupply, 2);
    assert.equal(store.counts().total, 2);
    const settings = store.settings(); store.updateSettings(settings.version, { idle_target: 3 });
    const refill = worker.tick();
    await until(() => posts.length === 3, 'creation must resume after local steps drain and a real deficit appears');
    assert.equal(store.counts().total, 3);
    releases.get(posts[2])!(); await refill;
    assert.equal(new Set(posts).size, 3, 'one SSO POST per reserved identity');
  } finally { await worker.stop(); db.close(); }
});

test('definite capacity race retains one safely retryable name without counting failed capacity as logical supply', async () => {
  const { db, options, store } = fixture(1, 5);
  let now = Date.now(), posts = 0, full = false;
  store.now = () => now;
  const adapter = realProvisioner(store, options, {
    enterpriseProfile: () => fixtureProfile(options), verifyReadiness: async () => {}, creationCapacity: async () => !full,
    async fetch(_input, init) {
      if (init?.method === 'GET') return Response.json({}, { status: 404 });
      posts++; full = true;
      return Response.json({ error: { code: 'sso_user_limit_reached', message: 'not persisted' } }, { status: 409 });
    },
  });
  const worker = new PrewarmWorker(store, adapter, options.pollMs, 1);
  try {
    await worker.tick();
    const identity = (store.accounts()[0] as { identity: string }).identity;
    for (let n = 0; n < 5; n++) {
      now += options.pollMs; await worker.tick();
      const row = store.inventory(identity)!;
      assert.equal(row.state, 'failed'); assert.equal(row.stage, 'new'); assert.equal(row.attempts, 3);
      assert.equal(row.last_error, 'sso_user_limit_reached'); assert.equal(row.ordinal, 0);
      assert.equal(store.counts().total, 1); assert.equal(store.enterpriseOverview().supply.pendingSupply, 0);
      assert.equal(store.enterpriseOverview().supply.deficit, 1); assert.equal(store.enterpriseOverview().names.nextOrdinal, 1);
    }
    assert.equal(posts, 1, 'capacity outage does not fill inventory with ambiguous phantoms or auto-replay');
    store.retry(identity);
    assert.equal(store.inventory(identity)!.identity, identity); assert.equal(store.inventory(identity)!.ordinal, 0);
    assert.equal(store.inventory(identity)!.attempts, 0); assert.equal(store.inventory(identity)!.stage, 'new');
    assert.equal(store.enterpriseOverview().names.nextOrdinal, 1);
  } finally { await worker.stop(); db.close(); }
});

test('inherited unknown SSO intent stays excluded and is quarantined without replay', { timeout: 15000 }, async () => {
  const { db, options, store } = fixture(1, 1);
  const original = store.reserve()!;
  assert.equal(store.claimOwner('departed-owner'), true);
  assert.equal(store.update(original.identity, { stage: 'sso-creating' }, original, 'departed-owner'), true);
  store.releaseOwner('departed-owner');
  let requests = 0;
  const adapter = realProvisioner(store, options, { enterpriseProfile: () => fixtureProfile(options), verifyReadiness: async () => {}, creationCapacity: async () => true,
    async fetch() { requests++; throw new Error('Inherited unknown must never replay SSO'); } });
  const worker = new PrewarmWorker(store, adapter, 60000, 1);
  try {
    assert.equal(store.enterpriseOverview().supply.pendingSupply, 0);
    await worker.tick();
    const row = store.inventory(original.identity)!;
    assert.equal(row.state, 'failed'); assert.equal(row.last_error, 'sso_creation_ambiguous'); assert.equal(row.attempts, 3);
    assert.equal(row.attempt_id, original.attempt_id); assert.equal(row.stage, 'sso-creating');
    assert.equal(requests, 0); assert.equal(store.counts().total, 1);
    assert.equal(store.enterpriseOverview().supply.pendingSupply, 0);
  } finally { await worker.stop(); db.close(); }
});
