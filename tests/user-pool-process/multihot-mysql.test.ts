import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { caller, until } from './replicas-safety.js';
import { burst, count, deadline, enabled, hotCount, lockMs, responseMs } from './multihot-safety.js';
import { fixture, type Snapshot } from './multihot-harness.js';

const run = enabled(process.env);
const end = run ? deadline(process.env) : 0;
// Reserve 15s for fixture cleanup before the 110s process deadline; runner hard-stops at 119s.
test('five independent Proxy children: three distinct hot callers, finite overload and recovery', {
  skip: !run, timeout: run ? Math.max(1, end - Date.now() - 15000) : 95000, concurrency: false,
}, async t => {
  const f = await fixture(t);
  const wait = (check: () => Promise<boolean>, label: string, ms = 8000) => until(check, label, ms, t.signal);
  const hot = Array.from({ length: hotCount }, (_, i) => caller(9100 + i));
  const ordinary = f.replicas.map((_, i) => caller(9200 + i));
  type Result = Awaited<ReturnType<typeof f.request>>;
  function wire(result: Result, allowUnavailable: boolean) {
    assert.match(result.contentType ?? '', /^application\/json\b/i, `PID ${result.pid}: non-JSON response`);
    assert.ok(!/<(?:!doctype|html|body)\b/i.test(result.text), 'No HTML error fallback');
    assert.ok(result.ms <= responseMs, `PID ${result.pid}: exceeded predeclared ${responseMs}ms response bound`);
    assert.ok(result.status === 200 || allowUnavailable && result.status === 503, `PID ${result.pid}: unexpected status ${result.status}`);
    const body = JSON.parse(result.text);
    if (result.status === 503) {
      assert.equal(body.type, 'error'); assert.equal(body.error.code, 'pool_storage_unavailable'); assert.equal(result.retryAfter, '1');
    } else {
      assert.equal(body.type, 'message'); assert.ok(body.content.some((part: { text?: string }) => part.text === 'OK'));
    }
    return result;
  }
  function poolBounds(state: Snapshot) {
    assert.equal(state.connectionLimit, 4); assert.equal(state.queueLimit, 1024); assert.equal(state.waitForConnections, true);
    assert.ok(state.samples > 0);
    assert.ok(state.maximum.connections <= 4, 'Native connections stay within actual production limit');
    // Finite offered load per child: 12 A + 1 B. Three active hot caller heads,
    // nine FIFO followers, plus B. Worker has its unchanged serial SQL lane.
    assert.ok(state.maximum.active <= 4 && state.maximum.queued <= 9 && state.maximum.retainedTickets <= 13);
    assert.ok(state.maximum.nativeQueued <= 16, 'Predeclared finite-load native queue ceiling (not the 1024 hard cap)');
  }
  async function noBindingsOrHolds() {
    assert.equal((await f.rows('user_pool_leases')).some(row => hot.includes(String(row.caller_id))), false);
    assert.equal((await f.holds()).length, 0);
  }
  try {
    await wait(async () => (await f.readyIdle()).length === count + 2, 'real worker prewarms seven synthetic members', 35000);
    const initial = await Promise.all(f.replicas.map((r, i) => f.request(r, ordinary[i], `business-multihot-baseline-${i}`)));
    initial.forEach(result => wire(result, false));
    await wait(async () => (await f.readyIdle()).length === count + 2, 'Ready reserve restored before pressure', 25000);
    await wait(async () => (await f.holds()).length === 0, 'baseline holds drained');
    const leases = await f.rows('user_pool_leases'); assert.equal(leases.length, count);
    const held = await f.holdCallers(hot);
    // Timer starts once all three exact hashed locks are acquired. No longer SQL
    // timeout, production pause, socket retention or fake gate is used.
    const release = sleep(lockMs).then(async () => {
      const elapsed = performance.now() - held.started;
      await held.release();
      t.diagnostic(`Named locks held ${elapsed.toFixed(3)}ms (target ${lockMs}); released/destroyed three fixture sockets`);
      assert.ok(elapsed >= lockMs - 1 && elapsed <= lockMs + 1000, 'Bounded 6.5s lock interval with at most 1s timer scheduling tolerance');
    });
    void release.catch(() => {});
    const blocked = f.replicas.flatMap((r, replica) => hot.flatMap((identity, h) =>
      Array.from({ length: burst }, (_, n) => f.request(r, identity, `business-multihot-a-${replica}-${h}-${n}`))));
    assert.equal(blocked.length, 60);
    // Observe rejections even if a barrier fails before Promise.all below.
    const blockedResults = Promise.all(blocked); void blockedResults.catch(() => {});
    let pressure: Result[] = [];
    try {
      await wait(async () => {
        const states = await Promise.all(f.replicas.map(r => f.snapshot(r)));
        if (!states.every(state => state.current.active === 3 && state.current.queued === 9)) return false;
        const sessions = await f.sessions();
        return held.blockers.every(blocker => sessions.filter(row => /^\s*SELECT\s+GET_LOCK\s*\(/i.test(String(row.statement))
          && String(row.statement).includes(blocker.name)).length === count);
      }, 'each actual gate has three heads/nine followers and all 15 real GET_LOCK waiters', 2000);
      assert.deepEqual(await f.lockOwners(), held.blockers.map(b => b.id), 'All three exact locks owned by fixture sessions');
      // Availability is a measurement, not a promise that B is 200 under aggregate
      // exhaustion. Both 200 and safe bounded 503 satisfy the pressure contract.
      pressure = await Promise.all(f.replicas.map((r, i) => f.request(r, ordinary[i], `business-multihot-b-${i}`)));
      for (const result of pressure) {
        t.diagnostic(`pressure B PID ${result.pid}: status=${result.status}, latencyMs=${result.ms.toFixed(3)}`);
        wire(result, true);
      }
      const results = await blockedResults;
      for (const r of f.replicas) {
        const values = results.filter(result => result.pid === r.pid);
        t.diagnostic(`pressure A PID ${r.pid}: ${values.map(v => `${v.kind}=${v.status}/${v.ms.toFixed(3)}ms`).join(', ')}`);
      }
      for (const result of results) {
        wire(result, true); assert.equal(result.status, 503);
        assert.ok(result.ms >= 4000, 'Real 5s SQL deadline exercised, not synthetic immediate rejection');
      }
    } finally { await release; }
    const availability = pressure.filter(result => result.status === 200).length;
    t.diagnostic(`pressure B availability=${availability}/${count}; accepted 200 or safe 503, no minimum success fraction; all completed <=${responseMs}ms`);
    await wait(async () => {
      const sessions = await f.sessions();
      return held.blockers.every(blocker => !sessions.some(row => Number(row.id) === blocker.id))
        && !sessions.some(row => /^\s*SELECT\s+GET_LOCK\s*\(/i.test(String(row.statement)));
    }, 'fixture lock connections AND timed-out GET_LOCK waiters removed', 4000);
    assert.deepEqual(await f.lockOwners(), [null, null, null]);
    await noBindingsOrHolds();
    assert.equal(f.mock.calls.filter(c => c.kind.startsWith('business-multihot-a-')).length, 0, 'No timed-out A reached upstream');
    await wait(async () => {
      const states = await Promise.all(f.replicas.map(r => f.snapshot(r)));
      states.forEach(poolBounds);
      return states.every(state => state.current.nativeQueued === 0 && state.current.active === 0 && state.current.queued === 0 && state.current.retainedTickets === 0);
    }, 'all native queues and caller tickets drain', 5000);
    const recovery = await Promise.all(f.replicas.map((r, i) => f.request(r, ordinary[i], `business-multihot-recovered-${i}`)));
    for (const result of recovery) {
      t.diagnostic(`recovery B PID ${result.pid}: status=${result.status}, latencyMs=${result.ms.toFixed(3)}`); wire(result, false);
    }
    await wait(async () => (await f.holds()).length === 0, 'recovery holds drain');
    // At least a full SQL budget after lock release. Delayed native callbacks must
    // not replay any abandoned A, including after successful ordinary recovery.
    await sleep(Math.max(0, held.started + lockMs + 5500 - performance.now()), undefined, { signal: t.signal });
    await noBindingsOrHolds();
    assert.deepEqual(await f.lockOwners(), [null, null, null]);
    const finalLeases = await f.rows('user_pool_leases');
    for (const lease of leases) {
      const retained = finalLeases.find(row => row.caller_id === lease.caller_id);
      assert.ok(retained); assert.equal(retained.lease_id, lease.lease_id); assert.equal(retained.member_identity, lease.member_identity);
    }
    const wireBusiness = f.mock.calls.filter(c => c.kind.startsWith('business-multihot-'));
    assert.equal(wireBusiness.some(c => c.kind.startsWith('business-multihot-a-')), false, 'No late upstream replay');
    for (const result of [...initial, ...pressure, ...recovery]) {
      assert.equal(wireBusiness.filter(c => c.kind === result.kind && c.pid === result.pid).length, result.status === 200 ? 1 : 0,
        'Each accepted B dispatched exactly once; failed B never dispatched');
    }
    for (const r of f.replicas) {
      const state = await f.snapshot(r); poolBounds(state);
      assert.equal(state.current.nativeQueued, 0); assert.equal(state.current.retainedTickets, 0);
      t.diagnostic(`pool PID ${r.pid}: ${JSON.stringify(state)}`);
    }
    assert.deepEqual(f.mock.failures, []);
    assert.ok((await f.rows('user_pool_accounts')).length <= 20);
    t.diagnostic('PASS: 60 finite A + five pressure B; all five B recover; no 500/HTML, replay, caller binding, hold, native queue or named-lock connection leak');
  } finally { await f.close(); }
});
