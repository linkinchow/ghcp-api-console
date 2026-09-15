// Bounded soak of the ALREADY RUNNING disposable mysql-smoke fixture (Node 22).
// POOL_MYSQL_SOAK_CONFIRM=ghcp-user-pool-mysql-test node tests/docker-user-pool/mysql-soak.mjs
// [--seconds=1800] [--concurrency=6]  Duration: 60..3600s; concurrency: 4..8.
// 60s is a diagnostic run, not a 30-minute soak. Serial fault recovery and final
// expiry/drain checks can extend the traffic period, especially in a 60s run.
// Never loads .env, seeds SQL, retries inference, or invokes Docker itself.
// The parent starts the stability overlay; only stability-control's fixed actions
// are used. Reports contain numbers/fixed labels, never credentials or identities.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PROJECT, auth, check, safeFailure, hash, sleep, request, status,
  mock, inferOptions, successful, health, connectDatabase, databaseState, invariants } from './mysql-smoke.mjs';

const LB = Object.freeze({ businessLB: 'http://127.0.0.1:18105', internalLB: 'http://127.0.0.1:18106' });
const PATHS = ['/v1/messages', '/chat/completions', '/responses'];
const MAX_REQUESTS = 10000, TRAFFIC_BUDGET = 8000, REQUEST_TIMEOUT = 40000;
const SQL_TIMEOUT = 5500, RECOVERY_TIMEOUT = 60000, HOLD_DRAIN_TIMEOUT = 55000;
const CONTROL_ACTIONS = ['stop-proxy', 'start-proxy', 'pause-mysql', 'unpause-mysql', 'snapshot'];
const execute = promisify(execFile);
const prefix = `soak-${randomUUID().slice(0, 8)}`;
const counts = { requests: 0, successes: 0, cancellations: 0, expectedErrors: 0, unexpectedErrors: 0,
  planned401: 0, recovered401: 0, planned429: 0, coolingProbes: 0, coolingBindingsChecked: 0,
  slowSseSuccesses: 0, expiredInactiveCallers: 0, observerSamples: 0, observerReconnects: 0,
  expectedObserverFailures: 0, maxHolds: 0, managementSamples: 0, survivingProxySuccesses: 0,
  naturalLeaseTransitions: 0, repairedLeaseTransitions: 0 };
const httpStatuses = {}, backends = {}, expectedReasons = {}, errors = {}, errorExamples = [];
const latency = new Map(), issued = new Map(), bindings = new Map(), recoveries = new Map(), epochs = new Map();
const faultWindows = [], resources = [], phases = [], activeControllers = new Set();
const shutdown = new AbortController();
let options, callers = [], inactiveCaller, inactiveLease, initialMock, initialMembers;
let started = 0, trafficStarted = 0, trafficEnd = 0, hardDeadline = 0, requestBudget = 0;
let observer, sqlQueue = Promise.resolve(), sampling = false, stopRequested = false, fixtureConfirmed = false;
let proxyMayBeStopped = false, mysqlMayBePaused = false, mysqlReconnectAllowed = true;
let sampler, reporter, workerTasks = [], faultTask, reportDirectory, progressPath, watchdog;
let lastSql, finalMockCounts, stopReason = 'duration', completed = false, trafficStopped = 0;

