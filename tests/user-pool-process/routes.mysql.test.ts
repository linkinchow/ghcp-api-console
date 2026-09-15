import assert from 'node:assert/strict';
import test from 'node:test';
import { bounded, caller, engineEnabled, otherCaller, tokenA, until } from './routes.safety.js';

// No dedicated opt-in means explicit SKIP. Opted-in unsafe configuration refuses
// before even loading the harness; no production import happens in this process.
const enabled = engineEnabled(process.env);
const fixture = enabled ? (await import('./routes.harness.js')).fixture : undefined;
const options = { timeout: 100000, concurrency: false,
  skip: enabled ? false : 'No engine exercised: requires MYSQL_POOL_PROCESS_ROUTES_TEST=1, MYSQL_POOL_TEST_DISPOSABLE=1 and root loopback MYSQL_TEST_URL /ghcp_pool_test_*' };
function success(value: { status: number; text: string }, head = false) {
  assert.equal(value.status, 200, value.text);
  assert.ok(Buffer.byteLength(value.text) < 4096);
  if (head) assert.equal(value.text, '');
  else { assert.notEqual(value.text, ''); assert.doesNotThrow(() => JSON.parse(value.text)); }
}

test('process routes: partial catalog cancellation isolates surviving cache waiters and mixed inference', options, async t => {
  const f = await fixture!(t);
  try {
  const catalogStart = f.mock.calls.length;
  f.mock.holdCatalog();
  const catalogs = [f.request(0, 'GET'), f.request(0, 'HEAD'), f.request(1, 'GET'), f.request(1, 'HEAD')];
  await until(() => f.joined(catalogs), 'four admitted catalog waiters');
  await until(() => f.mock.calls.slice(catalogStart).filter(call => call.kind === 'catalog' && call.partial).length === 2, 'two independent partial catalog streams');
  const refreshes = f.mock.calls.slice(catalogStart).filter(call => call.kind === 'catalog');
  assert.deepEqual(new Set(refreshes.map(call => call.pid)), new Set(f.replicas.map(replica => replica.pid)), 'Separate module caches must each fetch, rather than sharing one process refresh');
  assert.equal((await f.rows('user_pool_leases')).length, 0);
  assert.equal((await f.holds()).length, 4);
  const exhausted = await bounded(f.request(1, 'GET', otherCaller).response, 'other caller exhaustion');
  assert.equal(exhausted.status, 429); assert.equal(JSON.parse(exhausted.text).error.code, 'pool_exhausted');
  const inferences = [f.request(0, 'mixed'), f.request(1, 'mixed')];
  await until(() => f.joined(inferences), 'both inference waiters join their local cache');
  assert.equal(f.mock.calls.slice(catalogStart).filter(call => call.kind === 'catalog').length, 2);
  assert.equal((await f.holds()).length, 6);
  const [lease] = await f.rows('user_pool_leases');
  assert.equal(lease.phase, 'provisional'); assert.equal(lease.caller_id, caller);
  catalogs[0].controller.abort();
  assert.ok('error' in await bounded(catalogs[0].outcome, 'cancelled catalog wire'));
  await until(async () => (await f.holds()).length === 5, 'cancelled hold deletion');
  assert.ok(refreshes.every(call => !call.cancelled), 'One cancellation cannot close either surviving partial stream');
  f.mock.release('catalog');
  for (const [index, request] of catalogs.entries()) if (index > 0) success(await bounded(request.response, 'surviving catalog response'), index === 1 || index === 3);
  await until(() => f.mock.calls.filter(call => call.kind === 'mixed').length === 2, 'mixed inference wire reaches both child processes');
  await until(async () => (await f.rows('user_pool_catalog_holds')).length === 0, 'all catalog holds drain');
  assert.equal((await f.holds()).length, 2);
  assert.deepEqual(await f.rows('user_pool_leases'), [lease], 'Catalog completion does not promote or renew inference lease');
  f.mock.release('mixed');
  for (const request of inferences) success(await bounded(request.response, 'mixed inference response'));
  await until(async () => (await f.holds()).length === 0, 'mixed holds drain');
  const before = await f.rows('user_pool_leases');
  assert.equal(before[0].phase, 'active'); assert.notEqual(before[0].last_success_at, null);
  const later = [f.request(0, 'GET'), f.request(1, 'HEAD')];
  for (const [index, request] of later.entries()) success(await bounded(request.response, 'cached later catalog'), index === 1);
  await until(async () => (await f.holds()).length === 0, 'later catalog holds drain');
  assert.deepEqual(await f.rows('user_pool_leases'), before, 'Catalog-only traffic preserves expiry and last success');
  assert.equal(f.mock.calls.slice(catalogStart).filter(call => call.kind === 'catalog').length, 2, 'Both independent caches retained their successful response');
  const mixedCalls = f.mock.calls.filter(call => call.kind === 'mixed');
  assert.equal(mixedCalls.length, 2);
  assert.deepEqual(new Set(mixedCalls.map(call => call.pid)), new Set(f.replicas.map(replica => replica.pid)));
  assert.ok(mixedCalls.every(call => call.token === `Bearer ${tokenA}` && call.released && !call.cancelled));
  assert.deepEqual(f.mock.failures, []);
  } finally { await f.close(); }
});

