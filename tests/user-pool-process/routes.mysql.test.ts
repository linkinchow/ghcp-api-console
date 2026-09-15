import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { assertV5Production, bounded, caller, engineEnabled, otherCaller, routesSuite, tokenA, tokenB, until, v5ProductionRef } from './routes.safety.js';

// No dedicated opt-in means explicit SKIP. Opted-in unsafe configuration refuses
// before even loading the harness; no production import happens in this process.
const enabled = engineEnabled(process.env);
const suite = routesSuite(process.env);
if (enabled && suite === 'v5') {
  await assertV5Production();
  console.log(`Route suite v5: 2 baseline + 3 follow-up cases; production matches ${v5ProductionRef}`);
}
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

// Explicit v5 selection registers exactly three additions, leaving the historical
// baseline invocation and its two scenarios intact. No exhaustive permutation loop.
if (suite === 'v5') {
  test('process routes v5: every catalog consumer cancels in independent caches; fresh caller recovers', options, async t => {
    const f = await fixture!(t);
    try {
      const start = f.mock.calls.length;
      f.mock.holdCatalog();
      const requests = [f.request(0, 'GET'), f.request(0, 'HEAD'), f.request(1, 'GET'), f.request(1, 'HEAD')];
      await until(() => f.joined(requests), 'all four catalog consumers subscribed');
      await until(() => f.mock.calls.slice(start).filter(call => call.kind === 'catalog' && call.partial).length === 2, 'one partial catalog body per independent cache');
      const refreshes = f.mock.calls.slice(start).filter(call => call.kind === 'catalog');
      assert.equal(refreshes.length, 2);
      assert.deepEqual(new Set(refreshes.map(call => call.pid)), new Set(f.replicas.map(replica => replica.pid)));
      assert.equal((await f.holds()).length, 4);
      assert.equal((await f.rows('user_pool_leases')).length, 0);
      const local = refreshes.find(call => call.pid === f.replicas[0].pid)!;
      const remote = refreshes.find(call => call.pid === f.replicas[1].pid)!;
      async function cancel(index: number, remaining: number) {
        requests[index].controller.abort();
        assert.ok('error' in await bounded(requests[index].outcome, `catalog consumer ${index} cancellation`));
        await until(async () => (await f.holds()).length === remaining, `catalog hold ${index} deleted`);
      }
      await cancel(0, 3);
      assert.ok(refreshes.every(call => !call.cancelled && !call.released), 'Both caches still have consumers');
      await cancel(1, 2);
      await until(() => local.cancelled, 'PID 0 last waiter aborts its real upstream partial response');
      assert.equal(local.released, false, 'Abort must occur without completing the mock body');
      assert.equal(remote.cancelled, false, 'Remote cache still has two consumers');
      await cancel(2, 1);
      assert.equal(remote.cancelled, false, 'Remote final consumer keeps its stream alive');
      await cancel(3, 0);
      await until(() => remote.cancelled, 'PID 1 last waiter aborts its real upstream partial response');
      assert.ok(refreshes.every(call => call.cancelled && !call.released && call.res.destroyed));
      assert.deepEqual(await f.rows('user_pool_catalog_holds'), []);
      assert.deepEqual(await f.rows('user_pool_leases'), []);

      // No cache-clear control: a later request must detach from the cancelled
      // refresh on its own. A different caller also proves SQL ownership drained.
      const freshStart = f.mock.calls.length;
      const fresh = [f.request(0, 'GET', otherCaller), f.request(1, 'HEAD', otherCaller)];
      await until(() => f.joined(fresh), 'fresh caller admitted on both PIDs');
      await until(() => f.mock.calls.slice(freshStart).filter(call => call.kind === 'catalog' && call.partial).length === 2, 'two fresh uncancelled refreshes');
      const replacements = f.mock.calls.slice(freshStart).filter(call => call.kind === 'catalog');
      assert.deepEqual(new Set(replacements.map(call => call.pid)), new Set(f.replicas.map(replica => replica.pid)));
      assert.ok(replacements.every(call => !call.cancelled && !call.released));
      const freshHolds = await f.holds();
      assert.equal(freshHolds.length, 2); assert.ok(freshHolds.every(hold => hold.caller_id === otherCaller && hold.kind === 'catalog'));
      // Release only this observed batch. The mock still refuses attempts to
      // release cancelled responses; both old streams remain unreleased.
      f.mock.release('catalog', freshStart);
      for (const [index, request] of fresh.entries()) success(await bounded(request.response, 'fresh catalog completion'), index === 1);
      await until(async () => (await f.holds()).length === 0, 'fresh catalog holds drain');
      for (const [index, kind] of (['HEAD', 'GET'] as const).entries()) {
        success(await bounded(f.request(index, kind, otherCaller).response, 'fresh snapshot cache hit'), kind === 'HEAD');
      }
      await until(async () => (await f.holds()).length === 0, 'cache-hit holds drain');
      assert.equal(f.mock.calls.slice(start).filter(call => call.kind === 'catalog').length, 4, 'No replay or extra refresh after recovery');
      assert.ok(f.mock.calls.slice(start).every(call => call.kind === 'catalog' && call.token === `Bearer ${tokenA}`), 'Catalog-only case never reaches inference');
      assert.deepEqual(await f.rows('user_pool_leases'), [], 'Cancelled, fresh and cache-hit catalogs never create or renew leases');
      assert.equal((await f.rows('user_pool_events')).filter(event => event.action === 'lease_renewed').length, 0);
      assert.deepEqual(f.mock.failures, []);
    } finally { await f.close(); }
  });

  test('process routes v5: old 401 before old 200 fences ABA credential generation', options, t => unauthorizedFirst(t, true));
  test('process routes v5: old 401 before old 200 fences A-to-B credential generation', options, t => unauthorizedFirst(t, false));
}