function parseOptions() {
  const result = { seconds: 1800, concurrency: 6 }, seen = new Set();
  for (const argument of process.argv.slice(2)) {
    const match = /^--(seconds|concurrency)=([0-9]+)$/.exec(argument);
    check(match && !seen.has(match[1]), 'invalid_soak_argument');
    seen.add(match[1]); result[match[1]] = Number(match[2]);
  }
  check(Number.isSafeInteger(result.seconds) && result.seconds >= 60 && result.seconds <= 3600, 'soak_seconds_bound');
  check(Number.isSafeInteger(result.concurrency) && result.concurrency >= 4 && result.concurrency <= 8, 'soak_concurrency_bound');
  return result;
}
function elapsed() { return started ? Date.now() - started : 0; }
function failure(label, details = {}) {
  const code = /^[a-z0-9_]+$/.test(label) ? label : 'unsafe_error_suppressed';
  counts.unexpectedErrors++; errors[code] = (errors[code] ?? 0) + 1;
  if (errorExamples.length < 20) errorExamples.push({ code, elapsedMs: elapsed(), ...details });
}
function stop(reason) {
  stopReason = reason; stopRequested = true; shutdown.abort();
  for (const controller of activeControllers) controller.abort();
}
async function wait(ms, interruptible = true) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (interruptible) check(!stopRequested && Date.now() < hardDeadline, 'soak_interrupted');
    await sleep(Math.min(200, end - Date.now()));
  }
}
function overlaps(start, end, kind) {
  return faultWindows.filter(window => (!kind || window.kind === kind)
    && start <= (window.recoveryUntil ?? window.end ?? window.limit) && end >= window.start);
}
function expected(reason) {
  counts.expectedErrors++; expectedReasons[reason] = (expectedReasons[reason] ?? 0) + 1;
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = quantile => sorted.length ? Math.round(sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] * 100) / 100 : null;
  return { samples: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: at(1) };
}
function observe(key, value) {
  const values = latency.get(key) ?? []; values.push(value); latency.set(key, values);
}
async function lbRequest(service, path, { method = 'GET', body, headers = {}, timeout = 5000, signal } = {}) {
  check(Object.hasOwn(LB, service) && path.startsWith('/') && !path.startsWith('//'), 'invalid_soak_target');
  const response = await fetch(LB[service] + path, { method, redirect: 'error',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
  const text = await response.text();
  check(text.length < 4 * 1024 * 1024, 'soak_response_bound');
  let data;
  try { data = JSON.parse(text); } catch { /* Only inference may legitimately be SSE. */ }
  return { status: response.status, headers: response.headers, text, data };
}
async function lbPool(summary = false) {
  return status(await lbRequest('internalLB', `/api/user-pool${summary ? '/summary' : ''}`, { headers: auth }), 200, 'soak_pool').data;
}
async function changeSettings(changes) {
  const previous = (await lbPool(true)).settings;
  const result = status(await lbRequest('internalLB', '/api/user-pool/settings', { method: 'PATCH', headers: auth,
    body: { expectedVersion: previous.version, changes } }), 200, 'soak_settings').data;
  check(result.version === previous.version + 1, 'soak_settings_version');
}
async function manifest(service) {
  const result = Object.hasOwn(LB, service)
    ? await lbRequest(service, '/__mysql/manifest') : await request(service, '/__mysql/manifest', { timeout: 5000 });
  const value = status(result, 200, 'soak_manifest').data;
  check(value.fixture === true && value.project === PROJECT && value.database === 'ghcp_pool_mysql_test'
    && value.mysqlPort === 33184 && value.service === service, 'wrong_soak_fixture');
}
async function databaseGate() {
  // Required again before EVERY observer connection, including after an outage.
  await Promise.all([manifest('mock'), manifest('internalLB')]);
  check(status(await lbRequest('internalLB', '/readyz'), 200, 'soak_sql_ready').data.storage === 'mysql', 'soak_not_mysql');
}
async function readiness() {
  await Promise.all(['proxy', 'proxy2'].map(async service => {
    await manifest(service);
    check(status(await request(service, '/readyz', { timeout: 5000 }), 200, 'soak_direct_ready').data.storage === 'mysql', 'soak_not_mysql');
  }));
  for (const service of Object.keys(LB)) {
    await manifest(service);
    check(status(await lbRequest(service, '/readyz'), 200, 'soak_lb_ready').data.storage === 'mysql', 'soak_not_mysql');
  }
}
async function until(label, read, predicate, timeout, tolerateTransport = false) {
  const end = Math.min(Date.now() + timeout, hardDeadline);
  while (Date.now() < end && !stopRequested) {
    try { const value = await read(); if (predicate(value)) return value; }
    catch (error) {
      if (!tolerateTransport || error?.fixtureCheck && ['wrong_soak_fixture', 'soak_not_mysql'].includes(error.message)) throw error;
    }
    await wait(250);
  }
  // Never print a captured driver/HTTP exception; retain only this fixed label.
  check(false, `${label}_timeout`);
}
async function control(action) {
  check(fixtureConfirmed && CONTROL_ACTIONS.includes(action), 'soak_control_not_authorized');
  // No shell, target, project, compose-file, environment file, or CLI override.
  try {
    const { stdout } = await execute(process.execPath, [fileURLToPath(new URL('./stability-control.mjs', import.meta.url)), action],
      { timeout: 45000, maxBuffer: 128 * 1024, windowsHide: true });
    const result = JSON.parse(stdout);
    check(result?.fixture === true && result.project === PROJECT, 'soak_control_wrong_fixture');
    if (action !== 'snapshot') {
      check(result.action === action, 'soak_control_wrong_action');
      if (action === 'stop-proxy') check(result.running === false, 'soak_proxy_not_stopped');
      if (action === 'start-proxy') check(result.running === true, 'soak_proxy_not_started');
      if (action === 'pause-mysql') check(result.paused === true, 'soak_mysql_not_paused');
      if (action === 'unpause-mysql') check(result.paused === false, 'soak_mysql_not_unpaused');
    }
    return result;
  } catch { check(false, `soak_control_${action.replaceAll('-', '_')}_failed`); }
}
async function sql(work) {
  const job = sqlQueue.then(async () => {
    check(mysqlReconnectAllowed || observer, 'soak_observer_outage_gate');
    if (!observer) {
      await databaseGate(); observer = await connectDatabase('observer'); counts.observerReconnects++;
    }
    const connection = observer;
    let timer;
    try {
      return await Promise.race([work(connection), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('sql_timeout')), SQL_TIMEOUT);
      })]);
    } catch (error) {
      connection.destroy(); if (observer === connection) observer = undefined;
      throw error;
    } finally { clearTimeout(timer); }
  });
  sqlQueue = job.catch(() => {});
  return job;
}
async function discardObserver() {
  const job = sqlQueue.then(() => { observer?.destroy(); observer = undefined; });
  sqlQueue = job.catch(() => {}); await job;
}
async function sqlState() { return sql(db => databaseState(db)); }
async function lease(caller) {
  return sql(async db => {
    const [rows] = await db.query(`SELECT l.lease_id, l.member_identity, l.phase, l.assigned_at, l.last_success_at, l.expires_at,
      p.state, p.reauth_count, p.generation, p.cooldown_until,
      TIMESTAMPDIFF(MICROSECOND,'1970-01-01',UTC_TIMESTAMP(3)) DIV 1000 AS observed_at FROM user_pool_leases l
      JOIN user_pool_accounts p ON p.identity=l.member_identity WHERE l.caller_id=?`, [caller]);
    return rows[0];
  });
}
function rememberLease(caller, row) {
  const history = epochs.get(caller) ?? [];
  const prior = history.at(-1), repair = recoveries.get(caller);
  if (prior?.leaseId === row.lease_id) {
    prior.expiresAt = Math.max(prior.expiresAt, Number(row.expires_at));
    check(prior.member === row.member_identity, 'soak_member_changed_within_lease');
  } else {
    if (prior) {
      const plannedInvalidation = repair && repair.leaseId === prior.leaseId
        && Number(row.assigned_at) >= repair.started - 1000;
      check(plannedInvalidation || Number(row.assigned_at) >= prior.expiresAt, 'soak_unexpired_lease_rotated');
      if (plannedInvalidation) counts.repairedLeaseTransitions++; else counts.naturalLeaseTransitions++;
      prior.replacedAt = Number(row.assigned_at);
    }
    history.push({ leaseId: row.lease_id, member: row.member_identity, assignedAt: Number(row.assigned_at),
      expiresAt: Number(row.expires_at), replacedAt: null });
    epochs.set(caller, history);
  }
  bindings.set(caller, row.member_identity);
}
function bindingStable(before, after) {
  return before && after && before.lease_id === after.lease_id && before.member_identity === after.member_identity
    && before.phase === after.phase && Number(before.expires_at) === Number(after.expires_at)
    && Number(before.last_success_at) === Number(after.last_success_at);
}
async function initialize() {
  await health(); await Promise.all(Object.keys(LB).map(manifest)); await readiness();
  fixtureConfirmed = true;
  const [initial, fixture] = await Promise.all([lbPool(), mock()]);
  const initialCount = Number(initial.counts.total);
  check(initial.enabled && [3, 4, 12].includes(initialCount) && initial.accounts.length === initialCount, 'soak_requires_real_smoke_fixture');
  check(fixture.fixture && fixture.users.length === initialCount && fixture.seats.length === initialCount
    && fixture.counters.scimCreates === initialCount && fixture.counters.callbacksSucceeded >= initialCount
    && fixture.counters.callbacksFailed === 0 && fixture.nextControl === null, 'soak_requires_real_mock_provisioning');
  initialMembers = new Set(initial.accounts.map(member => member.identity));
  check(fixture.users.every(user => initialMembers.has(user.userName)), 'soak_seeded_members_forbidden');
  // Release only the existing fixture's bindings, with no active holds. No SQL writes.
  await until('soak_initial_drain', sqlState, row => Number(row.holds) === 0 && Number(row.catalog_holds) === 0, HOLD_DRAIN_TIMEOUT);
  for (const entry of initial.leases) status(await lbRequest('internalLB', `/api/user-pool/leases/${encodeURIComponent(entry.leaseId)}/release`,
    { method: 'POST', headers: auth, body: { confirm: true } }), 200, 'soak_initial_release');
  await changeSettings({ idle_target: 0, max_accounts: 32, lease_seconds: 60, paused: 0 });
  await until('soak_initial_cooldown', () => lbPool(true), value => value.counts.ready_idle === initialCount && value.counts.provisioning === 0, 45000);
  await changeSettings({ idle_target: 12 });
  await until('soak_twelve_real_members', () => lbPool(true), value => value.counts.total === 12
    && value.counts.ready_idle === 12 && value.counts.provisioning === 0, 150000);
  await changeSettings({ idle_target: 0, paused: 0 });
  const warmed = await lbPool(); initialMock = await mock();
  check(warmed.counts.total === 12 && warmed.settings.max_accounts === 32 && warmed.settings.lease_seconds === 60
    && warmed.settings.idle_target === 0 && warmed.settings.paused === 0, 'soak_worker_settings');
  check(initialMock.counters.scimCreates === 12 && initialMock.counters.callbacksSucceeded >= 12
    && initialMock.counters.callbacksFailed === 0 && initialMock.users.length === 12
    && initialMock.seats.length === 12 && initialMock.nextControl === null, 'soak_twelve_provisioning_chain');
  initialMembers = new Set(warmed.accounts.map(member => member.identity));
  check(initialMock.users.every(user => initialMembers.has(user.userName)), 'soak_inventory_source_mismatch');
  // Leave space for warmup records and setup/final probes; the mock retains 10000.
  requestBudget = Math.min(MAX_REQUESTS, 9500 - initialMock.inference.length);
  check(requestBudget > TRAFFIC_BUDGET + 100, 'soak_mock_record_budget');
  callers = Array.from({ length: options.concurrency }, (_, n) => `sha256:${hash(`${prefix}-caller-${n}`)}`);
  inactiveCaller = `sha256:${hash(`${prefix}-inactive`)}`;
  for (const caller of [...callers, inactiveCaller]) {
    const result = await send(caller, { path: PATHS[0], mode: 'json', setup: true });
    check(result?.classification === 'success', 'soak_initial_inference');
    const current = await until('soak_initial_active_lease', () => lease(caller), value => value?.phase === 'active', 10000);
    rememberLease(caller, current);
    if (caller === inactiveCaller) inactiveLease = current;
  }
  check(new Set(bindings.values()).size === bindings.size, 'soak_initial_exclusive_members');
  phases.push({ name: 'initialized_twelve_real_members', elapsedMs: elapsed() });
}

