import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import {
  DEFAULT_ENTERPRISE_ID,
  planCreations,
  rankEnterprisesForAdmission,
  rankEnterprisesForCreation,
  type EnterpriseLifecycleState,
  type PoolEnterprise,
} from '@ghcp/shared';
import { UserPoolError } from './config.js';
import type { HeldLease, Inventory } from './store.js';
import type { PoolStore } from './storage.js';

/**
 * Design §9.3: one scenario set for both pool backends. `storeContract` runs every scenario against a backend, and
 * each scenario's expected enterprise sequence comes from the shared ranking functions, so SQLite and MySQL are held
 * to the same selection for the same inputs. Test-only module; it is not imported by production code.
 */
export interface ContractBackend {
  /** The store under test. */
  store: PoolStore;
  /** A second store on the same database through another connection (SQLite) or pool (MySQL). */
  replica: PoolStore;
  /** Portable SQL against the same database (`?` placeholders); returns rows for SELECT. */
  sql(statement: string, values?: unknown[]): Promise<Record<string, unknown>[]>;
  /** Records every statement the primary store sends while `run` executes. */
  recordStatements<T>(run: () => Promise<T>): Promise<{ result: T; statements: string[] }>;
}

interface EnterpriseSetup {
  id: string;
  cap: number;
  state?: EnterpriseLifecycleState;
}