async function unauthorizedFirst(t: TestContext, aba: boolean) {
  const f = await fixture!(t);
  try {
    const oldSuccess = f.request(0, 'old-success');
    await until(() => f.mock.calls.some(call => call.kind === 'old-success'), 'old 200 waits on external wire barrier');
    const oldUnauthorized = f.request(1, 'old-unauthorized');
    await until(() => f.mock.calls.some(call => call.kind === 'old-unauthorized'), 'old 401 waits on independent PID wire barrier');
    const states = await Promise.all([f.control(0, 'state'), f.control(1, 'state')]);
    const oldIds = [states[0].contexts[oldSuccess.id].requestId, states[1].contexts[oldUnauthorized.id].requestId];
    const [original] = await f.rows('user_pool_accounts');
    const oldHolds = await f.rows('user_pool_holds');
    assert.equal(oldHolds.length, 2);
    assert.deepEqual(new Set(oldHolds.map(hold => hold.request_id)), new Set(oldIds));
    assert.ok(oldHolds.every(hold => Number(hold.generation) === Number(original.generation)), 'Both persisted holds pin the exact pre-rotation generation');
    const leases = await f.rows('user_pool_leases'); assert.equal(leases.length, 1);
    const [lease] = leases;
    assert.equal(lease.phase, 'provisional'); assert.equal(lease.last_success_at, null);
    assert.equal(lease.caller_id, caller); assert.equal(lease.member_identity, f.member);
    assert.ok(oldHolds.every(hold => hold.lease_id === lease.lease_id));
    await f.control(0, aba ? 'rotate-aba' : 'rotate-ab');
    const [rotated] = await f.rows('user_pool_accounts');
    const replacementToken = aba ? tokenA : tokenB;
    assert.equal(Number(rotated.generation), Number(original.generation) + (aba ? 2 : 1));
    assert.equal(rotated.state, 'ready'); assert.equal(rotated.verified_at, null);
    assert.deepEqual(await f.rows('user_pool_holds'), oldHolds, 'Rotation does not replace or rewrite old-generation holds');
    assert.deepEqual(await f.rows('user_pool_leases'), leases);
    async function fenced(beforeAdmission = false) {
      const [account] = await f.rows('proxy_accounts');
      assert.equal(account.copilot_oauth_token, replacementToken); assert.equal(account.copilot_oauth_status, 'valid');
      const [inventory] = await f.rows('user_pool_accounts');
      assert.equal(Number(inventory.reauth_count), 0);
      const events = await f.rows('user_pool_events');
      assert.equal(events.filter(event => event.action.startsWith('oauth_reauth_')).length, 0);
      assert.equal(events.filter(event => event.action === 'lease_renewed' && event.lease_id === lease.lease_id).length, 0);
      const remaining = (await f.rows('user_pool_leases')).find(row => row.lease_id === lease.lease_id);
      if (remaining) {
        assert.equal(remaining.phase, 'provisional'); assert.equal(remaining.last_success_at, null);
        assert.ok(Number(remaining.expires_at) <= Number(lease.expires_at));
      }
      if (beforeAdmission) {
        assert.deepEqual(inventory, rotated, 'Neither old completion mutates replacement readiness or generation');
        assert.deepEqual(await f.rows('user_pool_leases'), leases, 'No admission, reclaim or failed-state fence may mask old completion');
      }
    }
    // No admission/reclaim/worker between rotation and BOTH completions. In a
    // 401-first case, reclaim before the 200 could otherwise hide a renewal bug.
    f.mock.release('old-unauthorized');
    assert.equal((await bounded(oldUnauthorized.response, 'old 401 completes first')).status, 401);
    await until(async () => (await f.holds()).length === 1, 'old 401 hold drains before releasing old 200');
    assert.deepEqual(await f.rows('user_pool_holds'), oldHolds.filter(hold => hold.request_id === oldIds[0]));
    const waitingSuccess = f.mock.calls.find(call => call.kind === 'old-success')!;
    assert.ok(!waitingSuccess.released && !waitingSuccess.cancelled, 'Old 200 remains held through post-401 SQL observations');
    await fenced(true);
    f.mock.release('old-success'); success(await bounded(oldSuccess.response, 'old 200 completes second'));
    await until(async () => (await f.holds()).length === 0, 'both exact old-generation holds drained');
    await fenced(true);
    const oldCalls = f.mock.calls.filter(call => call.kind.startsWith('old-'));
    assert.equal(oldCalls.length, 2, 'Neither old inference is replayed');
    assert.equal(oldCalls.filter(call => call.kind === 'old-success').length, 1);
    assert.equal(oldCalls.filter(call => call.kind === 'old-unauthorized').length, 1);
    assert.equal(oldCalls.find(call => call.kind === 'old-success')!.pid, f.replicas[0].pid);
    assert.equal(oldCalls.find(call => call.kind === 'old-unauthorized')!.pid, f.replicas[1].pid);
    assert.ok(oldCalls.every(call => call.token === `Bearer ${tokenA}` && call.released && !call.cancelled));
    assert.equal(f.mock.calls.filter(call => call.kind === 'Reply OK').length, 1);
    // Unlike the baseline's still-live-hold probe, BOTH old holds are gone.
    // admitTx -> reclaimMemberTx marks unverified ready inventory failed/warmup;
    // updateTx advances generation and expires the lease, then reclaim deletes
    // that hold-free lease. availableMember therefore rejects pool_exhausted,
    // not assertReady's member_unavailable (which requires a retained binding).
    const beforeAdmissionCalls = f.mock.calls.length;
    const rejected = await bounded(f.request(1, 'must-not-admit').response, 'replacement is not verified');
    assert.equal(rejected.status, 429, rejected.text);
    assert.equal(JSON.parse(rejected.text).error.code, 'pool_exhausted');
    assert.equal(f.mock.calls.length, beforeAdmissionCalls, 'Rejected admission never reaches any provider endpoint');
    assert.equal(f.mock.calls.filter(call => call.kind === 'must-not-admit').length, 0);
    const [reclaimed] = await f.rows('user_pool_accounts');
    assert.equal(reclaimed.state, 'failed'); assert.equal(reclaimed.stage, 'warmup');
    assert.equal(reclaimed.last_error, 'credential_not_verified'); assert.equal(reclaimed.verified_at, null);
    assert.equal(Number(reclaimed.generation), Number(rotated.generation) + 1, 'Only post-completion reclaim advances this generation');
    assert.deepEqual(await f.rows('user_pool_leases'), [], 'Reclaim removes the expired old lease only after both holds drained');
    assert.deepEqual(await f.holds(), []);
    assert.equal((await f.rows('user_pool_events')).filter(event => event.action === 'lease_expired' && event.lease_id === lease.lease_id).length, 1);
    await fenced();

    f.mock.holdWarmup();
    const verification = f.control(0, 'tick'); void verification.catch(() => {});
    await until(() => f.mock.calls.filter(call => call.kind === 'Reply OK').length === 2, 'production provisioner replacement warmup held on wire');
    const [verifying] = await f.rows('user_pool_accounts');
    assert.equal(verifying.verified_at, null); assert.ok(Number(verifying.generation) >= Number(rotated.generation));
    const warmup = f.mock.calls.filter(call => call.kind === 'Reply OK');
    assert.equal(warmup[0].token, `Bearer ${tokenA}`);
    assert.equal(warmup[1].token, `Bearer ${replacementToken}`);
    assert.ok(warmup.every(call => call.pid === f.replicas[0].pid));
    assert.ok(!warmup[1].released && !warmup[1].cancelled);
    assert.ok([429, 503].includes((await bounded(f.request(1, 'must-not-admit').response, 'no admission during held warmup')).status));
    assert.equal(f.mock.calls.filter(call => call.kind === 'must-not-admit').length, 0);
    assert.deepEqual(await f.holds(), []);
    f.mock.release('Reply OK'); await bounded(verification, 'replacement warmup finishes');
    const [verified] = await f.rows('user_pool_accounts');
    assert.equal(verified.state, 'ready'); assert.notEqual(verified.verified_at, null);
    assert.equal(verified.generation, verifying.generation, 'Warmup commits only its pinned generation');
    success(await bounded(f.request(1, 'replacement').response, 'verified replacement admits'));
    await until(async () => (await f.holds()).length === 0, 'replacement inference hold drains');
    const newLeases = await f.rows('user_pool_leases'); assert.equal(newLeases.length, 1);
    const [newLease] = newLeases;
    assert.notEqual(newLease.lease_id, lease.lease_id); assert.equal(newLease.phase, 'active');
    assert.equal(newLease.caller_id, caller); assert.equal(newLease.member_identity, f.member);
    assert.notEqual(newLease.last_success_at, null);
    await fenced();
    const replacement = f.mock.calls.filter(call => call.kind === 'replacement');
    assert.equal(replacement.length, 1); assert.equal(replacement[0].token, `Bearer ${replacementToken}`);
    assert.equal(replacement[0].pid, f.replicas[1].pid);
    assert.equal(f.mock.calls.filter(call => call.kind.startsWith('old-')).length, 2, 'Reverification cannot replay old inference');
    assert.equal((await f.rows('user_pool_accounts'))[0].generation, verified.generation);
    assert.deepEqual(f.mock.failures, []);
  } finally { await f.close(); }
}