async function send(caller, spec) {
  check(counts.requests < requestBudget && counts.requests < MAX_REQUESTS, 'soak_request_budget');
  const id = `${prefix}-${++counts.requests}`, controller = new AbortController();
  const known = epochs.get(caller)?.at(-1), repairState = recoveries.get(caller);
  const pinIsLive = known && known.expiresAt > Date.now() + REQUEST_TIMEOUT
    && !(repairState && repairState.leaseId === known.leaseId);
  const entry = { id, caller, path: spec.path, mode: spec.mode, started: Date.now(), ended: null,
    status: null, backend: 'unknown', classification: null, requiredUpstream: false,
    expectedMember: pinIsLive ? known.member : undefined };
  issued.set(id, entry); activeControllers.add(controller);
  const stream = spec.mode !== 'json';
  const marker = { id, ...(spec.status ? { status: spec.status } : {}), ...(spec.status === 429 ? { retryAfter: 10 } : {}),
    ...(spec.mode === 'cancel' ? { streamMode: 'hold' } : {}), ...(spec.delayMs ? { delayMs: spec.delayMs } : {}) };
  const args = inferOptions(caller, spec.path, `Reply OK. POOL_TEST:${JSON.stringify(marker)}`, stream);
  const start = performance.now(); let cancelTimer, deliberateCancel = false, caught, response, text = '';
  try {
    response = await fetch(LB.businessLB + spec.path, { method: 'POST', redirect: 'error',
      headers: { ...args.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(args.body),
      signal: AbortSignal.any([controller.signal, shutdown.signal, AbortSignal.timeout(REQUEST_TIMEOUT)]) });
    entry.status = response.status;
    const backend = response.headers.get('x-fixture-backend');
    entry.backend = ['proxy', 'proxy2'].includes(backend) ? backend : 'unknown';
    if (spec.mode === 'cancel' && response.status === 200) {
      check(response.headers.get('content-type')?.includes('text/event-stream'), 'soak_hold_content_type');
      // Cancel one second after SSE headers, not before admission can reach mock.
      cancelTimer = setTimeout(() => { deliberateCancel = true; controller.abort(); }, 1000);
    }
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder(); let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          bytes += next.value.byteLength; check(bytes < 2 * 1024 * 1024, 'soak_inference_response_bound');
          text += decoder.decode(next.value, { stream: true });
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
    }
  } catch (error) { caught = error; }
  finally {
    clearTimeout(cancelTimer); controller.abort(); activeControllers.delete(controller);
    entry.ended = Date.now(); entry.durationMs = performance.now() - start;
    const window = overlaps(entry.started, entry.ended);
    entry.faults = window.map(value => value.kind);
    observe(`${spec.path}_${spec.mode}_${window.length ? 'fault' : 'normal'}`, entry.durationMs);
    const key = entry.status ?? 'network'; httpStatuses[key] = (httpStatuses[key] ?? 0) + 1;
    backends[entry.backend] = (backends[entry.backend] ?? 0) + 1;
  }
  let data;
  try { data = JSON.parse(text); } catch { /* SSE is parsed by successful(). */ }
  const result = response ? { status: response.status, headers: response.headers, text, data } : undefined;
  const code = data?.error?.code;
  const repair = recoveries.get(caller);
  const inRepair = repair && known?.member === repair.member && entry.started >= repair.started
    && entry.started <= repair.until && !repair.completed;
  try {
    if (caught?.fixtureCheck) throw caught;
    if (deliberateCancel && entry.status === 200) {
      check(text.includes('data:'), 'soak_cancel_without_sse_data');
      counts.cancellations++; entry.classification = 'cancel'; entry.requiredUpstream = true;
    } else if (!caught && entry.status === 200) {
      check(!spec.status && !spec.coolingProbe && spec.mode !== 'cancel', 'soak_planned_error_not_observed');
      try { successful(result, spec.path, stream); }
      catch (error) {
        // A severed HTTP 200 stream may finish as EOF rather than a socket error.
        // Attribute only missing terminal/error events to an actual fault window;
        // wrong model/content/protocol remains an unexpected failure.
        if (entry.faults.length && stream && ['sse_terminal', 'sse_in_band_error'].includes(error.message)) {
          expected('fault_interrupted_sse'); entry.classification = 'fault'; return entry;
        }
        throw error;
      }
      counts.successes++; entry.classification = 'success'; entry.requiredUpstream = true;
      if (spec.delayMs) counts.slowSseSuccesses++;
      if (entry.backend === 'proxy2' && faultWindows.some(window => window.kind === 'proxy_stop'
        && entry.started >= window.stoppedAt && entry.ended <= (window.restartAt ?? window.limit))) counts.survivingProxySuccesses++;
    } else if (!caught && spec.status === 401 && entry.status === 401 && code === 'fixture_401') {
      expected('planned_upstream_401'); counts.planned401++; entry.classification = 'planned_401'; entry.requiredUpstream = true;
    } else if (!caught && spec.status === 429 && entry.status === 429 && code === 'fixture_429') {
      check(result.headers.get('retry-after') === '10', 'soak_retry_after_ten_seconds');
      expected('planned_upstream_429'); counts.planned429++; entry.classification = 'planned_429'; entry.requiredUpstream = true;
    } else if (!caught && spec.coolingProbe && entry.status === 429 && code === 'member_cooling') {
      check(Number(result.headers.get('retry-after')) >= 1, 'soak_cooling_retry_after');
      expected('planned_member_cooling'); counts.coolingProbes++; entry.classification = 'cooling';
    } else if (!caught && inRepair && ((entry.status === 503 && ['member_unavailable', 'member_draining', 'lease_draining'].includes(code))
      || (entry.status === 429 && code === 'member_cooling'))) {
      expected(`planned_401_${code}`); entry.classification = 'repair';
    } else if (entry.faults.length && (caught && !caught.fixtureCheck
      || [502, 503, 504].includes(entry.status))) {
      expected(`fault_${entry.faults.join('_')}_${caught ? 'network_or_stream' : entry.status}`); entry.classification = 'fault';
    } else {
      check(false, caught ? 'soak_unexpected_transport_or_stream' : 'soak_unexpected_http_status');
    }
  } catch (error) {
    entry.classification = 'unexpected'; failure(safeFailure(error), { status: entry.status, backend: entry.backend,
      responseCode: typeof code === 'string' && /^[a-z0-9_]{1,80}$/.test(code) ? code : null });
  }
  return entry;
}
async function coolingCycle(caller, path) {
  // HTTP completion precedes the previous request's committed finish. Establish
  // the no-renewal baseline only after its hold is gone, not during that renewal.
  await until('soak_cooling_prior_finish', () => sql(async db => {
    const [[row]] = await db.query(`SELECT COUNT(*) n FROM user_pool_holds h JOIN user_pool_leases l ON l.lease_id=h.lease_id WHERE l.caller_id=?`, [caller]);
    return Number(row.n);
  }), count => count === 0, 10000);
  const before = await lease(caller), start = Date.now();
  const limited = await send(caller, { path, mode: 'json', status: 429 });
  if (limited.classification === 'planned_429') {
    // This is a NEW request/marker, not a retry of the failed upstream call.
    const probe = await send(caller, { path, mode: 'json', coolingProbe: true });
    const after = await lease(caller);
    if (overlaps(start, Date.now()).length === 0) {
      check(probe.classification === 'cooling', 'soak_cooling_admission_not_blocked');
      check(Number(after.cooldown_until) > Number(after.observed_at), 'soak_cooling_observation_window_elapsed');
      check(bindingStable(before, after), 'soak_429_renewed_or_rotated_binding');
      counts.coolingBindingsChecked++;
    }
    await wait(10100); // Respect the test's ten-second cooldown before using this caller again.
  }
}
async function beginRepair(caller) {
  const before = await lease(caller);
  check(before?.state === 'ready' && before.member_identity === bindings.get(caller), 'soak_repair_baseline');
  if (before) rememberLease(caller, before);
  const repair = { started: Date.now(), until: Date.now() + RECOVERY_TIMEOUT, leaseId: before.lease_id,
    member: before.member_identity, reauthCount: Number(before.reauth_count), completed: false };
  recoveries.set(caller, repair);
  const response = await send(caller, { path: PATHS[0], mode: 'json', status: 401 });
  check(response.classification === 'planned_401', 'soak_planned_401_not_delivered');
}
async function verifyRepair(caller) {
  const repair = recoveries.get(caller); if (!repair || repair.completed) return;
  const current = await sql(async db => {
    const [rows] = await db.query('SELECT state, reauth_count, verified_at FROM user_pool_accounts WHERE identity=?', [repair.member]);
    return rows[0];
  });
  check(current, 'soak_401_original_member_missing');
  if (current.state === 'ready' && current.verified_at !== null && Number(current.reauth_count) === repair.reauthCount + 1) {
    repair.completed = true; repair.completedAt = Date.now(); counts.recovered401++;
    phases.push({ name: 'existing_member_401_recovered', elapsedMs: elapsed(), durationMs: repair.completedAt - repair.started });
  } else check(Date.now() <= repair.until, 'soak_401_recovery_timeout');
}
function injectionSafe() {
  const now = Date.now();
  return !overlaps(now - 5000, now + 5000).length
    && (now < trafficStarted + options.seconds * 1000 / 3 - 5000
      || now > trafficStarted + options.seconds * 2000 / 3 + 90000);
}
async function worker(index) {
  const caller = callers[index]; let turn = 0, repairAttempted = false;
  const cadence = Math.max(1000, options.seconds * 1000 * options.concurrency / Math.min(TRAFFIC_BUDGET, options.seconds * 4));
  while (!stopRequested && (Date.now() < trafficEnd || !faultTask.done)) {
    if (counts.requests >= Math.min(requestBudget - 40, TRAFFIC_BUDGET)) { stopReason = 'request_budget'; return; }
    const begin = Date.now(), path = PATHS[(turn + index) % PATHS.length];
    try {
      // One cycle in the entire run: never more than two per caller/member/hour.
      if (index === 0 && !repairAttempted && turn >= 2 && injectionSafe()) {
        repairAttempted = true; await beginRepair(caller);
      } else if ((turn === 3 && index === 1 || turn > 0 && turn % 43 === 0) && injectionSafe()
        && (!recoveries.has(caller) || recoveries.get(caller).completed)) {
        await coolingCycle(caller, path);
      } else {
        const slow = turn % 17 === 7;
        // Deterministic rotation covers 2..20s successful streams on all protocols.
        const delayMs = slow ? 2000 + ((Math.floor(turn / 17) + index) % 10) * 2000 : 0;
        const mode = turn % 19 === 5 ? 'cancel' : slow || turn % 3 === 1 ? 'sse' : 'json';
        const response = await send(caller, { path, mode, delayMs });
        if (response.classification === 'success') await verifyRepair(caller);
        else if (response.classification === 'repair') {
          check(Date.now() <= recoveries.get(caller).until, 'soak_401_recovery_timeout');
          await wait(1100);
        }
      }
    } catch (error) {
      if (stopRequested) return;
      // SQL-only checks can straddle the deliberately paused database. The HTTP
      // classifier independently checks each actual request; it is never retried.
      if (overlaps(begin, Date.now(), 'mysql_pause').length
        && (!error?.fixtureCheck || error.message === 'soak_observer_outage_gate')) counts.expectedObserverFailures++;
      else { failure(safeFailure(error)); stop('worker_failure'); return; }
    }
    turn++;
    await wait(Math.max(0, cadence - (Date.now() - begin))).catch(() => {});
  }
}

