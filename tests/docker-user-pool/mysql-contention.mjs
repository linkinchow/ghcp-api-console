// Fixed isolated MySQL HTTP admission contention; no environment URL overrides.
// Only fixture SELECTs/named locks and release of this run's own caller leases.
import { writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { PROJECT, check, health, pool, mock, connectDatabase, request, inferOptions,
  successful, hash, status, auth } from './mysql-smoke.mjs';

check(process.env.POOL_MYSQL_CONTENTION_CONFIRM === PROJECT, 'explicit_contention_confirmation_required');
const DB_BUDGET_MS = 5000, HTTP_MS = 12000, DEADLINE_TOLERANCE_MS = 2000;
const OTHER_CALLER_BUDGET_MS = 2000;
const SQL_MS = 5000, QUIET_MS = 1000, DRAIN_MS = 15000, CLEANUP_MS = 35000;
// Client cancellation settles before the server's acquisition and late finish do.
const LATE_SETTLE_MS = 2 * DB_BUDGET_MS + DEADLINE_TOLERANCE_MS;
const report = { kind: 'hot_caller_named_lock_http', passed: false, phases: [], cleanup: {} };
const uid = randomUUID(), markerPrefix = 'hot-' + uid;
const shutdown = new AbortController(), ownCallers = new Set();
const intentionalCancel = new Error('intentional_fixture_cancellation');
let observer, locker, lockName, lastDispatchAt = 0, fixtureAuthorized = false;
const now = () => performance.now();
const lockFor = caller => createHash('sha256').update(JSON.stringify(['ghcp_pool_mysql_test', caller])).digest('hex');
const labelFor = error => error?.fixtureCheck && /^[a-z0-9_]+$/.test(error.message)
  ? error.message : 'fixture_or_transport_failure';
const pause = (ms, signal = shutdown.signal) => delay(Math.max(0, ms), undefined, { signal });

// Bound observer statements too: connectTimeout in the shared helper only bounds
// connection establishment, not its identity query or subsequent SQL. Dispose any
// connection returned after this runner has stopped waiting for it.
function bounded(start, ms, label, { signal = shutdown.signal, cancel = () => {}, late = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false, timer;
    const clear = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const stop = failure => {
      if (settled) return;
      settled = true; clear();
      try { cancel(); } catch { /* The caller retains the original failure. */ }
      reject(Object.assign(new Error(failure), { fixtureCheck: true }));
    };
    const abort = () => stop('contention_interrupted');
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop(label), ms);
    Promise.resolve().then(start).then(value => {
      if (settled) { try { late(value); } catch {} return; }
      settled = true; clear(); resolve(value);
    }, error => {
      if (settled) return;
      settled = true; clear(); reject(error);
    });
  });
}
const connect = (signal = shutdown.signal) => bounded(() => connectDatabase(), SQL_MS + 2000,
  'observer_connect_timeout', { signal, late: connection => connection.destroy() });