test('process routes: old 200 then old 401 cannot renew or invalidate ABA replacement credentials', options, async t => {
  const f = await fixture!(t);
  try {
  const oldSuccess = f.request(0, 'old-success');
  await until(() => f.mock.calls.some(call => call.kind === 'old-success'), 'old success begins upstream');
  const oldUnauthorized = f.request(1, 'old-unauthorized');
  await until(() => f.mock.calls.some(call => call.kind === 'old-unauthorized'), 'old unauthorized begins upstream');
  assert.equal((await f.holds()).length, 2);
  const [lease] = await f.rows('user_pool_leases');
  assert.equal(lease.phase, 'provisional'); assert.equal(lease.last_success_at, null);
  assert.equal(lease.member_identity, f.member); assert.equal(lease.caller_id, caller);
  const [original] = await f.rows('user_pool_accounts');
  await f.control(0, 'rotate-aba');
  const [rotated] = await f.rows('user_pool_accounts');
  assert.equal(Number(rotated.generation), Number(original.generation) + 2);
  assert.equal(rotated.verified_at, null);
  assert.equal(rotated.state, 'ready', 'No failed-state fence may mask the generation-only old-200 race');
  assert.deepEqual(await f.rows('user_pool_leases'), [lease], 'Rotation alone preserves the old lease before its completion');
  async function fenced() {
    const [account] = await f.rows('proxy_accounts');
    assert.equal(account.copilot_oauth_token, tokenA); assert.equal(account.copilot_oauth_status, 'valid');
    assert.equal(Number((await f.rows('user_pool_accounts'))[0].reauth_count), 0);
    const events = await f.rows('user_pool_events');
    assert.equal(events.filter(event => event.action === 'oauth_reauth_scheduled').length, 0);
    assert.equal(events.filter(event => event.action === 'lease_renewed' && event.lease_id === lease.lease_id).length, 0);
    const remaining = (await f.rows('user_pool_leases')).find(row => row.lease_id === lease.lease_id);
    if (remaining) {
      assert.equal(remaining.phase, 'provisional'); assert.equal(remaining.last_success_at, null);
      assert.ok(Number(remaining.expires_at) <= Number(lease.expires_at));
    }
  }
  // Crucially no admission/reclaim/worker before this completion; those can mask a broken generation fence.
  f.mock.release('old-success'); success(await bounded(oldSuccess.response, 'old success completion'));
  await until(async () => (await f.holds()).length === 1, 'first old hold drain');
  await fenced();
  assert.equal((await bounded(f.request(1, 'must-not-admit').response, 'unverified admission')).status, 503);
  await f.control(0, 'tick');
  assert.equal(f.mock.calls.filter(call => call.kind === 'Reply OK').length, 1, 'Worker skips replacement warmup while old hold survives');
  f.mock.release('old-unauthorized');
  assert.equal((await bounded(oldUnauthorized.response, 'old unauthorized completion')).status, 401);
  await until(async () => (await f.holds()).length === 0, 'second old hold drain');
  await fenced();
  const oldCalls = f.mock.calls.filter(call => call.kind.startsWith('old-'));
  assert.equal(oldCalls.length, 2, 'Neither inference is replayed');
  assert.equal(oldCalls.filter(call => call.kind === 'old-success').length, 1);
  assert.equal(oldCalls.filter(call => call.kind === 'old-unauthorized').length, 1);
  assert.equal(oldCalls.find(call => call.kind === 'old-success')!.pid, f.replicas[0].pid);
  assert.equal(oldCalls.find(call => call.kind === 'old-unauthorized')!.pid, f.replicas[1].pid);
  assert.deepEqual(new Set(oldCalls.map(call => call.pid)), new Set(f.replicas.map(replica => replica.pid)));
  assert.ok(oldCalls.every(call => call.token === `Bearer ${tokenA}`));
  f.mock.holdWarmup();
  const verification = f.control(0, 'tick'); void verification.catch(() => {});
  await until(() => f.mock.calls.filter(call => call.kind === 'Reply OK').length === 2, 'replacement real provisioner warmup');
  const [verifying] = await f.rows('user_pool_accounts'); assert.equal(verifying.verified_at, null);
  assert.ok([429, 503].includes((await bounded(f.request(1, 'must-not-admit').response, 'admission during verification')).status));
  assert.equal(f.mock.calls.filter(call => call.kind === 'must-not-admit').length, 0);
  f.mock.release('Reply OK'); await bounded(verification, 'verification completes');
  const [verified] = await f.rows('user_pool_accounts');
  assert.equal(verified.state, 'ready'); assert.notEqual(verified.verified_at, null);
  assert.equal(verified.generation, verifying.generation);
  success(await bounded(f.request(1, 'replacement').response, 'verified replacement HTTP'));
  await until(async () => (await f.holds()).length === 0, 'replacement hold drains');
  const newLeases = await f.rows('user_pool_leases'); assert.equal(newLeases.length, 1);
  const [newLease] = newLeases;
  assert.equal(newLease.member_identity, f.member); assert.equal(newLease.caller_id, caller);
  assert.notEqual(newLease.lease_id, lease.lease_id); assert.equal(newLease.phase, 'active');
  assert.notEqual(newLease.last_success_at, null);
  await fenced();
  assert.equal(f.mock.calls.filter(call => call.kind === 'replacement').length, 1);
  assert.equal(f.mock.calls.find(call => call.kind === 'replacement')!.token, `Bearer ${tokenA}`);
  assert.equal(f.mock.calls.find(call => call.kind === 'replacement')!.pid, f.replicas[1].pid);
  const warmup = f.mock.calls.filter(call => call.kind === 'Reply OK');
  assert.equal(warmup.length, 2); assert.ok(warmup.every(call => call.pid === f.replicas[0].pid && call.token === `Bearer ${tokenA}`));
  assert.equal((await f.rows('user_pool_accounts'))[0].generation, verified.generation);
  assert.deepEqual(f.mock.failures, []);
  } finally { await f.close(); }
});