async function observeSql() {
  const row = await sql(async db => {
    const state = await databaseState(db); invariants(state);
    counts.observerSamples++; counts.maxHolds = Math.max(counts.maxHolds, Number(state.holds) + Number(state.catalog_holds));
    const [[extra]] = await db.query(`SELECT
      (SELECT COUNT(*) FROM user_pool_catalog_holds WHERE expires_at<deadline_at OR expires_at-deadline_at<>10000) invalid_catalog_deadlines,
      (SELECT COUNT(*) FROM user_pool_catalog_holds h JOIN user_pool_leases l ON l.member_identity=h.member_identity WHERE l.caller_id<>h.caller_id) catalog_owner_conflicts,
      (SELECT COUNT(*) FROM user_pool_accounts p LEFT JOIN proxy_accounts a ON a.identity=p.identity WHERE a.identity IS NULL) orphan_members`);
    check(Object.values(extra).every(value => Number(value) === 0), 'soak_catalog_or_inventory_invariant');
    const [leases] = await db.query('SELECT caller_id, lease_id, member_identity, assigned_at, expires_at FROM user_pool_leases');
    for (const entry of leases) if (bindings.has(entry.caller_id)) rememberLease(entry.caller_id, entry);
    if (inactiveLease && !leases.some(entry => entry.caller_id === inactiveCaller)) {
      check(Number(state.now_ms) >= Number(inactiveLease.expires_at), 'soak_inactive_lease_expired_early');
      counts.expiredInactiveCallers = 1;
    }
    check(Number(state.members) === 12, 'soak_unplanned_member_provisioning');
    return state;
  });
  lastSql = { members: Number(row.members), leases: Number(row.leases), holds: Number(row.holds), catalogHolds: Number(row.catalog_holds) };
  return row;
}
async function sampleLoop() {
  while (sampling && !stopRequested) {
    const begin = Date.now();
    try { if (mysqlReconnectAllowed || observer) await observeSql(); }
    catch (error) {
      if (!error?.fixtureCheck && overlaps(begin, Date.now(), 'mysql_pause').length) counts.expectedObserverFailures++;
      else if (error?.fixtureCheck && error.message === 'soak_observer_outage_gate' && !mysqlReconnectAllowed) { /* Already classified timeout; wait for gate. */ }
      else { failure(safeFailure(error)); stop('sql_invariant_or_observer_failure'); }
    }
    await wait(1000).catch(() => {});
  }
}
function openFault(kind, plannedHoldMs) {
  const start = Date.now();
  // Command deadlines plus explicit hold plus <=60s recovery; never open-ended.
  const window = { kind, start, end: null, limit: start + 90000 + plannedHoldMs + RECOVERY_TIMEOUT };
  faultWindows.push(window); return window;
}
async function injectFaults() {
  try {
    await wait(Math.max(0, trafficStarted + options.seconds * 1000 / 3 - Date.now()));
    const proxyWindow = openFault('proxy_stop', 35000);
    proxyMayBeStopped = true;
    try {
      await control('stop-proxy'); proxyWindow.stoppedAt = Date.now();
      await wait(35000);
    } finally {
      await control('start-proxy'); proxyMayBeStopped = false; proxyWindow.restartAt = Date.now();
    }
    proxyWindow.limit = Date.now() + RECOVERY_TIMEOUT;
    await until('soak_proxy_recovery', readiness, () => true, RECOVERY_TIMEOUT, true);
    proxyWindow.end = Date.now(); proxyWindow.recoveryUntil = proxyWindow.limit;
    phases.push({ name: 'proxy_stop_recovered', elapsedMs: elapsed(), faultMs: proxyWindow.end - proxyWindow.start });
    // A 60s debug run serializes these phases instead of overlapping injections.
    await wait(Math.max(0, trafficStarted + options.seconds * 2000 / 3 - Date.now()));
    const mysqlWindow = openFault('mysql_pause', 12000);
    mysqlMayBePaused = true; mysqlReconnectAllowed = false;
    try {
      await control('pause-mysql'); mysqlWindow.pausedAt = Date.now();
      await wait(12000);
    } finally {
      await control('unpause-mysql'); mysqlMayBePaused = false; mysqlWindow.unpausedAt = Date.now();
    }
    mysqlWindow.limit = Date.now() + RECOVERY_TIMEOUT;
    await until('soak_mysql_recovery', readiness, () => true, RECOVERY_TIMEOUT, true);
    await databaseGate();
    // Destroy stale observer even if it did not sample while MySQL was paused.
    // Serialize disposal with samples so we never destroy their live connection.
    await discardObserver(); mysqlReconnectAllowed = true;
    await observeSql(); mysqlWindow.end = Date.now(); mysqlWindow.recoveryUntil = mysqlWindow.limit;
    phases.push({ name: 'mysql_pause_recovered', elapsedMs: elapsed(), faultMs: mysqlWindow.end - mysqlWindow.start });
  } catch (error) {
    if (!stopRequested) failure(safeFailure(error));
    stop('fault_or_recovery_failure');
  } finally { faultTask.done = true; }
}
function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const result = Number(value); return Number.isFinite(result) && result >= 0 ? result : null;
}
async function resourceSnapshot() {
  const value = await control('snapshot');
  check(value?.project === PROJECT && Array.isArray(value.containers), 'soak_snapshot_shape');
  const allowed = new Set(['proxy', 'proxy2', 'mysql', 'mock', 'pool-lb']);
  const containers = value.containers.filter(item => allowed.has(item.service)).map(item => ({ service: item.service,
    cpuPercent: finite(item.cpuPercent), memoryBytes: finite(item.memoryBytes), pids: finite(item.pids) }));
  check(containers.length > 0, 'soak_snapshot_resources_missing');
  if (!overlaps(Date.now(), Date.now(), 'mysql_pause').length) {
    const connections = finite(value.mysql?.threadsConnected);
    check(connections !== null, 'soak_snapshot_mysql_connections_missing');
  }
  resources.push({ elapsedMs: elapsed(), phase: overlaps(Date.now(), Date.now()).map(value => value.kind).join('_') || 'normal', containers,
    mysql: value.mysql ? { threadsConnected: finite(value.mysql.threadsConnected), maxUsedConnections: finite(value.mysql.maxUsedConnections) } : null });
}
function resourceDrift() {
  const stable = resources.filter(value => value.phase === 'normal');
  const first = stable[0], last = stable.at(-1);
  if (!first || !last) return null;
  return { firstSampleMs: first.elapsedMs, lastSampleMs: last.elapsedMs,
    containers: first.containers.map(before => {
      const after = last.containers.find(value => value.service === before.service);
      const delta = key => before[key] !== null && after?.[key] !== null && after?.[key] !== undefined ? after[key] - before[key] : null;
      return { service: before.service, memoryBytesDelta: delta('memoryBytes'), pidsDelta: delta('pids'),
        firstCpuPercent: before.cpuPercent, lastCpuPercent: after?.cpuPercent ?? null };
    }), mysqlConnectionsDelta: first.mysql?.threadsConnected !== null && last.mysql?.threadsConnected !== null
      && first.mysql && last.mysql ? last.mysql.threadsConnected - first.mysql.threadsConnected : null };
}
async function progress(final = false) {
  const value = { type: final ? 'final' : 'progress', fixture: PROJECT, elapsedMs: elapsed(),
    requestedSeconds: options?.seconds, concurrency: options?.concurrency, counts: { ...counts }, httpStatuses: { ...httpStatuses },
    expectedReasons: { ...expectedReasons }, backends: { ...backends }, sql: lastSql ?? null,
    activeFaults: overlaps(Date.now(), Date.now()).map(value => value.kind),
    resourceSamples: resources.length, unexpected: { ...errors } };
  const line = JSON.stringify(value);
  if (progressPath) await appendFile(progressPath, `${line}\n`, 'utf8');
  console.log(line);
}
async function reportLoop() {
  let next = Date.now() + 60000;
  while (sampling && !stopRequested) {
    await wait(Math.max(0, Math.min(500, next - Date.now()))).catch(() => {});
    if (!sampling || stopRequested || Date.now() < next) continue;
    const begin = Date.now();
    try {
      await resourceSnapshot();
      const summary = await lbPool(true);
      check(summary.settings.paused === 0 && summary.settings.idle_target === 0 && summary.settings.max_accounts === 32, 'soak_settings_drift');
      counts.managementSamples++;
    } catch (error) {
      const expectedHttp = /^soak_pool_http_(502|503|504)_expected_200$/.test(error?.message ?? '');
      if (overlaps(begin, Date.now()).length && (!error?.fixtureCheck || expectedHttp)) expected('fault_management_sample');
      else failure(safeFailure(error));
    }
    await progress(); next += 60000;
  }
}
async function verifyFinal() {
  await until('soak_final_ready', readiness, () => true, RECOVERY_TIMEOUT, true);
  await databaseGate(); mysqlReconnectAllowed = true;
  await until('soak_final_hold_drain', sqlState, row => Number(row.holds) === 0 && Number(row.catalog_holds) === 0, HOLD_DRAIN_TIMEOUT);
  // No retries: these are new final markers after a health gate, one per caller.
  for (const [index, caller] of callers.entries()) {
    const response = await send(caller, { path: PATHS[index % PATHS.length], mode: 'json' });
    check(response.classification === 'success', 'soak_final_normal_success');
    await verifyRepair(caller);
  }
  // Complete slow SSE on every protocol after both infrastructure faults recover.
  for (const path of PATHS) {
    const response = await send(callers[1], { path, mode: 'sse', delayMs: 2000 });
    check(response.classification === 'success', 'soak_final_slow_sse');
  }
  await until('soak_inactive_expiry', async () => { await observeSql(); return counts.expiredInactiveCallers; }, value => value === 1,
    Math.max(15000, Number(inactiveLease.expires_at) - Date.now() + 15000));
  await until('soak_final_hold_drain', sqlState, row => Number(row.holds) === 0 && Number(row.catalog_holds) === 0, HOLD_DRAIN_TIMEOUT);
  await observeSql();
  const fixture = await until('soak_mock_drain', mock,
    value => value.inference.filter(record => record.marker?.startsWith(prefix)).every(record => record.outcome !== 'pending'), 15000);
  check(fixture.fixture && fixture.inference.length < 10000, 'soak_mock_record_retention_bound');
  const initialSeq = new Set(initialMock.inference.map(value => value.seq));
  check(initialMock.inference.every(value => fixture.inference.some(record => record.seq === value.seq)), 'soak_mock_records_evicted');
  const records = new Map(); let backgroundWarmups = 0;
  for (const record of fixture.inference) {
    if (initialSeq.has(record.seq)) continue;
    if (record.marker === null) { backgroundWarmups++; check(initialMembers.has(record.identity), 'soak_unexpected_warmup_member'); continue; }
    const entry = issued.get(record.marker);
    check(entry, 'soak_unattributed_mock_inference');
    check(!records.has(record.marker), 'soak_duplicate_upstream_marker'); records.set(record.marker, record);
    const history = epochs.get(entry.caller) ?? [];
    const admitted = history.find(epoch => epoch.member === record.identity
      && epoch.assignedAt <= Number(record.startedAt) + 1000
      && (epoch.replacedAt === null || Number(record.startedAt) < epoch.replacedAt + 1000));
    check(admitted && (!entry.expectedMember || record.identity === entry.expectedMember), 'soak_upstream_member_outside_lease_epoch');
    check(record.path === entry.path, 'soak_upstream_protocol_mismatch');
    if (entry.classification === 'success') check(record.outcome === 'complete' && record.status === 200, 'soak_mock_success_mismatch');
    if (entry.classification === 'cancel' && !entry.faults.length) check(record.outcome === 'cancelled', 'soak_mock_cancel_not_propagated');
  }
  for (const [id, entry] of issued) {
    if (entry.requiredUpstream) check(records.has(id), 'soak_success_or_injected_request_missing_upstream');
    if (['cooling', 'repair'].includes(entry.classification)) check(!records.has(id), 'soak_denied_request_reached_upstream');
  }
  check(records.size <= counts.requests && counts.requests <= requestBudget && counts.requests <= MAX_REQUESTS, 'soak_final_request_bound');
  check(fixture.counters.scimCreates === 12 && fixture.users.length === 12 && fixture.seats.length === 12
    && fixture.counters.callbacksFailed === 0, 'soak_unplanned_provisioning_or_callback_failure');
  check(counts.planned401 === 1 && counts.recovered401 === 1, 'soak_401_recovery_not_exercised');
  check(counts.planned429 > 0 && counts.coolingProbes > 0 && counts.coolingBindingsChecked > 0, 'soak_429_binding_not_exercised');
  check(counts.cancellations > 0 && counts.slowSseSuccesses >= 3, 'soak_stream_cases_not_exercised');
  check(counts.expiredInactiveCallers === 1 && counts.observerSamples > 0, 'soak_expiry_or_sampler_not_exercised');
  check(faultWindows.length === 2 && faultWindows.every(value => value.end !== null), 'soak_fault_phases_incomplete');
  check(counts.survivingProxySuccesses > 0 && backends.proxy > 0 && backends.proxy2 > 0, 'soak_lb_failover_not_exercised');
  finalMockCounts = { baseline: initialMock.inference.length, uniqueClientMarkers: records.size,
    issuedClientMarkers: issued.size, notReachedUpstream: issued.size - records.size, backgroundWarmups,
    retainedRecords: fixture.inference.length, scimCreates: fixture.counters.scimCreates,
    taskPosts: fixture.counters.taskPosts, callbacksSucceeded: fixture.counters.callbacksSucceeded };
  await observeSql(); await resourceSnapshot();
}