function select(connection, sql, values = [], signal = shutdown.signal) {
  check(/^SELECT\s/i.test(sql) && !/\b(?:INTO\s+OUTFILE|FOR\s+UPDATE)\b/i.test(sql), 'observer_select_only');
  return bounded(() => connection.query({ sql, values, timeout: SQL_MS }), SQL_MS + 250,
    'observer_query_timeout', { signal, cancel: () => connection.destroy() });
}
async function holds(connection, signal = shutdown.signal) {
  const [[s]] = await select(connection, `SELECT
    (SELECT COUNT(*) FROM user_pool_holds) n,
    (SELECT COUNT(*) FROM user_pool_catalog_holds) c`, [], signal);
  return Number(s.n) + Number(s.c);
}
async function drain(connection, notBefore = 0, signal = shutdown.signal) {
  await pause(notBefore - now(), signal);
  const end = now() + DRAIN_MS;
  let zeroSince;
  while (now() < end) {
    if (await holds(connection, signal) === 0) {
      zeroSince ??= now();
      if (now() - zeroSince >= QUIET_MS) return;
    } else zeroSince = undefined;
    await pause(100, signal);
  }
  check(false, 'hold_drain_timeout');
}
async function callerLeases(connection, callers, signal = shutdown.signal) {
  check(callers.length > 0 && callers.every(caller => ownCallers.has(caller)), 'foreign_caller_cleanup_forbidden');
  const [rows] = await select(connection, `SELECT caller_id,member_identity,lease_id FROM user_pool_leases
    WHERE caller_id IN (${callers.map(() => '?').join(',')})`, callers, signal);
  return rows;
}
async function releaseLeases(rows, signal = shutdown.signal) {
  for (const lease of rows) {
    check(ownCallers.has(lease.caller_id) && /^[a-f0-9-]{36}$/.test(lease.lease_id), 'foreign_lease_release_forbidden');
    status(await request('proxy2', `/api/user-pool/leases/${lease.lease_id}/release`, {
      method: 'POST', headers: auth, body: { confirm: true }, timeout: SQL_MS + 2000, signal,
    }), 200, 'release_contention_lease');
  }
}
async function fixtureMock() {
  return bounded(mock, HTTP_MS, 'mock_read_timeout');
}
async function wave(holdMs) {
  const caller = 'sha256:' + hash(uid + '-' + holdMs), other = 'sha256:' + hash(uid + '-other-' + holdMs);
  ownCallers.add(caller); ownCallers.add(other);
  lockName = lockFor(caller);
  const [[lock]] = await select(locker, 'SELECT GET_LOCK(?,0) ok', [lockName]);
  check(Number(lock.ok) === 1, 'named_lock_not_acquired');
  const started = now(), controllers = Array.from({ length: 32 }, () => new AbortController());
  const phase = { holdMs, requests: 34, cancelled: 16, otherCallerBudgetMs: OTHER_CALLER_BUDGET_MS, completed: false };
  report.phases.push(phase);
  const execute = async (i, c, service, controller) => {
    const id = markerPrefix + '-' + holdMs + '-' + i;
    const signal = controller ? AbortSignal.any([controller.signal, shutdown.signal]) : shutdown.signal;
    const dispatchedAt = now();
    lastDispatchAt = dispatchedAt;
    try {
      const response = await request(service, '/v1/messages', {
        ...inferOptions(c, '/v1/messages', `POOL_TEST:${JSON.stringify({ id })}`), signal, timeout: HTTP_MS,
      });
      if (response.status === 200) successful(response, '/v1/messages', false);
      return { i, id, service, kind: 'http', status: response.status, code: response.data?.error?.code,
        elapsedMs: now() - started, latencyMs: now() - dispatchedAt };
    } catch (error) {
      const kind = error === intentionalCancel ? 'cancelled'
        : shutdown.signal.aborted ? 'interrupted'
        : error?.name === 'TimeoutError' ? 'client_timeout'
        : error?.fixtureCheck ? 'fixture_error' : 'transport_error';
      return { i, id, service, kind, status: null, elapsedMs: now() - started, latencyMs: now() - dispatchedAt };
    }
  };
  const pending = controllers.map((controller, i) => execute(i, caller, i % 2 ? 'proxy2' : 'proxy', controller));
  // Probe B after a short dispatch head start for A on both replicas, before
  // A's cancellations and named-lock release. No privileged process inspection:
  // elapsed time is not proof of server-side waiters.
  await pause(started + 150 - now());
  phase.otherCallerStartedAtMs = now() - started;
  const probes = [execute(32, other, 'proxy'), execute(33, other, 'proxy2')];
  await pause(started + 350 - now());
  for (let i = 0; i < 16; i++) controllers[i].abort(intentionalCancel);
  await pause(started + holdMs - now());
  const [[released]] = await select(locker, 'SELECT RELEASE_LOCK(?) ok', [lockName]);
  check(Number(released.ok) === 1, 'named_lock_release');
  lockName = undefined;
  phase.lockReleasedAtMs = now() - started;
  const result = await Promise.all([...pending, ...probes]);
  phase.statuses = result.reduce((counts, r) => {
    const key = r.kind === 'http' ? String(r.status) : r.kind;
    counts[key] = (counts[key] ?? 0) + 1; return counts;
  }, {});
  const uncancelledCaller = result.slice(16, 32), otherCaller = result.slice(32);
  phase.maxUncancelledMs = Math.max(...result.slice(16).map(r => r.elapsedMs));
  phase.otherCaller = otherCaller.map(({ service, kind, status, code, elapsedMs, latencyMs }) =>
    ({ service, kind, status, code, elapsedMs, latencyMs }));
  // Shared connection starvation is a regression, not an acceptable B outcome.
  // Require both replicas' probes to succeed within B's own request budget in
  // BOTH lock-hold phases; A's storage-deadline allowance does not apply to B.
  check(otherCaller.every(r => r.kind === 'http' && r.status === 200), 'other_caller_not_isolated_http_200');
  check(otherCaller.every(r => r.latencyMs <= OTHER_CALLER_BUDGET_MS), 'other_caller_isolation_latency_exceeded');
  check(result.slice(0, 16).every(r => r.kind === 'cancelled'), 'intentional_cancellation_not_observed');
  check(uncancelledCaller.every(r => r.kind === 'http'), 'uncancelled_request_timeout_or_transport_failure');
  check(uncancelledCaller.every(r => [200, 503].includes(r.status)), 'unexpected_contention_status');
  check(uncancelledCaller.filter(r => r.status === 503).every(r => r.code === 'pool_storage_unavailable'), 'non_storage_contention_503');
  check(result.every(r => r.elapsedMs < HTTP_MS + 1000), 'unbounded_http_wait');
  if (holdMs > DB_BUDGET_MS) {
    check(uncancelledCaller.every(r => r.status === 503 && r.elapsedMs <= DB_BUDGET_MS + DEADLINE_TOLERANCE_MS),
      'long_hold_admission_missed_db_deadline');
  } else {
    check(uncancelledCaller.some(r => r.status === 200), 'short_hold_no_successful_admission');
  }
  await drain(observer, lastDispatchAt + LATE_SETTLE_MS);
  const recovery = [];
  let binding;
  for (const service of ['proxy', 'proxy2']) {
    const id = markerPrefix + '-after-' + holdMs + '-' + service;
    lastDispatchAt = now();
    successful(await request(service, '/v1/messages', {
      ...inferOptions(caller, '/v1/messages', `POOL_TEST:${JSON.stringify({ id })}`), timeout: HTTP_MS, signal: shutdown.signal,
    }), '/v1/messages', false);
    recovery.push(id);
    const rows = await callerLeases(observer, [caller]);
    check(rows.length === 1 && (!binding || rows[0].lease_id === binding.lease_id
      && rows[0].member_identity === binding.member_identity), 'recovery_binding_changed');
    binding = rows[0];
  }
  await drain(observer);
  const leases = await callerLeases(observer, [caller, other]);
  check(leases.filter(l => l.caller_id === caller).length === 1 && leases.filter(l => l.caller_id === other).length === 1
    && new Set(leases.map(l => l.member_identity)).size === leases.length, 'caller_binding_exclusivity');
  // Query all wave AND recovery markers only after the late-admission barrier and
  // final quiet drain; an early empty hold snapshot is not evidence of cleanup.
  const ids = new Set([...result.map(r => r.id), ...recovery]);
  const upstream = (await fixtureMock()).inference.filter(r => ids.has(r.marker));
  check(new Set(upstream.map(r => r.marker)).size === upstream.length, 'inference_replayed');
  for (const r of result) {
    const matches = upstream.filter(u => u.marker === r.id);
    check(matches.length === (r.status === 200 ? 1 : 0), r.kind === 'cancelled'
      ? 'cancelled_admission_reached_upstream' : r.status === 503 ? 'failed_admission_forwarded' : 'successful_inference_missing');
    if (matches.length) {
      const lease = leases.find(l => l.caller_id === (r.i < 32 ? caller : other));
      check(lease && matches[0].identity === lease.member_identity, 'wave_caller_identity_changed');
    }
  }
  for (const id of recovery) {
    const records = upstream.filter(r => r.marker === id);
    check(records.length === 1 && records[0].identity === binding.member_identity, 'recovery_probe_replayed_or_rotated');
  }
  await releaseLeases(leases);
  check((await callerLeases(observer, [caller, other])).length === 0, 'own_leases_not_released');
  check(await holds(observer) === 0, 'final_holds_not_drained');
  const [[owner]] = await select(locker, 'SELECT IS_FREE_LOCK(?) free', [lockFor(caller)]);
  check(Number(owner.free) === 1, 'named_lock_leaked');
  Object.assign(phase, { completed: true, upstream: upstream.length, postRecoveryProbes: recovery.length,
    lateSettleMs: LATE_SETTLE_MS, quietMs: QUIET_MS });
}
function interrupt(label) {
  report.passed = false; report.failure ??= label; process.exitCode = 1;
  shutdown.abort();
  // Destroying the holder socket releases GET_LOCK even if a SQL operation stalls.
  locker?.destroy(); observer?.destroy();
}
const onSigint = () => interrupt('contention_interrupted');
const onSigterm = () => interrupt('contention_interrupted');
process.once('SIGINT', onSigint); process.once('SIGTERM', onSigterm);
const watchdog = setTimeout(() => interrupt('contention_run_deadline'), 180000);
try {
  await bounded(health, 60000, 'fixture_health_timeout');
  observer = await connect(); locker = await connect();
  const s = await bounded(() => pool('proxy2', true), HTTP_MS, 'pool_preflight_timeout');
  check(s.settings.paused === 1 && s.counts.total >= 8 && s.counts.ready_idle >= 8, 'paused_ready_test_pool_required');
  check(await holds(observer) === 0, 'preexisting_holds_forbidden');
  fixtureAuthorized = true;
  await wave(1500); await wave(6500);
  report.passed = true;
} catch (error) {
  report.failure ??= labelFor(error); process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  shutdown.abort();
  locker?.destroy(); locker = undefined; lockName = undefined;
  observer?.destroy(); observer = undefined;
  const cleanupSignal = AbortSignal.timeout(CLEANUP_MS);
  // A helper may still be awaiting a hidden connection/health operation after our
  // bounded wait. Keep an unref'ed hard stop until those handles actually close.
  const hardStop = setTimeout(() => {
    console.error(JSON.stringify({ kind: report.kind, passed: false, failure: 'contention_cleanup_hard_deadline' }));
    process.exit(1);
  }, CLEANUP_MS + 5000);
  try {
    if (fixtureAuthorized && ownCallers.size) {
      observer = await connect(cleanupSignal);
      await drain(observer, lastDispatchAt + LATE_SETTLE_MS, cleanupSignal);
      const remaining = await callerLeases(observer, [...ownCallers], cleanupSignal);
      await releaseLeases(remaining, cleanupSignal);
      check((await callerLeases(observer, [...ownCallers], cleanupSignal)).length === 0, 'cleanup_own_leases_remain');
      check(await holds(observer, cleanupSignal) === 0, 'cleanup_holds_remain');
      for (const caller of ownCallers) {
        const [[owner]] = await select(observer, 'SELECT IS_FREE_LOCK(?) free', [lockFor(caller)], cleanupSignal);
        check(Number(owner.free) === 1, 'cleanup_named_lock_leaked');
      }
      report.cleanup = { passed: true, releasedOwnLeases: remaining.length };
    } else report.cleanup = { passed: true, noDispatchedCallers: true };
  } catch (error) {
    report.passed = false; report.cleanup = { passed: false, failure: labelFor(error) }; process.exitCode = 1;
  } finally {
    observer?.destroy(); observer = undefined;
    try {
      await writeFile('/opt/ghcp-test/results/matrix-contention-report.json', JSON.stringify(report, null, 2));
    } catch {
      report.passed = false; report.reportWriteFailure = true; process.exitCode = 1;
    }
    console.log(JSON.stringify(report));
    hardStop.unref();
    process.removeListener('SIGINT', onSigint); process.removeListener('SIGTERM', onSigterm);
  }
}
