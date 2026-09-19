import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { parseEnterpriseRegistryV3, type EnterpriseRegistryV3, type EnterpriseValidationEvidenceV1 } from '@ghcp/shared';
import { enterpriseRegistryHashV3 } from '@ghcp/shared/enterpriseRuntimeV3';
import { enterpriseProfileIdentityHashV4 } from '@ghcp/shared/enterpriseRuntimeV4';
import { initEnterpriseSqliteV4, validateEnterpriseSqliteV4, registerEnterpriseSqliteV4 } from '@ghcp/shared/enterpriseStorageV4';
import { initEnterpriseSqliteV3 } from '@ghcp/shared/enterpriseStorageV3';
import { readPoolConfig, UserPoolError } from './config.js';
import { UserPoolStore, type Inventory } from './store.js';
import { accountName } from './names.js';
import { enterpriseScores, rankEnterprises, enterprisePolicyReady, logicalSupplySql } from './enterpriseScheduling.js';

const IDS = [1, 2, 3].map(n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const caller = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
function registryFor(caps: number[]): EnterpriseRegistryV3 {
  return parseEnterpriseRegistryV3({ version: 3, registryRevision: 1, legacyEnterpriseId: IDS[0], profiles: caps.map((cap, i) => ({
    id: IDS[i], slug: `enterprise-${i}`, shortcode: `test${i}`, accountDomain: `accounts${i}.example.test`, revision: i + 1,
    maxAccounts: cap,
    routes: { proxyInternalUrl: `http://127.0.0.1:${3100 + i}`, ssoInternalUrl: `http://127.0.0.1:${7100 + i * 2}`,
      loginInternalUrl: `http://127.0.0.1:${7101 + i * 2}`, ssoPublicUrl: `http://127.0.0.1:${7100 + i * 2}` },
    sso: { entityId: `urn:test:${i}`, ssoUrl: `http://127.0.0.1:${7100 + i * 2}${i ? `/profiles/${IDS[i]}` : ''}/sso`, loginUrl: `http://127.0.0.1:${7100 + i * 2}${i ? `/profiles/${IDS[i]}` : ''}/login`,
      logoutUrl: `http://127.0.0.1:${7100 + i * 2}${i ? `/profiles/${IDS[i]}` : ''}/logout`, spEntityId: `urn:sp:${i}`, spAcsUrl: 'https://github.example.test/saml/consume',
      scimBaseUrl: 'https://api.github.example.test/scim', githubApiBaseUrl: 'https://api.github.example.test',
      emailDomain: 'example.test', userPrefix: `user${i}`, signingCertRef: { env: 'TEST_CERT' }, signingKeyRef: { env: 'TEST_KEY' },
      sessionSecretRef: { env: 'TEST_SESSION' } },
    login: { provider: 'custom', allowedLoginUrls: [`http://127.0.0.1:${7100 + i * 2}${i ? `/profiles/${IDS[i]}` : ''}/login`], selectors: {} },
  })) });
}
function evidence(registry: EnterpriseRegistryV3, id: string, now: number): EnterpriseValidationEvidenceV1 {
  const profile = registry.profiles.find(profile => profile.id === id)!;
  const common = { enterpriseId: id, enterpriseRevision: profile.revision, profileIdentitySha256: enterpriseProfileIdentityHashV4(profile),
    registryRevision: registry.registryRevision, registrySha256: enterpriseRegistryHashV3(registry), legacyEnterpriseId: registry.legacyEnterpriseId };
  const probe = { probeVersion: 1 as const, schemaVersion: 3, contractVersion: 2 as const,
    capability: 'enterprise-isolation-legacy-pool', ready: true, blockers: [], ...common };
  return { version: 1, ...common, checkedAt: now, sso: { ...probe, component: 'sso' }, login: { ...probe, component: 'login' } };
}
function fixture(t: TestContext, caps = [9, 1], target = 10, activate = true) {
  const registry = registryFor(caps);
  const options = readPoolConfig({ ACCOUNT_ROUTING_MODE: 'caller-lease', POOL_ACCOUNT_EMAIL_DOMAIN: registry.profiles[0].accountDomain,
    POOL_WARMUP_MODEL: 'synthetic-model', READY_IDLE_TARGET: '0', POOL_MAX_ACCOUNTS: '10000' });
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  initEnterpriseSqliteV4(db, 'proxy', registry, { layout: 'pool', pool: { fingerprint: 'a'.repeat(64), settings: {
    version: 1, idle_target: target, lease_seconds: 3600, paused: 1, next_ordinal: 0, account_domain: options.accountDomain, owner: null, owner_until: 0,
  } } });
  const clock = { now: Date.now() + 1000 };
  const store = new UserPoolStore(db, options, registry); store.now = () => clock.now;
  const enable = (id: string) => {
    let policy = store.enterprisePolicy(id)!;
    policy = store.updateEnterprisePolicy(id, policy.policyVersion, { type: 'validate', evidence: evidence(registry, id, clock.now) });
    return store.updateEnterprisePolicy(id, policy.policyVersion, { type: 'activate', evidence: evidence(registry, id, clock.now) });
  };
  if (activate) { for (const profile of registry.profiles) enable(profile.id); store.updateSettings(1, { paused: 0 }); }
  t.after(() => db.close());
  const member = (enterprise: number, state = 'ready', patch: Partial<Inventory> = {}) => {
    const ordinal = (db.prepare('SELECT next_ordinal n FROM user_pool_settings').get() as { n: number }).n;
    const identity = accountName(ordinal); const timestamp = new Date(clock.now).toISOString();
    db.prepare(`INSERT INTO proxy_accounts(enterprise_id,account_incarnation,identity,sso_user,gh_login,copilot_oauth_status,copilot_oauth_token,created_at,updated_at)
      VALUES(?,?,?,?,?,'valid',?,?,?)`).run(IDS[enterprise], randomUUID(), identity, identity, identity, `token-${ordinal}`, timestamp, timestamp);
    db.prepare(`INSERT INTO user_pool_accounts(identity,ordinal,state,stage,attempt_id,retry_at,updated_at,verified_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(identity, ordinal, state, state === 'ready' ? 'ready' : 'new', randomUUID(), clock.now, clock.now, state === 'ready' ? clock.now : null);
    db.prepare('UPDATE user_pool_settings SET next_ordinal=next_ordinal+1').run();
    if (Object.keys(patch).length) db.prepare(`UPDATE user_pool_accounts SET ${Object.keys(patch).map(key => `${key}=?`).join(',')} WHERE identity=?`)
      .run(...Object.values(patch), identity);
    return store.inventory(identity)!;
  };
  return { db, store, registry, options, clock, member, enable };
}
function code(action: () => unknown, expected: string): void {
  assert.throws(action, error => error instanceof UserPoolError && error.code === expected);
}
const scenario = (caps: number[], inventories: number[]) => caps.map((cap, i) => ({ enterpriseId: IDS[i], state: 'active' as const,
  maxAccounts: cap, inventory: inventories[i], eligibleIdle: 1, pendingSupply: 0 }));

test('current share scorer uses N*C-C*N, retains capfull/blocked denominator, registry-order-independent ties', () => {
  assert.equal(rankEnterprises(scenario([9, 1], [1, 0]), { kind: 'creation', ordinal: 0 })[0].enterpriseId, IDS[1]);
  assert.equal(rankEnterprises(scenario([600, 300, 100], [50, 23, 27]), { kind: 'creation', ordinal: 0 })[0].enterpriseId, IDS[0]);
  const rows = scenario([5, 3, 2], [5, 1, 0]); rows[0].eligibleIdle = 0;
  const scores = enterpriseScores(rows.map((row, i) => ({ ...row, eligible: i !== 0 })));
  assert.deepEqual(scores.map(row => row.score), [-20, 8, 12]);
  assert.deepEqual(enterpriseScores(scenario([500, 300, 200], [0, 0, 0])).map(row => row.score), [0, 0, 0]);
  assert.equal(rankEnterprises(scenario([500, 300, 200], [0, 0, 0]), { kind: 'creation', ordinal: 99 })[0].enterpriseId, IDS[0]);
  const tied = scenario([5, 5], [0, 0]);
  for (const tie of [{ kind: 'creation' as const, ordinal: 1 }, { kind: 'admission' as const, caller: caller(8) }]) {
    assert.deepEqual(rankEnterprises(tied, tie), rankEnterprises([...tied].reverse(), tie));
  }
  assert.equal(rankEnterprises(rows, { kind: 'admission', caller: caller(1) }).some(row => row.enterpriseId === IDS[0]), false);
  rows[0].eligibleIdle = 1;
  assert.equal(rankEnterprises(rows, { kind: 'admission', caller: caller(1) }).some(row => row.enterpriseId === IDS[0]), true);
});

test('new v4 installation is paused/draft; settings capacity derives caps, target independent, max mutation rejects', t => {
  const f = fixture(t, [9, 1], 50, false);
  assert.equal(f.store.settings().max_accounts, 10); assert.equal(f.store.settings().active_max_accounts, 0);
  assert.equal(f.store.settings().paused, 1); assert.equal(f.store.reserve(), undefined);
  assert.equal(f.store.enterprisePolicies().every(row => row.state === 'draft'), true);
  code(() => f.store.updateSettings(1, { max_accounts: 10 }), 'invalid_pool_settings');
  assert.equal(f.store.updateSettings(1, { idle_target: 10000 }).idle_target, 10000);
  code(() => f.store.updateSettings(2, { idle_target: 10001 }), 'invalid_pool_settings');
  code(() => f.store.updateSettings(1, { idle_target: 0 }), 'settings_version_conflict');
  assert.equal(f.store.enterpriseOverview().supply.deficit, 10000);
});

test('strict policy CAS lifecycle evidence rejects wrong pair, stale, future, extra keys and unsafe direct activate', t => {
  const f = fixture(t, [9, 1], 10, false); const id = IDS[0];
  code(() => f.store.updateEnterprisePolicy(id, 1, { type: 'activate', evidence: evidence(f.registry, id, f.clock.now) }), 'invalid_policy_transition');
  for (const modify of [
    (e: EnterpriseValidationEvidenceV1) => { e.login.enterpriseId = IDS[1]; },
    (e: EnterpriseValidationEvidenceV1) => { e.checkedAt = f.clock.now - 300001; },
    (e: EnterpriseValidationEvidenceV1) => { e.checkedAt = f.clock.now + 1; },
    (e: EnterpriseValidationEvidenceV1) => { Object.assign(e, { extra: true }); },
    (e: EnterpriseValidationEvidenceV1) => { e.registrySha256 = '0'.repeat(64); e.sso.registrySha256 = e.registrySha256; e.login.registrySha256 = e.registrySha256; },
  ]) {
    const e = evidence(f.registry, id, f.clock.now); modify(e);
    code(() => f.store.updateEnterprisePolicy(id, 1, { type: 'validate', evidence: e }), 'invalid_readiness_evidence');
  }
  const active = f.enable(id); assert.equal(active.state, 'active');
  code(() => f.store.updateEnterprisePolicy(id, 1, { type: 'cap', maxAccounts: 8 }), 'policy_version_conflict');
  code(() => f.store.updateEnterprisePolicy(id, active.policyVersion, { type: 'validate', evidence: evidence(f.registry, id, f.clock.now) }), 'invalid_policy_transition');
  const drain = f.store.updateEnterprisePolicy(id, active.policyVersion, { type: 'drain' });
  code(() => f.store.updateEnterprisePolicy(id, drain.policyVersion, { type: 'activate', evidence: evidence(f.registry, id, f.clock.now) }), 'invalid_policy_transition');
  assert.equal(f.enable(id).state, 'active');
  validateEnterpriseSqliteV4(f.db, 'proxy', f.registry);
});

test('cap edits preserve identity/evidence, all inventory counts enforce lowered cap without eviction', t => {
  const f = fixture(t, [9, 1]);
  for (const state of ['ready', 'disabled', 'failed', 'cooling', 'provisioning']) f.member(0, state);
  const before = f.store.enterprisePolicy(IDS[0])!;
  const after = f.store.updateEnterprisePolicy(IDS[0], before.policyVersion, { type: 'cap', maxAccounts: 2 });
  assert.equal(after.identitySha256, before.identitySha256); assert.deepEqual(after.validationEvidence, before.validationEvidence);
  assert.equal(f.store.enterpriseOverview().enterprises[0].counts.total, 5); assert.equal(f.store.enterpriseOverview().enterprises[0].overCap, true);
  assert.equal(f.store.settings().max_accounts, 3); assert.equal(f.store.settings().active_max_accounts, 3);
  assert.equal(f.store.reserve()!.enterprise_id, IDS[1]); assert.equal(f.store.reserve(), undefined);
  assert.equal(f.store.counts(IDS[0]).total, 5);
  validateEnterpriseSqliteV4(f.db, 'proxy', f.registry);
});

test('registration starts largest empty cap then recomputes every insertion: 500/300/200 with target 50', t => {
  const f = fixture(t, [500, 300, 200], 50); assert.equal(f.store.claimOwner('owner'), true);
  assert.equal(f.store.reserveDeficit('owner'), 50);
  assert.deepEqual(IDS.map(id => f.store.counts(id).total), [25, 15, 10]);
  assert.equal(f.store.reserveDeficit('owner'), 0); assert.equal(f.store.reserve(), undefined);
  assert.equal(f.store.enterpriseOverview().supply.pendingSupply, 50);
});

test('actual production reservation chooses B for 9/1 at 1/0 and A for 600/300/100 at 50/23/27', t => {
  const f = fixture(t); f.member(0, 'failed', { attempts: 3 });
  assert.equal(f.store.reserve()!.enterprise_id, IDS[1]);
  const g = fixture(t, [600, 300, 100], 1);
  for (const [enterprise, total] of [50, 23, 27].entries()) for (let n = 0; n < total; n++) g.member(enterprise, 'disabled');
  assert.equal(g.store.reserve()!.enterprise_id, IDS[0]);
});

test('global idle sufficiency prevents proportional catchup allocation for new zero-inventory enterprise', t => {
  const f = fixture(t, [9, 1], 5);
  for (let n = 0; n < 5; n++) f.member(0);
  assert.equal(f.store.reserve(), undefined); assert.equal(f.store.counts(IDS[1]).total, 0);
  assert.equal(f.store.enterpriseOverview().supply.deficit, 0);
});

test('TTL/cooling cleanup lag is logical idle, read-only overview does not reclaim or allocate extra', t => {
  const f = fixture(t, [9, 1], 3); const ids = [f.member(0), f.member(0), f.member(0)];
  const lease = f.store.acquire(caller(1)); f.store.finish(lease, true);
  f.db.prepare('UPDATE user_pool_leases SET expires_at=?').run(f.clock.now - 1);
  f.db.prepare("UPDATE user_pool_accounts SET state='cooling',cooldown_until=? WHERE identity=?").run(f.clock.now - 1, ids[1].identity);
  const before = f.db.serialize(); const view = f.store.enterpriseOverview();
  assert.equal(view.supply.eligibleIdle, 3); assert.equal(view.supply.deficit, 0); assert.deepEqual(f.db.serialize(), before);
  assert.equal(f.store.reserve(), undefined); assert.equal(f.store.counts().total, 3);
  assert.equal((f.db.prepare('SELECT COUNT(*) n FROM user_pool_leases').get() as { n: number }).n, 1);
});

test('logical P deduplicates and excludes leased, held, futurecooling, manual/unknown and exhausted obligations', t => {
  const f = fixture(t, [100, 100], 10);
  const advancing = f.member(0, 'provisioning');
  f.member(0, 'failed', { attempts: 1, retry_at: f.clock.now + 100000 });
  f.member(0, 'failed', { attempts: 3 });
  f.member(0, 'failed', { attempts: 1, last_error: 'oauth_dispatch_unconfirmed', stage: 'oauth-dispatch' });
  f.member(0, 'provisioning', { stage: 'sso-creating' });
  f.member(0, 'failed', { cooldown_until: f.clock.now + 10000 });
  const leased = f.member(1); const held = f.store.acquire(caller(2));
  assert.equal(held.member_identity, leased.identity);
  f.db.prepare("UPDATE user_pool_accounts SET state='failed',attempts=1,stage='synced' WHERE identity=?").run(leased.identity);
  assert.equal(f.store.enterpriseOverview().supply.pendingSupply, 2);
  const sql = logicalSupplySql(String(f.clock.now));
  assert.equal((f.db.prepare(`SELECT COUNT(*) n FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity WHERE ${sql.pendingSupply}`).get() as { n: number }).n, 2);
  assert.equal(f.store.inventory(advancing.identity)!.enterprise_id, IDS[0]);
});

test('admission uses score not utilization and rents cap-full existing idle', t => {
  const f = fixture(t, [9, 1], 0); const a = f.member(0); const b = f.member(1);
  assert.equal(f.store.acquire(caller(1)).member_identity, a.identity);
  assert.equal(f.store.acquire(caller(2)).member_identity, b.identity);
  assert.equal(f.store.acquire(caller(2)).enterprise_revision, 2);
  code(() => f.store.acquire(caller(3)), 'pool_exhausted');
});

test('draining blocks new inference and every new catalog hold, retains old lease requests and finish', t => {
  const f = fixture(t); const member = f.member(0); const first = f.store.acquire(caller(1));
  f.store.finish(first, true); const policy = f.store.enterprisePolicy(IDS[0])!;
  f.store.updateEnterprisePolicy(IDS[0], policy.policyVersion, { type: 'drain' });
  const existing = f.store.acquire(caller(1)); assert.equal(existing.member_identity, member.identity);
  assert.equal(f.store.heartbeat(existing), true);
  code(() => f.store.acquireCatalog(caller(1)), 'enterprise_not_active');
  f.store.finish(existing, true); assert.equal(f.store.leases()[0].phase, 'active');
  code(() => f.store.acquire(caller(2)), 'pool_exhausted');
});

test('catalog-only affinity in draining rejects new lease without selecting another enterprise', t => {
  const f = fixture(t); const a = f.member(0); f.member(1);
  const catalog = f.store.acquireCatalog(caller(1)); assert.equal(catalog.member_identity, a.identity);
  const policy = f.store.enterprisePolicy(IDS[0])!;
  f.store.updateEnterprisePolicy(IDS[0], policy.policyVersion, { type: 'drain' });
  code(() => f.store.acquire(caller(1)), 'enterprise_not_active');
  assert.equal(f.store.leases().length, 0); assert.equal(f.store.heartbeat(catalog), true);
  f.store.finish(catalog, true); assert.equal(f.store.acquire(caller(1)).enterprise_id, IDS[1]);
});

test('scope filters list/count/page/actions; omitted membership stays legacy, durable events survive deletion', t => {
  const f = fixture(t); const a = f.member(0); const b = f.member(1);
  assert.equal(f.store.managesSsoUser(b.identity), false); assert.equal(f.store.managesSsoUser(b.identity, IDS[1]), true);
  assert.equal(f.store.accounts(IDS[1]).length, 1); assert.equal(f.store.counts(IDS[1]).total, 1);
  code(() => f.store.disable(b.identity, IDS[0]), 'member_not_found'); code(() => f.store.retry(b.identity, IDS[0]), 'member_not_found');
  const held = f.store.acquire(caller(1)); f.store.finish(held, true);
  code(() => f.store.release(held.lease_id, IDS[1]), 'lease_not_found');
  assert.equal(f.store.page('leases', { page: 1, pageSize: 10, enterpriseId: IDS[1] }).total, 0);
  assert.equal(f.store.page('accounts', { page: 1, pageSize: 1, enterpriseId: IDS[0], q: a.identity }).total, 1);
  f.store.event('synthetic_scoped', b.identity); f.store.event('synthetic_global');
  f.db.prepare('DELETE FROM user_pool_accounts WHERE identity=?').run(b.identity);
  f.db.prepare('DELETE FROM proxy_accounts WHERE identity=?').run(b.identity);
  const events = f.store.page('events', { page: 1, pageSize: 10, enterpriseId: IDS[1] });
  assert.equal(events.total, 1); assert.equal((events.items[0] as { enterprise_id: string }).enterprise_id, IDS[1]);
  assert.equal(f.store.events(IDS[1]).length, 1);
  assert.equal((f.store.events() as { action: string }[]).some(row => row.action === 'synthetic_global'), true);
});

test('draining observation preserves dispatched nonce/task/reservation; no new idle dispatch or credential attempt', t => {
  const f = fixture(t); const idle = f.member(0, 'provisioning', { stage: 'oauth-starting', oauth_attempt_id: randomUUID() });
  const inflight = f.member(0, 'provisioning', { stage: 'oauth-wait', oauth_attempt_id: randomUUID(), task_id: 'synthetic-task' });
  const policy = f.store.enterprisePolicy(IDS[0])!; f.store.updateEnterprisePolicy(IDS[0], policy.policyVersion, { type: 'drain' });
  assert.equal(f.store.canProvision(idle.identity), false); assert.equal(f.store.canProvision(inflight.identity), false);
  assert.equal(f.store.canProvision(inflight.identity, 'observe'), true); assert.equal(f.store.claimOwner('owner'), true);
  assert.equal(f.store.claimLoginDispatch(idle.identity, idle, 'owner', 5), false);
  assert.equal(f.store.mutateWorkerCredential(idle.identity, idle, 'owner', { type: 'begin', oauthAttemptId: idle.oauth_attempt_id! }), false);
  assert.equal(f.store.pending()!.identity, inflight.identity);
  const draining = f.store.enterprisePolicy(IDS[0])!;
  f.store.updateEnterprisePolicy(IDS[0], draining.policyVersion, { type: 'validate', evidence: evidence(f.registry, IDS[0], f.clock.now) });
  assert.equal(f.store.canProvision(inflight.identity, 'observe'), true);
  assert.equal(f.store.canProvision(idle.identity), false);
  assert.equal(f.store.pending()!.identity, inflight.identity);
  assert.equal(f.store.update(inflight.identity, { stage: 'warmup' }, inflight, 'owner'), true);
  assert.equal(f.store.inventory(inflight.identity)!.oauth_attempt_id, inflight.oauth_attempt_id);
  assert.equal(f.store.inventory(inflight.identity)!.task_id, 'synthetic-task');
  assert.equal(f.store.canProvision(inflight.identity, 'observe'), false);
});

test('held enterprise tampering and generation fences cannot renew or release someone else hold', t => {
  const f = fixture(t); f.member(0); const held = f.store.acquire(caller(1));
  const fake = { ...held, enterprise_id: IDS[1] };
  assert.equal(f.store.heartbeat(fake), false); f.store.finish(fake, true); assert.equal(f.store.heartbeat(held), true);
  const member = f.store.inventory(held.member_identity)!;
  f.store.update(member.identity, { state: 'failed' }, member);
  assert.equal(f.store.heartbeat(held), false); assert.equal(f.store.update(member.identity, { stage: 'ready' }, member), false);
  f.store.finish(held, true); assert.equal(f.store.leases().length, 0);
});

test('offline enterprise append and restart preserve global target, existing names and next ordinal', t => {
  const f = fixture(t, [5], 2); f.member(0); f.member(0);
  const before = f.db.prepare('SELECT identity,ordinal FROM user_pool_accounts ORDER BY ordinal').all();
  f.store.updateSettings(f.store.settings().version, { paused: 1 });
  const next = parseEnterpriseRegistryV3({ ...registryFor([5, 5]), registryRevision: 2 });
  registerEnterpriseSqliteV4(f.db, 'proxy', f.registry, next);
  const restarted = new UserPoolStore(f.db, f.options, next); restarted.now = () => f.clock.now;
  let policy = restarted.enterprisePolicy(IDS[1])!;
  const proof = evidence(next, IDS[1], f.clock.now);
  policy = restarted.updateEnterprisePolicy(IDS[1], policy.policyVersion, { type: 'validate', evidence: proof });
  restarted.updateEnterprisePolicy(IDS[1], policy.policyVersion, { type: 'activate', evidence: proof });
  restarted.updateSettings(restarted.settings().version, { paused: 0 });
  assert.equal(restarted.settings().idle_target, 2);
  assert.equal(restarted.reserve(), undefined, 'appending an enterprise cannot start ratio-only creation');
  assert.deepEqual(f.db.prepare('SELECT identity,ordinal FROM user_pool_accounts ORDER BY ordinal').all(), before);
  assert.equal(restarted.enterpriseOverview().names.nextOrdinal, 2);
  restarted.updateSettings(restarted.settings().version, { idle_target: 3 });
  const created = restarted.reserve()!;
  assert.equal(created.enterprise_id, IDS[1]); assert.equal(created.ordinal, 2); assert.equal(created.identity, accountName(2));
  assert.equal(new Set(restarted.accounts().map(row => (row as { identity: string }).identity)).size, 3);
  assert.equal(restarted.enterpriseOverview().names.nextOrdinal, 3);
});

test('shared global name cursor consumes collisions and directory exhaustion cannot exceed cap or target', t => {
  const f = fixture(t, [9, 1], 10);
  const timestamp = new Date(f.clock.now).toISOString();
  f.db.prepare(`INSERT INTO proxy_accounts(enterprise_id,account_incarnation,identity,sso_user,copilot_oauth_status,created_at,updated_at)
    VALUES(?,?,?,?,'missing',?,?)`).run(IDS[1], randomUUID(), 'collision', accountName(0), timestamp, timestamp);
  assert.equal(f.store.reserve()!.ordinal, 1);
  f.db.prepare('UPDATE user_pool_settings SET next_ordinal=10000').run();
  code(() => f.store.reserve(), 'name_catalog_exhausted');
  assert.equal(f.store.enterpriseOverview().names.remainingPositions, 0);
  assert.equal(f.store.enterpriseOverview().blockedReasons.includes('name_catalog_exhausted'), true);
});

test('worker credential authorization and Login reservations carry authoritative nonlegacy UUID and revision', t => {
  const f = fixture(t); const nonce = randomUUID();
  const row = f.member(1, 'provisioning', { stage: 'oauth-starting', oauth_attempt_id: nonce });
  f.db.prepare('UPDATE proxy_accounts SET gh_login=? WHERE identity=?').run('synthetic-user', row.identity);
  assert.equal(f.store.claimOwner('owner'), true);
  assert.equal(f.store.mutateWorkerCredential(row.identity, f.store.inventory(row.identity)!, 'owner', { type: 'begin', oauthAttemptId: nonce }), true);
  const attempt = f.db.prepare('SELECT enterprise_id,enterprise_revision,oauth_attempt_id FROM proxy_authorization_attempts WHERE identity=?').get(row.identity) as Record<string, unknown>;
  assert.deepEqual(attempt, { enterprise_id: IDS[1], enterprise_revision: 2, oauth_attempt_id: nonce });
  assert.equal(f.store.claimLoginDispatch(row.identity, f.store.inventory(row.identity)!, 'owner', 1), true);
  f.db.prepare("UPDATE user_pool_accounts SET state='failed',attempts=3 WHERE identity=?").run(row.identity);
  assert.equal(f.store.listLoginReservations()[0].enterprise_id, IDS[1]);
  assert.equal(f.store.listLoginReservations()[0].enterprise_revision, 2);
});

test('logical repair supply is stable before and after credential quarantine cleanup', t => {
  const f = fixture(t, [9, 1], 1); const member = f.member(0);
  f.db.prepare("UPDATE proxy_accounts SET copilot_oauth_status='expired',copilot_oauth_token=NULL WHERE identity=?").run(member.identity);
  const before = f.store.enterpriseOverview().supply;
  assert.equal(before.pendingSupply, 1); assert.equal(before.eligibleIdle, 0); assert.equal(before.deficit, 0);
  assert.equal(f.store.reserve(), undefined);
  f.store.reclaim(); assert.deepEqual(f.store.enterpriseOverview().supply, before);
});

test('lease-bound repair permission survives drain/revalidation without allowing new idle work', t => {
  const f = fixture(t); const member = f.member(0); const held = f.store.acquire(caller(1)); f.store.finish(held, true);
  const policy = f.store.enterprisePolicy(IDS[0])!;
  const draining = f.store.updateEnterprisePolicy(IDS[0], policy.policyVersion, { type: 'drain' });
  f.db.prepare("UPDATE user_pool_accounts SET state='failed',stage='synced',attempts=0 WHERE identity=?").run(member.identity);
  assert.equal(f.store.canProvision(member.identity), true);
  f.store.updateEnterprisePolicy(IDS[0], draining.policyVersion, { type: 'validate', evidence: evidence(f.registry, IDS[0], f.clock.now) });
  assert.equal(f.store.canProvision(member.identity), true);
  f.db.prepare('UPDATE user_pool_leases SET expires_at=?').run(f.clock.now - 1);
  assert.equal(f.store.canProvision(member.identity), false);
});

test('unknown/manual external evidence never resets nonce or task by retry in a different scope', t => {
  const f = fixture(t); const nonce = randomUUID();
  const row = f.member(1, 'failed', { stage: 'oauth-dispatch', attempts: 3, last_error: 'oauth_dispatch_ambiguous', oauth_attempt_id: nonce, task_id: 'unknown-task' });
  const before = f.store.inventory(row.identity)!;
  code(() => f.store.retry(row.identity, IDS[0]), 'member_not_found');
  code(() => f.store.retry(row.identity, IDS[1]), 'manual_reconciliation_required');
  assert.deepEqual(f.store.inventory(row.identity), before);
});

test('same caller concurrent SQLite connections converge; concurrent creation respects global D and per-enterprise caps', async t => {
  const f = fixture(t, [1, 1], 1); f.member(0); f.member(1);
  const dir = mkdtempSync(join(tmpdir(), 'phase4-pool-race-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'pool.sqlite'); writeFileSync(path, f.db.serialize());
  const workerSource = `(async () => {
    const { workerData: d, parentPort } = await import('node:worker_threads');
    const { tsImport } = await import('tsx/esm/api');
    const { UserPoolStore } = await tsImport(d.storeUrl, d.storeUrl);
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(d.path); db.pragma('foreign_keys=ON'); db.pragma('busy_timeout=10000');
    try {
      const store = new UserPoolStore(db, d.options, d.registry); store.now = () => d.now;
      parentPort.postMessage({ ready: true }); Atomics.wait(new Int32Array(d.barrier), 0, 0);
      try { parentPort.postMessage({ result: d.operation==='acquire' ? store.acquire(d.caller) : store.reserve() }); }
      catch(e) { parentPort.postMessage({ error: e.code || e.message }); }
    } finally { db.close(); }
  })().catch(e => { throw e; });`;
  async function race(operation: 'acquire' | 'reserve', registry: EnterpriseRegistryV3, options: typeof f.options) {
    const barrier = new SharedArrayBuffer(4);
    const workers = [0, 1].map(() => new Worker(workerSource, { eval: true, workerData: { path, registry, options,
      storeUrl: new URL('./store.ts', import.meta.url).href, now: f.clock.now, barrier, operation, caller: caller(1) } }));
    t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
    const results: Promise<{ result?: Inventory | { lease_id: string }; error?: string }>[] = [];
    const ready = workers.map(worker => new Promise<void>((resolve, reject) => {
      let ready = false;
      results.push(new Promise((done, failed) => {
        worker.on('message', message => { if (message.ready) { ready = true; resolve(); } else done(message); });
        worker.once('error', error => { reject(error); failed(error); });
        worker.once('exit', code => { if (!ready || code !== 0) { const error = new Error(`worker exit ${code}`); reject(error); failed(error); } });
      }));
    }));
    const exited = workers.map(worker => new Promise<void>((resolve, reject) => {
      worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)));
      worker.once('error', reject);
    }));
    await Promise.all(ready); Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
    const completed = await Promise.all(results); await Promise.all(exited); return completed;
  }
  const acquired = await race('acquire', f.registry, f.options);
  assert.equal(acquired.every(row => !row.error && row.result && 'lease_id' in row.result), true);
  assert.equal((acquired[0].result as { lease_id: string }).lease_id, (acquired[1].result as { lease_id: string }).lease_id);
  const g = fixture(t, [1, 1], 1); writeFileSync(path, g.db.serialize());
  const reserved = await race('reserve', g.registry, g.options);
  assert.equal(reserved.filter(row => row.result).length, 1); assert.equal(reserved.some(row => row.error), false);
  const check = new Database(path); try {
    assert.equal((check.prepare('SELECT COUNT(*) n FROM user_pool_accounts').get() as { n: number }).n, 1);
  } finally { check.close(); }
});

test('migration-preserved legacy approval accepted only for legacy; new v3 runtime storage is rejected', t => {
  const f = fixture(t); const local = f.store.enterprisePolicy(IDS[0])!;
  const preserved = { ...local, validationKind: 'migration_preserved_v3' as const, validationEvidence: null };
  assert.equal(enterprisePolicyReady(preserved, f.registry.profiles[0], IDS[0]), true);
  assert.equal(enterprisePolicyReady({ ...preserved, enterpriseId: IDS[1], identitySha256: enterpriseProfileIdentityHashV4(f.registry.profiles[1]) }, f.registry.profiles[1], IDS[0]), false);
  const db = new Database(':memory:'); t.after(() => db.close()); db.pragma('foreign_keys=ON');
  initEnterpriseSqliteV3(db, 'proxy', f.registry, { layout: 'pool', pool: { fingerprint: 'a'.repeat(64), settings: {
    version: 1, idle_target: 0, lease_seconds: 3600, paused: 1, next_ordinal: 0, account_domain: f.options.accountDomain, owner: null, owner_until: 0,
  } } });
  assert.throws(() => new UserPoolStore(db, f.options, f.registry), /enterprise_v4_partial_or_unknown_schema/);
});