try {
  options = parseOptions();
  check(process.env.POOL_MYSQL_SOAK_CONFIRM === PROJECT, 'explicit_soak_confirmation_required');
  started = Date.now(); hardDeadline = started + (options.seconds + 480) * 1000;
  watchdog = setTimeout(() => { failure('soak_wall_clock_bound'); stop('wall_clock_bound'); }, hardDeadline - Date.now());
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { failure('soak_interrupted'); stop('signal'); });
  reportDirectory = await mkdtemp(join(tmpdir(), 'ghcp-mysql-soak-'));
  progressPath = join(reportDirectory, 'progress.jsonl');
  await initialize(); await resourceSnapshot(); await progress();
  trafficStarted = Date.now(); trafficEnd = trafficStarted + options.seconds * 1000;
  sampling = true; sampler = sampleLoop(); reporter = reportLoop();
  // Object installed before the async task can finish, including on interruption.
  faultTask = { done: false, promise: undefined }; faultTask.promise = injectFaults();
  workerTasks = Array.from({ length: options.concurrency }, (_, index) => worker(index));
  await Promise.all([...workerTasks, faultTask.promise]); trafficStopped = Date.now();
  sampling = false; await Promise.all([sampler, reporter]);
  check(!stopRequested, 'soak_stopped_before_final_verification');
  await verifyFinal(); check(counts.unexpectedErrors === 0, 'soak_unexpected_errors');
  completed = true;
} catch (error) {
  failure(safeFailure(error)); process.exitCode = 1;
} finally {
  sampling = false; stopRequested = true; shutdown.abort();
  for (const controller of activeControllers) controller.abort();
  // Restore the disposable fixture even on interruption, observer failure or a
  // failed control response (the operation may have happened before transport died).
  if (fixtureConfirmed) {
    try { await control('unpause-mysql'); mysqlMayBePaused = false; }
    catch (error) { failure(safeFailure(error)); }
    if (proxyMayBeStopped) try { await control('start-proxy'); proxyMayBeStopped = false; }
    catch (error) { failure(safeFailure(error)); }
  }
  await Promise.allSettled([...workerTasks, sampler, reporter, faultTask?.promise].filter(Boolean));
  await sqlQueue; observer?.destroy(); observer = undefined;
  clearTimeout(watchdog);
  const report = { fixture: PROJECT, node: process.version, passed: completed && counts.unexpectedErrors === 0,
    environment: 'isolated two-proxy MySQL/mock HAProxy fixture; not production capacity',
    requestedSeconds: options?.seconds, observedTrafficSeconds: trafficStarted ? Math.round(((trafficStopped || Date.now()) - trafficStarted) / 1000) : 0,
    diagnosticShortRun: (options?.seconds ?? 0) < 1800, concurrency: options?.concurrency,
    requestHardMaximum: MAX_REQUESTS, admittedRequestBudget: requestBudget, stopReason, elapsedMs: elapsed(),
    counts, httpStatuses, expectedReasons, backends, phases,
    faults: faultWindows.map(value => ({ kind: value.kind, startMs: value.start - started,
      endMs: value.end === null ? null : value.end - started,
      recoveryUntilMs: value.recoveryUntil === undefined ? null : value.recoveryUntil - started,
      durationMs: value.end === null ? null : value.end - value.start })),
    latency: Object.fromEntries([...latency].map(([key, values]) => [key, distribution(values)])),
    mockComparison: finalMockCounts ?? null, finalSql: lastSql ?? null, resourceSamples: resources,
    resourceDrift: resourceDrift(), arbitraryLatencyOrResourceSloAsserted: false,
    errors, errorExamples, restoration: { proxyMayBeStopped, mysqlMayBePaused } };
  if (!report.passed) process.exitCode = 1;
  try {
    await progress(true);
    if (reportDirectory) {
      await writeFile(join(reportDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(JSON.stringify({ type: 'report_location', directory: reportDirectory }));
    }
  } catch { process.exitCode = 1; report.passed = false; report.reportWriteFailed = true; }
  console.log(JSON.stringify(report));
}