const BETA = 'beta';
const GAMMA = 'gamma';
const AGGREGATE = /\b(?:COUNT|SUM|MAX|MIN|AVG)\s*\(|\bGROUP\s+BY\b/i;
const POOL_TABLES = [
  'user_pool_holds', 'user_pool_catalog_holds', 'user_pool_catalog_cooldowns', 'user_pool_leases',
  'user_pool_accounts', 'user_pool_events', 'proxy_request_stats', 'proxy_accounts',
];
const caller = (n: number): string => `sha256:${n.toString(16).padStart(64, '0')}`;

export async function storeContract(t: TestContext, backend: ContractBackend): Promise<void> {
  const scenarios: Array<[string, (backend: ContractBackend) => Promise<void>]> = [
    ['one replenishment batch fills 500/300/200 from empty as 25/15/10 for T=50', replenishmentShares],
    ['replenishment issues at most one aggregate per batch; admission issues none', aggregateQueries],
    ['enterprise caps bound creation, and a raised cap resumes it', capBoundary],
    ['an ineligible active enterprise still counts in the share denominators', ineligibleDenominator],
    ['draining keeps existing leases but admits no new lease or catalog hold', drainingAdmission],
    ['admission follows each caller\'s deterministic enterprise ranking', admissionRanking],
    ['one caller keeps one lease and member across replicas', replicaConvergence],
    ['inventory drift is recounted and recorded per enterprise', inventoryDrift],
    ['policy edits are compare-and-set, capacity-bounded and follow the lifecycle', policyEdits],
    ['global settings reject the cap, which belongs to each enterprise', settingsWithoutCap],
    ['reads are scoped to one enterprise; counts may be global', scopedReads],
  ];
  for (const [name, scenario] of scenarios) {
    await t.test(name, async () => {
      await reset(backend);
      await scenario(backend);
    });
  }
}

async function replenishmentShares(backend: ContractBackend): Promise<void> {
  const enterprises = [{ id: DEFAULT_ENTERPRISE_ID, cap: 500 }, { id: BETA, cap: 300 }, { id: GAMMA, cap: 200 }];
  await defineEnterprises(backend, enterprises, 50);
  const reserved = await fill(backend, allIds(enterprises));
  assert.equal(reserved, 50);
  const expected = planCreations({ enterprises: emptyPool(enterprises), deficit: 50, ordinal: 0 });
  assert.deepEqual(await creationSequence(backend), expected);
  assert.deepEqual(await inventoryByEnterprise(backend), { [BETA]: 15, [DEFAULT_ENTERPRISE_ID]: 25, [GAMMA]: 10 });
  assert.deepEqual(await storedInventory(backend), await inventoryByEnterprise(backend));
}

async function aggregateQueries(backend: ContractBackend): Promise<void> {
  const enterprises = [{ id: DEFAULT_ENTERPRISE_ID, cap: 50 }, { id: BETA, cap: 50 }];
  await defineEnterprises(backend, enterprises, 6);
  const owner = await claimOwner(backend);
  const batch = await backend.recordStatements(async () => backend.store.reserveDeficit(owner, allIds(enterprises)));
  assert.equal(batch.result, 6);
  assert.equal(batch.statements.filter(isAggregate).length, 1, batch.statements.filter(isAggregate).join('\n---\n'));
  const members = await reservedMembers(backend);
  for (const member of members.slice(0, 2)) await makeReady(backend, member.identity);
  const admission = await backend.recordStatements(async () => backend.store.acquire(caller(1)));
  assert.ok(admission.result.member_identity);
  assert.deepEqual(admission.statements.filter(isAggregate), []);
  const catalog = await backend.recordStatements(async () => backend.store.acquireCatalog(caller(2)));
  assert.ok(catalog.result.member_identity);
  assert.deepEqual(catalog.statements.filter(isAggregate), []);
}

async function capBoundary(backend: ContractBackend): Promise<void> {
  const enterprises = [{ id: DEFAULT_ENTERPRISE_ID, cap: 2 }, { id: BETA, cap: 1 }];
  await defineEnterprises(backend, enterprises, 10);
  assert.equal(await fill(backend, allIds(enterprises)), 3);
  assert.equal(await backend.store.reserve(allIds(enterprises)), undefined);
  assert.deepEqual(await inventoryByEnterprise(backend), { [BETA]: 1, [DEFAULT_ENTERPRISE_ID]: 2 });
  const beta = await policy(backend, BETA);
  await backend.store.updateEnterprisePolicy(BETA, beta.policyVersion, { maxAccounts: 3 });
  assert.equal(await fill(backend, allIds(enterprises)), 2);
  assert.deepEqual(await inventoryByEnterprise(backend), { [BETA]: 3, [DEFAULT_ENTERPRISE_ID]: 2 });
  assert.equal(await fill(backend, allIds(enterprises)), 0);
}

/** 6/10/3 at 1/6/0: with B in the denominators A wins (S_A=23 > S_C=21 for N=7, C=19); without B, C would. */
async function ineligibleDenominator(backend: ContractBackend): Promise<void> {
  const enterprises = [{ id: DEFAULT_ENTERPRISE_ID, cap: 6 }, { id: BETA, cap: 10 }, { id: GAMMA, cap: 3 }];
  await defineEnterprises(backend, enterprises, 100);
  await reserveIn(backend, DEFAULT_ENTERPRISE_ID, 1);
  await reserveIn(backend, BETA, 6);
  const eligible = [DEFAULT_ENTERPRISE_ID, GAMMA];
  const rows = withInventory(enterprises, { [DEFAULT_ENTERPRISE_ID]: 1, [BETA]: 6 }, eligible);
  const ordinal = 7;
  const [expected] = rankEnterprisesForCreation({ enterprises: rows, ordinal });
  const [withoutBeta] = rankEnterprisesForCreation({ enterprises: rows.filter((row) => row.id !== BETA), ordinal });
  assert.deepEqual([expected, withoutBeta], [DEFAULT_ENTERPRISE_ID, GAMMA], 'the scenario must discriminate');
  const member = await backend.store.reserve(eligible);
  assert.equal(member?.enterprise_id, expected);
}

async function drainingAdmission(backend: ContractBackend): Promise<void> {
  const enterprises = [{ id: DEFAULT_ENTERPRISE_ID, cap: 10 }, { id: BETA, cap: 10 }];
  await defineEnterprises(backend, enterprises, 10);
  const [first, second] = await reserveIn(backend, DEFAULT_ENTERPRISE_ID, 2);
  const [betaMember] = await reserveIn(backend, BETA, 1);
  for (const member of [first, second]) await makeReady(backend, member.identity);
  const leased = await backend.store.acquire(caller(1));
  const catalog = await backend.store.acquireCatalog(caller(2));
  assert.deepEqual([leased.enterprise_id, catalog.enterprise_id], [DEFAULT_ENTERPRISE_ID, DEFAULT_ENTERPRISE_ID]);
  await backend.store.finish(leased, true);
  await setState(backend, DEFAULT_ENTERPRISE_ID, 'draining');
  await makeReady(backend, betaMember.identity);
  const kept = await backend.store.acquire(caller(1));
  assert.deepEqual([kept.lease_id, kept.member_identity], [leased.lease_id, leased.member_identity]);
  await backend.store.finish(kept, true);
  await rejectsCode(() => backend.store.acquireCatalog(caller(1)), 'enterprise_draining', 503);
  await rejectsCode(() => backend.store.acquire(caller(2)), 'enterprise_draining', 503);
  await rejectsCode(() => backend.store.acquireCatalog(caller(2)), 'enterprise_draining', 503);
  await backend.store.finish(catalog, false);
  const moved = await backend.store.acquire(caller(2));
  assert.deepEqual([moved.enterprise_id, moved.member_identity], [BETA, betaMember.identity]);
  await rejectsCode(() => backend.store.acquire(caller(3)), 'pool_exhausted', 429);
  await setState(backend, DEFAULT_ENTERPRISE_ID, 'active');
  const resumed = await backend.store.acquire(caller(3));
  assert.deepEqual([resumed.enterprise_id, resumed.member_identity], [DEFAULT_ENTERPRISE_ID, catalog.member_identity]);
}

async function admissionRanking(backend: ContractBackend): Promise<void> {
  const enterprises = [{ id: DEFAULT_ENTERPRISE_ID, cap: 10 }, { id: BETA, cap: 10 }];
  await defineEnterprises(backend, enterprises, 10);
  for (const enterprise of enterprises) {
    for (const member of await reserveIn(backend, enterprise.id, 2)) await makeReady(backend, member.identity);
  }
  const ranking = admissionInput(enterprises, 2);
  const chosen = new Set<string>();
  for (let n = 1; n <= 8; n++) {
    const [expected] = rankEnterprisesForAdmission({ enterprises: ranking, caller: caller(n) });
    for (let round = 0; round < 2; round++) {
      const held = await backend.store.acquire(caller(n));
      assert.equal(held.enterprise_id, expected, `caller ${n}, round ${round}`);
      await releaseLease(backend, held);
    }
    chosen.add(expected);
  }
  assert.equal(chosen.size, 2, 'the callers must exercise both enterprises');
}

async function replicaConvergence(backend: ContractBackend): Promise<void> {
  const enterprises = [{ id: DEFAULT_ENTERPRISE_ID, cap: 10 }, { id: BETA, cap: 10 }];
  await defineEnterprises(backend, enterprises, 10);
  for (const enterprise of enterprises) {
    for (const member of await reserveIn(backend, enterprise.id, 2)) await makeReady(backend, member.identity);
  }
  const held = await Promise.all([
    backend.store.acquire(caller(7)),
    backend.replica.acquire(caller(7)),
    backend.replica.acquireCatalog(caller(7)),
    backend.store.acquire(caller(7)),
  ]);
  assert.equal(new Set(held.map((lease) => lease.member_identity)).size, 1);
  assert.equal(new Set(held.map((lease) => lease.enterprise_id)).size, 1);
  assert.equal(new Set(held.filter((lease) => lease.kind !== 'catalog').map((lease) => lease.lease_id)).size, 1);
  const leases = await backend.replica.leases(held[0].enterprise_id);
  assert.deepEqual(leases.map((lease) => lease.caller_id), [caller(7)]);
}

async function inventoryDrift(backend: ContractBackend): Promise<void> {
  const enterprises = [{ id: DEFAULT_ENTERPRISE_ID, cap: 10 }, { id: BETA, cap: 10 }];
  await defineEnterprises(backend, enterprises, 10);
  await reserveIn(backend, BETA, 2);
  assert.equal(await backend.store.correctInventoryDrift(), 0);
  await backend.sql(`
    UPDATE proxy_enterprises
    SET inventory_count = 7
    WHERE id = ?`, [BETA]);
  assert.equal(await backend.store.correctInventoryDrift(), 1);
  assert.equal((await policy(backend, BETA)).inventoryCount, 2);
  assert.equal(await backend.replica.correctInventoryDrift(), 0);
  const events = await backend.sql(`
    SELECT enterprise_id
    FROM user_pool_events
    WHERE action = 'enterprise_inventory_drift'`);
  assert.deepEqual(events.map((row) => row.enterprise_id), [BETA]);
}

async function policyEdits(backend: ContractBackend): Promise<void> {
  await defineEnterprises(backend, [{ id: DEFAULT_ENTERPRISE_ID, cap: 100 }, { id: BETA, cap: 10, state: 'draft' },
    { id: GAMMA, cap: 10, state: 'draft' }], 10);
  await policyTransitions(backend);
  await policyValidation(backend);
  await policyCapacity(backend);
  await policyRace(backend);
}

async function policyTransitions(backend: ContractBackend): Promise<void> {
  const store = backend.store;
  const active = await store.updateEnterprisePolicy(BETA, 1, { state: 'active' });
  assert.deepEqual([active.state, active.policyVersion], ['active', 2]);
  await rejectsCode(() => store.updateEnterprisePolicy(BETA, 1, { maxAccounts: 5 }), 'policy_version_conflict', 409);
  await rejectsCode(() => store.updateEnterprisePolicy(BETA, 2, { state: 'draft' }), 'invalid_state_transition', 409);
  const draining = await store.updateEnterprisePolicy(BETA, 2, { state: 'draining' });
  await rejectsCode(() => store.updateEnterprisePolicy(BETA, 3, { state: 'draft' }), 'invalid_state_transition', 409);
  const resumed = await store.updateEnterprisePolicy(BETA, draining.policyVersion, { state: 'active' });
  assert.deepEqual([resumed.state, resumed.policyVersion], ['active', 4]);
  const skipActivation = () => store.updateEnterprisePolicy(GAMMA, 1, { state: 'draining' });
  await rejectsCode(skipActivation, 'invalid_state_transition', 409);
  await rejectsCode(() => store.updateEnterprisePolicy('missing', 1, { state: 'active' }), 'enterprise_not_found', 404);
}

async function policyValidation(backend: ContractBackend): Promise<void> {
  const invalid: unknown[] = [{}, { maxAccounts: 0 }, { maxAccounts: 10001 }, { maxAccounts: 1.5 },
    { state: 'validated' }, { other: 1 }, null, []];
  for (const patch of invalid) {
    const update = () => backend.store.updateEnterprisePolicy(GAMMA, 1, patch as never);
    await rejectsCode(update, 'invalid_pool_policy', 400);
  }
  await rejectsCode(() => backend.store.updateEnterprisePolicy(GAMMA, 0.5, { maxAccounts: 5 }), 'invalid_pool_policy');
  assert.equal((await policy(backend, GAMMA)).policyVersion, 1, 'rejected edits change nothing');
}

/** ΣC_e ≤ NAME_CAPACITY (10,000) across every enterprise, whatever its state. */
async function policyCapacity(backend: ContractBackend): Promise<void> {
  const others = 100 + 10;
  const update = (cap: number) => backend.store.updateEnterprisePolicy(GAMMA, 1, { maxAccounts: cap });
  await rejectsCode(() => update(10_000 - others + 1), 'name_capacity_exceeded', 409);
  const full = await update(10_000 - others);
  assert.equal(full.maxAccounts, 10_000 - others);
  const beta = await policy(backend, BETA);
  const raise = () => backend.store.updateEnterprisePolicy(BETA, beta.policyVersion, { maxAccounts: 11 });
  await rejectsCode(raise, 'name_capacity_exceeded', 409);
}

async function policyRace(backend: ContractBackend): Promise<void> {
  const version = (await policy(backend, BETA)).policyVersion;
  const writes = await Promise.allSettled([
    Promise.resolve().then(() => backend.store.updateEnterprisePolicy(BETA, version, { maxAccounts: 5 })),
    Promise.resolve().then(() => backend.replica.updateEnterprisePolicy(BETA, version, { maxAccounts: 6 })),
  ]);
  assert.equal(writes.filter((write) => write.status === 'fulfilled').length, 1);
  const lost = writes.find((write) => write.status === 'rejected');
  assert.ok(lost?.status === 'rejected' && lost.reason instanceof UserPoolError);
  assert.equal(lost.reason.code, 'policy_version_conflict');
  assert.equal((await policy(backend, BETA)).policyVersion, version + 1);
}

async function settingsWithoutCap(backend: ContractBackend): Promise<void> {
  const settings = await backend.store.settings();
  assert.equal('max_accounts' in settings, false);
  const update = (patch: unknown) => backend.store.updateSettings(settings.version, patch as never);
  await rejectsCode(() => update({ max_accounts: 5 }), 'use_enterprise_cap', 409);
  await rejectsCode(() => update({ idle_target: 1, max_accounts: 5 }), 'use_enterprise_cap', 409);
  await rejectsCode(() => update({ idle_target: 10_001 }), 'invalid_pool_settings', 400);
  const updated = await backend.store.updateSettings(settings.version, { idle_target: 10_000 });
  assert.deepEqual(updated, { ...settings, idle_target: 10_000, version: settings.version + 1 });
}

async function scopedReads(backend: ContractBackend): Promise<void> {
  const enterprises = [{ id: DEFAULT_ENTERPRISE_ID, cap: 10 }, { id: BETA, cap: 10 }];
  await defineEnterprises(backend, enterprises, 10);
  await reserveIn(backend, DEFAULT_ENTERPRISE_ID, 2);
  const [betaMember] = await reserveIn(backend, BETA, 1);
  await makeReady(backend, betaMember.identity);
  const held = await backend.store.acquire(caller(4));
  assert.equal(held.enterprise_id, BETA);
  const store = backend.store;
  assert.deepEqual(identities(await store.accounts(BETA)), [betaMember.identity]);
  assert.equal((await store.accounts(DEFAULT_ENTERPRISE_ID)).length, 2);
  assert.deepEqual((await store.leases(BETA)).map((lease) => lease.enterprise_id), [BETA]);
  assert.deepEqual(await store.leases(DEFAULT_ENTERPRISE_ID), []);
  assert.ok((await store.events(BETA)).every((event) => (event as { enterprise_id: string }).enterprise_id === BETA));
  assert.equal((await store.counts(BETA)).total, 1);
  assert.equal((await store.counts(BETA)).leased + (await store.counts(BETA)).provisional, 1);
  assert.equal((await store.counts()).total, 3);
  const page = await store.page('accounts', { enterpriseId: DEFAULT_ENTERPRISE_ID, page: 1, pageSize: 10 });
  assert.equal(page.total, 2);
  assert.equal((await store.page('leases', { enterpriseId: BETA, page: 1, pageSize: 10 })).total, 1);
  assert.equal(await store.managesSsoUser(BETA, betaMember.identity), true);
  assert.equal(await store.managesSsoUser(DEFAULT_ENTERPRISE_ID, betaMember.identity), false);
  assert.equal((await store.inventory(betaMember.identity))?.enterprise_id, BETA, 'inventory stays global');
}

async function reset(backend: ContractBackend): Promise<void> {
  for (const table of POOL_TABLES) await backend.sql(`DELETE FROM ${table}`);
  await backend.sql(`
    DELETE FROM proxy_enterprises
    WHERE id <> ?`, [DEFAULT_ENTERPRISE_ID]);
  await backend.sql(`
    UPDATE user_pool_settings
    SET version = 1, idle_target = 0, lease_seconds = 172800, paused = 0, next_ordinal = 0, owner = NULL,
      owner_until = 0
    WHERE id = 1`);
}

/** `default` takes the first entry's cap; the other enterprises are inserted. All start empty. */
async function defineEnterprises(backend: ContractBackend, enterprises: readonly EnterpriseSetup[],
  idleTarget: number): Promise<void> {
  for (const enterprise of enterprises) {
    if (enterprise.id === DEFAULT_ENTERPRISE_ID) await updateDefault(backend, enterprise);
    else await insertEnterprise(backend, enterprise);
  }
  await backend.sql(`
    UPDATE user_pool_settings
    SET idle_target = ?
    WHERE id = 1`, [idleTarget]);
}

async function updateDefault(backend: ContractBackend, enterprise: EnterpriseSetup): Promise<void> {
  await backend.sql(`
    UPDATE proxy_enterprises
    SET state = ?, max_accounts = ?, inventory_count = 0, policy_version = 1
    WHERE id = ?`, [enterprise.state ?? 'active', enterprise.cap, enterprise.id]);
}

async function insertEnterprise(backend: ContractBackend, enterprise: EnterpriseSetup): Promise<void> {
  await backend.sql(`
    INSERT INTO proxy_enterprises (
      id, state, max_accounts, inventory_count, policy_version, profile_fingerprint, created_at, updated_at
    )
    VALUES (?, ?, ?, 0, 1, ?, 0, 0)`, [enterprise.id, enterprise.state ?? 'active', enterprise.cap, 'e'.repeat(64)]);
}

async function claimOwner(backend: ContractBackend): Promise<string> {
  const owner = randomUUID();
  assert.equal(await backend.store.claimOwner(owner), true);
  return owner;
}

/** Runs replenishment batches until one reserves nothing; returns the members reserved. */
async function fill(backend: ContractBackend, eligible: readonly string[]): Promise<number> {
  const owner = await claimOwner(backend);
  let total = 0;
  for (let batch = await backend.store.reserveDeficit(owner, eligible); batch > 0;) {
    total += batch;
    batch = await backend.store.reserveDeficit(owner, eligible);
  }
  await backend.store.releaseOwner(owner);
  return total;
}

async function reserveIn(backend: ContractBackend, enterpriseId: string, count: number): Promise<Inventory[]> {
  const members: Inventory[] = [];
  for (let index = 0; index < count; index++) {
    const member = await backend.store.reserve([enterpriseId]);
    assert.equal(member?.enterprise_id, enterpriseId);
    members.push(member!);
  }
  return members;
}

async function makeReady(backend: ContractBackend, identity: string): Promise<void> {
  await backend.sql(`
    UPDATE proxy_accounts
    SET copilot_oauth_token = ?, copilot_oauth_status = 'valid', gh_login = ?
    WHERE identity = ?`, [`contract-token-${identity}`, identity, identity]);
  const verifiedAt = await backend.store.now();
  const ready = { state: 'ready', stage: 'ready', verified_at: verifiedAt, attempts: 0, last_error: null };
  assert.equal(await backend.store.update(identity, ready), true);
}

async function setState(backend: ContractBackend, id: string, state: EnterpriseLifecycleState): Promise<void> {
  const current = await policy(backend, id);
  await backend.store.updateEnterprisePolicy(id, current.policyVersion, { state });
}

async function releaseLease(backend: ContractBackend, held: HeldLease): Promise<void> {
  await backend.store.finish(held, false);
  await backend.store.release(held.lease_id);
}

async function policy(backend: ContractBackend, id: string) {
  const record = (await backend.store.enterprisePolicies()).find((row) => row.id === id);
  assert.ok(record, `enterprise ${id}`);
  return record;
}

async function reservedMembers(backend: ContractBackend): Promise<Array<{ identity: string }>> {
  const rows = await backend.sql(`
    SELECT identity
    FROM user_pool_accounts
    ORDER BY ordinal`);
  return rows.map((row) => ({ identity: String(row.identity) }));
}

async function creationSequence(backend: ContractBackend): Promise<string[]> {
  const rows = await backend.sql(`
    SELECT enterprise_id
    FROM user_pool_accounts
    ORDER BY ordinal`);
  return rows.map((row) => String(row.enterprise_id));
}

async function inventoryByEnterprise(backend: ContractBackend): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const id of await creationSequence(backend)) counts[id] = (counts[id] ?? 0) + 1;
  return sortedRecord(counts);
}

