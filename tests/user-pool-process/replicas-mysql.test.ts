import assert from 'node:assert/strict';
import test from 'node:test';
import { caller, enabled, until } from './replicas-safety.js';
import { fixture, type State } from './replicas-harness.js';

const run = enabled(process.env); // Unsafe explicit input fails before test setup.
for (const count of [3, 5] as const) test(`${count} independent Proxy replicas: affinity, isolation, live routing and real owner death`, {
  skip: !run, timeout: 180000, concurrency: false,
}, async t => {
  const f = await fixture(t, count);
  const wait = (check: () => Promise<boolean>, label: string, ms = 30000) => until(check, label, ms, t.signal);
  const success = (result: Awaited<ReturnType<typeof f.request>>) => {
    assert.equal(result.status, 200, `PID ${result.pid}: ${result.text}`);
    const body = JSON.parse(result.text); assert.equal(body.type, 'message');
    assert.ok(body.content.some((part: { text?: string }) => part.text === 'OK'));
  };
  const drained = () => wait(async () => (await f.holds()).length === 0, 'all durable holds drained', 8000);
  const idle = () => wait(async () => (await f.readyIdle()).length === count + 2
    && (await f.rows('user_pool_accounts')).every(row => row.state === 'ready'), 'real provisioner restores Ready inventory', 40000);
  async function ownerProof() {
    const row = await f.owner(); assert.ok(row.valid, 'Exactly one unexpired DB owner');
    const states = await Promise.all(f.replicas.filter(r => !r.killed).map(async replica => ({ replica, state: await f.control<State>(replica, 'state') })));
    const matching = states.filter(({ state }) => state.owners.includes(row.owner)); assert.equal(matching.length, 1);
    assert.equal(states.filter(({ state }) => state.scheduler.state === 'owner').length, 1);
    for (const { state } of states) assert.equal(state.scheduler.scope, 'local_process');
    return { row, replica: matching[0].replica };
  }
  try {
    await idle(); const original = await ownerProof();
    assert.equal(f.mock.tasks.length, count + 2);
    assert.ok(f.mock.calls.filter(c => ['user-post', 'task-post'].includes(c.kind)).every(c => c.pid === original.replica.pid));
    t.diagnostic(`startup${count}: one DB-valid scheduler PID ${original.replica.pid}; all ${count} production workers initialized`);

    // Cold independent model caches plus concurrent cross-process SAME-caller admission.
    await Promise.all(f.replicas.map(r => f.control(r, 'clear-cache')));
    const catalogStart = f.mock.calls.length;
    const shared = caller(1); const sameKind = 'business-same-held'; f.mock.hold(sameKind);
    const same = f.replicas.map(r => f.request(r, shared, sameKind));
    await wait(async () => f.mock.calls.filter(c => c.kind === sameKind).length === count, 'same caller reached every replica upstream', 10000);
    const sameLease = (await f.rows('user_pool_leases')).filter(row => row.caller_id === shared);
    assert.equal(sameLease.length, 1); assert.equal((await f.holds()).length, count);
    const sameCalls = f.mock.calls.filter(c => c.kind === sameKind);
    assert.deepEqual(new Set(sameCalls.map(c => c.pid)), new Set(f.replicas.map(r => r.pid)));
    assert.deepEqual(new Set(sameCalls.map(c => c.identity)), new Set([sameLease[0].member_identity]));
    const catalogs = f.mock.calls.slice(catalogStart).filter(c => c.kind === 'models' && c.identity === sameLease[0].member_identity);
    for (const r of f.replicas) assert.equal(catalogs.filter(c => c.pid === r.pid).length, 1, 'Each child performs its own cache miss');
    f.mock.release(sameKind, count); (await Promise.all(same)).forEach(success); await drained();
    assert.equal((await f.rows('user_pool_leases')).find(row => row.caller_id === shared)!.lease_id, sameLease[0].lease_id);
    t.diagnostic(`startup${count}: all replicas returned business 200; concurrent same caller has one member/lease; ${count} independent cache misses; holds drained`);

    // Different callers use different members even while all upstream requests overlap.
    const distinctKind = 'business-distinct-held'; f.mock.hold(distinctKind);
    const distinct = f.replicas.map((r, i) => f.request(r, caller(i + 2), distinctKind));
    await wait(async () => f.mock.calls.filter(c => c.kind === distinctKind).length === count, 'distinct callers reached upstream', 10000);
    const leased = await f.rows('user_pool_leases'); assert.equal(leased.length, count + 1);
    assert.equal(new Set(leased.map(row => row.member_identity)).size, count + 1);
    assert.equal(new Set(leased.map(row => row.caller_id)).size, count + 1);
    assert.equal((await f.holds()).length, count);
    const distinctCalls = f.mock.calls.filter(c => c.kind === distinctKind);
    for (let i = 0; i < count; i++) assert.equal(distinctCalls.find(c => c.pid === f.replicas[i].pid)!.identity,
      leased.find(row => row.caller_id === caller(i + 2))!.member_identity);
    f.mock.release(distinctKind, count); (await Promise.all(distinct)).forEach(success); await drained(); await idle();
    t.diagnostic(`startup${count}: ${count} distinct simultaneous callers exclusive; all hold rows drained`);

    // Four overlapping A admissions per child: only one may consume a driver
    // connection; the other three must wait outside the pool. At most 20 total.
    const hot = caller(9999); const releaseLock = await f.holdCaller(hot);
    const lockStart = performance.now();
    const blocked = f.replicas.flatMap(r => Array.from({ length: 4 }, () => f.request(r, hot, 'business-must-not-replay', 11000)));
    try {
      await new Promise(resolve => setTimeout(resolve, 250));
      const probes = await Promise.all(f.replicas.map((r, i) => f.request(r, caller(i + 2), 'business-isolated-probe', 3000)));
      probes.forEach(result => { success(result); assert.ok(result.ms < 3000); });
      t.diagnostic(`startup${count}: hot-caller lock isolation B probe milliseconds by PID ${probes.map(r => `${r.pid}=${Math.round(r.ms)}`).join(', ')}`);
      const results = await Promise.all(blocked);
      t.diagnostic(`startup${count}: all ${results.length} hot-caller A durations milliseconds ${results.map((r, i) => `${r.pid}/A${i % 4 + 1}=${r.ms.toFixed(3)}`).join(', ')}`);
      for (const result of results) {
        assert.equal(result.status, 503); assert.equal(JSON.parse(result.text).error.code, 'pool_storage_unavailable');
        assert.ok(result.ms >= 4000 && result.ms <= 6000, 'Original 5s SQL budget plus at most 1s fixture scheduling tolerance, no replay');
      }
      await new Promise(resolve => setTimeout(resolve, Math.max(0, 6500 - (performance.now() - lockStart))));
    } finally { await releaseLock(); }
    assert.equal(f.mock.calls.some(c => c.kind === 'business-must-not-replay'), false);
    assert.equal((await f.rows('user_pool_leases')).some(row => row.caller_id === hot), false); await drained();
    t.diagnostic(`startup${count}: ${count * 4} blocked A requests returned bounded 503, no upstream replay or leaked holds`);

    // Reserve a fresh member naturally by consuming idle inventory. Hold only the
    // synthetic Login POST response, AFTER it was accepted, before task checkpoint.
    await idle(); f.mock.armLoginPost();
    success(await f.request(f.replicas[0], caller(100), 'business-trigger-deficit'));
    await wait(async () => Boolean(f.mock.heldTask()), 'accepted Login POST held at wire barrier', 15000);
    const heldTask = f.mock.heldTask()!;
    const before = await ownerProof(); assert.equal(before.replica.pid, heldTask.pid); assert.equal(before.row.owner, original.row.owner);
    const inventory = (await f.rows('user_pool_accounts')).find(row => row.identity === heldTask.identity)!;
    assert.equal(inventory.stage, 'oauth-dispatch'); assert.equal(inventory.task_id, null);
    assert.equal(inventory.oauth_attempt_id, heldTask.oauthAttemptId);
    assert.ok((await f.readyIdle()).length >= count, 'Ready inventory already exists before failure');
    await drained(); await f.kill(before.replica);
    const killedAt = performance.now(); const retained = await f.owner();
    const postsAtKill = f.mock.calls.filter(c => c.kind === 'task-post').length;
    assert.equal(retained.owner, before.row.owner); assert.ok(retained.valid);
    assert.ok(retained.until - retained.now > 24000 && retained.until - retained.now <= 30000, 'Unchanged real 30s lease, no forced expiry/release');
    const survivors = f.replicas.filter(r => !r.killed);
    const gapReady = new Set(await f.readyIdle());
    success(await f.request(survivors[0], caller(101), 'business-new-caller-during-gap'));
    const newLease = (await f.rows('user_pool_leases')).find(row => row.caller_id === caller(101))!;
    assert.ok(gapReady.has(newLease.member_identity), 'New caller uses pre-existing Ready inventory without scheduler');
    let rounds = 0;
    let gapSuccesses = 0;
    let replacement: Awaited<ReturnType<typeof f.owner>> | undefined;
    const samples: Array<{ elapsed: number; dbNow: number; valid: boolean }> = [];
    while (performance.now() - killedAt < 40000) {
      const current = await f.owner();
      if (current.owner !== retained.owner) {
        assert.ok(current.valid); assert.ok(current.now >= retained.until, 'Successor cannot claim before real DB expiry');
        replacement = current; break;
      }
      assert.equal(current.until, retained.until, 'Killed owner cannot renew and fixture cannot change expiry');
      if (current.valid) assert.equal(f.mock.calls.filter(c => c.kind === 'task-post').length, postsAtKill, 'No standby provisions before DB owner expiry');
      const results = await Promise.all(survivors.map(r => f.request(r, shared, `business-gap-${rounds++}`, 5000)));
      results.forEach(success); gapSuccesses += results.length;
      samples.push({ elapsed: Math.round(performance.now() - killedAt), dbNow: current.now, valid: current.valid });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.ok(replacement, 'Real automatic successor election within 40s');
    const electionMs = Math.round(performance.now() - killedAt);
    assert.ok(performance.now() - killedAt >= 24000); assert.ok(gapSuccesses >= survivors.length * 10);
    const successor = await ownerProof(); assert.notEqual(successor.replica.pid, before.replica.pid);
    assert.equal(successor.row.owner, replacement.owner);
    await wait(async () => (await f.rows('user_pool_accounts')).find(row => row.identity === heldTask.identity)?.state === 'ready', 'retained task recovered and warmed by successor', 20000);
    assert.ok(f.mock.calls.some(c => c.kind === 'task-search' && c.identity === heldTask.identity && c.pid === successor.replica.pid));
    assert.equal(f.mock.calls.filter(c => c.kind === 'task-post' && c.identity === heldTask.identity).length, 1);
    await idle();
    assert.ok(f.mock.calls.some(c => c.kind === 'task-post' && c.pid === successor.replica.pid), 'Successor provisions another genuinely new member');
    (await Promise.all(survivors.map(r => f.request(r, shared, 'business-after-election')))).forEach(success);
    await drained();
    const finalShared = (await f.rows('user_pool_leases')).filter(row => row.caller_id === shared);
    assert.equal(finalShared.length, 1); assert.equal(finalShared[0].lease_id, sameLease[0].lease_id);
    assert.equal(finalShared[0].member_identity, sameLease[0].member_identity);
    const finalAccounts = await f.rows('user_pool_accounts'); assert.ok(finalAccounts.length <= 20);
    for (const kind of ['user-post', 'task-post']) {
      const posted = f.mock.calls.filter(c => c.kind === kind);
      assert.equal(new Set(posted.map(c => c.identity)).size, posted.length, `No duplicate ${kind}`);
    }
    assert.equal(f.mock.calls.some(c => c.kind === 'business-must-not-replay'), false, 'Final raw ledger excludes delayed hot-caller replay after election/provisioning');
    assert.deepEqual(f.mock.failures, []);
    t.diagnostic(`startup${count}: SIGKILL PID ${before.replica.pid}; ${gapSuccesses} successful survivor requests across ${samples.length} gap samples; election ${electionMs}ms; new DB owner PID ${successor.replica.pid}; retained task POST exactly once; further provisioning; ${finalAccounts.length}/20 members`);
  } finally { await f.close(); }
});