async function storedInventory(backend: ContractBackend): Promise<Record<string, number>> {
  const records = await backend.store.enterprisePolicies();
  const counts = Object.fromEntries(records.filter((row) => row.inventoryCount > 0)
    .map((row) => [row.id, row.inventoryCount]));
  return sortedRecord(counts);
}

function sortedRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function allIds(enterprises: readonly EnterpriseSetup[]): string[] {
  return enterprises.map((enterprise) => enterprise.id);
}

function emptyPool(enterprises: readonly EnterpriseSetup[]): PoolEnterprise[] {
  return withInventory(enterprises, {}, allIds(enterprises));
}

function withInventory(enterprises: readonly EnterpriseSetup[], inventory: Record<string, number>,
  eligible: readonly string[]): PoolEnterprise[] {
  return enterprises.map((enterprise) => ({
    id: enterprise.id,
    cap: enterprise.cap,
    inventory: inventory[enterprise.id] ?? 0,
    eligible: eligible.includes(enterprise.id),
  }));
}

function admissionInput(enterprises: readonly EnterpriseSetup[], inventory: number) {
  return enterprises.map((enterprise) => ({
    id: enterprise.id, cap: enterprise.cap, inventory, eligible: true, eligibleIdle: 1,
  }));
}

function identities(rows: unknown[]): string[] {
  return rows.map((row) => (row as { identity: string }).identity);
}

function isAggregate(statement: string): boolean {
  return AGGREGATE.test(statement);
}

async function rejectsCode(action: () => unknown, code: string, status?: number): Promise<void> {
  await assert.rejects(async () => action(), (error: unknown) => {
    assert.ok(error instanceof UserPoolError, String(error));
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}
