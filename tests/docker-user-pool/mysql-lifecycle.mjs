// Node 22+, repository mysql2. Test-only, fixed disposable fixture, no .env.
// POOL_MYSQL_LIFECYCLE_CONFIRM=ghcp-user-pool-mysql-test node tests/docker-user-pool/mysql-lifecycle.mjs
// No arguments/target overrides, Docker/cloud control, Ready seeding, SQL writes,
// global /test/control, deletes, resets, or inference retries. Start the two real
// Proxy replicas, real SSO/MySQL and mock external services separately. An EMPTY
// compose.mysql fixture (optionally compose.provision-load) is required.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT, auth, urls, MODEL, hash, check, safeFailure, sleep, status,
  inferOptions, successful, invariants, connectDatabase } from './mysql-smoke.mjs';

const CAP = 32, TARGET = 8, KEEP = 6;
const RUN_MS = 550000, HTTP_LIMIT = 940, CLEANUP_LIMIT = 16, INFERENCE_LIMIT = 400;
const SERVICES = ['proxy', 'proxy2'];
const COUNTERS = ['scimCreates', 'scimConflicts', 'scimUpdates', 'scimDeletes',
  'seatAssignments', 'taskPosts', 'callbacksSucceeded', 'callbacksFailed', 'modelLists'];
const report = { version: 1, fixture: PROJECT, kind: 'mysql_mock_lifecycle', passed: false,
  scope: 'Actual HTTP to two Proxy replicas, real SSO and SELECT-only MySQL observer; mock SCIM, seats, OAuth completion and inference. Not a live GitHub or capacity test.',
  limits: { wallMs: 600000, normalHttp: HTTP_LIMIT, cleanupHttp: CLEANUP_LIMIT, inference: INFERENCE_LIMIT, members: CAP },
  requestCounting: 'Runner-issued HTTP only, including observations; inference is a subset. Worker-to-service requests are verified by fixture counters, not charged to this client budget.',
  phases: [], refillBursts: [], requests: { http: 0, cleanupHttp: 0, inference: 0, successful: 0, expectedFailures: 0 },
  cleanup: { eligible: false, frozen: false, destructiveActions: 0 }, maxima: { members: 0, holds: 0, provisioning: 0 } };
const shutdown = new AbortController();
const callers = Array.from({ length: CAP }, (_, n) => `sha256:${hash(`mysql-lifecycle-caller-${n}`)}`);
const outsider = `sha256:${hash('mysql-lifecycle-exhausted-caller')}`;
// Raw identity, task, lease and caller values NEVER enter report/logs.
const bindings = new Map(), historicalBindings = new Set(), markers = new Map();
const persistent = new Map(), heldControllers = new Set();
let db, reportDirectory, phase, started = 0, deadline = 0, watchdog, emergency;
let writable = false, expectedSettings, initialOwner, lastState, markerSequence = 0;
let traffic, trafficStop = true, trafficError, trafficIndex = 0, trafficRequests = 0;
let allowFailed = false, allowDisabled = false;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const bindingKey = row => JSON.stringify([row.caller_id, row.member_identity, row.lease_id]);
function running() {
  if (trafficError) throw trafficError;
  check(!shutdown.signal.aborted && Date.now() < deadline, 'lifecycle_interrupted_or_deadline');
}
function startPhase(label) {
  if (phase) { phase.passed = true; phase.wallMs = Date.now() - phase.startedAt; delete phase.startedAt; }
  phase = { label, passed: false, startedAt: Date.now(), successful: 0, expectedFailures: {}, checks: [] };
  report.phases.push(phase);
  console.log(`PHASE mysql_lifecycle ${label}`);
}
function expectedFailure(result, httpStatus, code, label, owner = phase) {
  status(result, httpStatus, label);
  if (code) check(result.data?.error?.code === code, `${label}_error_code`);
  owner.expectedFailures[label] = (owner.expectedFailures[label] ?? 0) + 1;
  report.requests.expectedFailures++;
}
// All HTTP is fixed-origin, redirect-refusing, timed, streamed with a byte bound,
// and charged to a hard budget (including health, observations and cleanup).
async function open(service, path, { method = 'GET', body, headers = auth, timeout = 12000,
  signal, cleanup = false } = {}) {
  check(Object.hasOwn(urls, service) && path.startsWith('/') && !path.startsWith('//'), 'invalid_fixture_target');
  if (!cleanup) { running(); check(report.requests.http < HTTP_LIMIT, 'lifecycle_http_budget'); report.requests.http++; }
  else { check(report.requests.cleanupHttp < CLEANUP_LIMIT, 'lifecycle_cleanup_budget'); report.requests.cleanupHttp++; }
  const signals = [AbortSignal.timeout(timeout), ...(cleanup ? [] : [shutdown.signal]), ...(signal ? [signal] : [])];
  return fetch(urls[service] + path, { method, redirect: 'error',
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any(signals) });
}
async function request(service, path, options = {}) {
  const response = await open(service, path, options);
  const parts = [], reader = response.body?.getReader(); let bytes = 0;
  if (reader) try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; check(bytes <= (options.maxBytes ?? 256 * 1024), 'lifecycle_response_size_bound');
      parts.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  const text = Buffer.concat(parts).toString('utf8'); let data;
  try { data = JSON.parse(text); } catch { /* successful() also validates actual SSE. */ }
  return { status: response.status, headers: response.headers, text, data };
}
const get = async (service, path, options) => status(await request(service, path, options), 200, 'fixture_read').data;
const summary = (service = 'proxy2', options) => get(service, '/api/user-pool/summary', options);
async function change(changes, service = 'proxy2', options = {}) {
  const before = await summary(service, options);
  const next = status(await request(service, '/api/user-pool/settings', { ...options, method: 'PATCH',
    body: { expectedVersion: before.settings.version, changes } }), 200, 'lifecycle_settings').data;
  check(next.version === before.settings.version + 1 && Object.entries(changes).every(([k, v]) => next[k] === v), 'settings_not_applied');
  expectedSettings = next;
  return next;
}
async function select(sql, values = []) {
  running();
  check(/^SELECT\s/i.test(sql) && !/;|\b(?:OUTFILE|DUMPFILE|FOR\s+UPDATE|GET_LOCK|RELEASE_LOCK|SLEEP)\b/i.test(sql), 'observer_select_only');
  let timer;
  try {
    return (await Promise.race([db.query({ sql, values, timeout: 6000 }), new Promise((_, reject) => {
      timer = setTimeout(() => { db.destroy(); reject(Object.assign(new Error('observer_timeout'), { fixtureCheck: true })); }, 7000);
    })]))[0];
  } finally { clearTimeout(timer); }
}
async function sqlState() {
  const [row] = await select(`SELECT
    (SELECT COUNT(*) FROM user_pool_settings) settings_rows,
    (SELECT SHA2(owner,256) FROM user_pool_settings WHERE id=1) owner_hash,
    (SELECT owner_until FROM user_pool_settings WHERE id=1) owner_until,
    TIMESTAMPDIFF(MICROSECOND,'1970-01-01',UTC_TIMESTAMP(3)) DIV 1000 now_ms,
    (SELECT next_ordinal FROM user_pool_settings WHERE id=1) next_ordinal,
    (SELECT COUNT(*) FROM proxy_accounts) accounts,
    (SELECT COUNT(*) FROM user_pool_accounts) members,
    (SELECT COUNT(*) FROM user_pool_accounts WHERE state='ready' AND stage='ready' AND verified_at>0) ready,
    (SELECT COUNT(*) FROM user_pool_accounts WHERE state='failed') failed,
    (SELECT COUNT(*) FROM user_pool_accounts WHERE state='disabled') disabled,
    (SELECT COUNT(*) FROM user_pool_accounts WHERE state='cooling') cooling,
    (SELECT COUNT(*) FROM user_pool_accounts WHERE state='provisioning') provisioning,
    (SELECT COUNT(*) FROM user_pool_leases) leases,
    (SELECT COUNT(DISTINCT caller_id) FROM user_pool_leases) callers,
    (SELECT COUNT(DISTINCT member_identity) FROM user_pool_leases) leased_members,
    (SELECT COUNT(*) FROM user_pool_holds) holds,
    (SELECT COUNT(*) FROM user_pool_catalog_holds) catalog_holds,
    (SELECT COUNT(*) FROM user_pool_catalog_cooldowns) catalog_cooldowns,
    (SELECT COUNT(*) FROM proxy_identity_initializations) initializations,
    (SELECT COUNT(*) FROM proxy_request_stats) stats,
    (SELECT COUNT(*) FROM user_pool_events) events,
    (SELECT COUNT(*) FROM user_pool_events WHERE action='provision_failed') provision_failures,
    (SELECT COUNT(*) FROM user_pool_events WHERE action='oauth_reauth_scheduled') reauth_scheduled,
    (SELECT COUNT(*) FROM user_pool_events WHERE action='oauth_reauth_blocked') reauth_blocked,
    (SELECT COUNT(*) FROM user_pool_holds h LEFT JOIN user_pool_leases l ON l.lease_id=h.lease_id WHERE l.lease_id IS NULL) orphan_holds,
    (SELECT COUNT(*) FROM user_pool_holds WHERE expires_at<deadline_at OR expires_at-deadline_at<>10000) invalid_hold_deadlines,
    (SELECT COUNT(*) FROM user_pool_catalog_holds WHERE expires_at<deadline_at OR expires_at-deadline_at<>10000) invalid_catalog_deadlines,
    (SELECT COUNT(*) FROM schema_migrations WHERE id='2026-09-12-user-pool-mysql-v1') pool_migrations`);
  for (const key of Object.keys(row)) if (key !== 'owner_hash') { row[key] = Number(row[key]); check(integer(row[key]), 'invalid_sql_count'); }
  invariants(row);
  check(row.invalid_catalog_deadlines === 0 && row.members <= CAP && row.accounts === row.members && row.next_ordinal === row.members, 'inventory_or_catalog_invariant');
  check(row.owner_hash && row.owner_until > row.now_ms && (!initialOwner || row.owner_hash === initialOwner), 'single_live_scheduler_owner');
  check(row.provision_failures === 0 && row.reauth_blocked === 0 && row.cooling === 0, 'unexpected_worker_failure');
  check((allowFailed || row.failed === 0) && (allowDisabled || row.disabled === 0), 'unexpected_member_state');
  report.maxima.members = Math.max(report.maxima.members, row.members);
  report.maxima.holds = Math.max(report.maxima.holds, row.holds);
  report.maxima.provisioning = Math.max(report.maxima.provisioning, row.provisioning);
  lastState = row;
  return row;
}
async function leaseRows() {
  const rows = await select('SELECT caller_id, member_identity, lease_id, phase, last_success_at, expires_at FROM user_pool_leases');
  for (const [caller, old] of persistent) {
    const row = rows.find(item => item.caller_id === caller);
    check(row && bindingKey(row) === bindingKey(old) && row.phase === 'active', 'six_persistent_callers_rotated_or_lost');
  }
  return rows;
}
async function expiredWithoutRenewal(oldRows, fence) {
  const events = await select(`SELECT action, identity member_identity, caller_id, lease_id FROM user_pool_events
    WHERE id>? AND lease_id IN (${oldRows.map(() => '?').join(',')}) AND action IN ('lease_renewed','lease_expired')`,
  [fence.id, ...oldRows.map(row => row.lease_id)]);
  check(events.length === oldRows.length && oldRows.every(old => events.some(event => event.action === 'lease_expired'
    && bindingKey(event) === bindingKey(old))), 'failed_leases_not_expired_once_without_renewal');
}
function counts(value) {
  check(value?.fixture === true && value.nextControl === null, 'mock_or_global_control_invalid');
  check(value.counts && ['users', 'seats', 'tasks', 'inference', 'otherInference'].every(k => integer(value.counts[k]))
    && value.counters && COUNTERS.every(k => integer(value.counters[k])), 'mock_counts_contract');
  check(value.counts.users <= CAP && value.counts.seats <= CAP && value.counters.scimCreates <= CAP
    && value.counters.seatAssignments <= CAP && value.counts.otherInference === 0, 'mock_cap_or_unexpected_provider');
  check(['scimConflicts', 'scimUpdates', 'scimDeletes', 'callbacksFailed'].every(k => value.counters[k] === 0), 'unexpected_external_side_effect');
  if (value.loginQueue) check(value.loginQueue.failed === 0 && value.loginQueue.active <= value.loginQueue.concurrency
    && value.loginQueue.peakActive <= value.loginQueue.concurrency && value.loginQueue.active + value.loginQueue.pending <= 5, 'login_queue_bound');
  return value;
}
async function observe() {
  const [sql, sum, mock] = await Promise.all([sqlState(), summary(), get('mock', '/test/counts')]);
  counts(mock);
  check(sum.enabled === true && ['total', 'ready_idle', 'leased', 'provisional', 'provisioning', 'failed', 'disabled', 'cooling']
    .every(k => integer(sum.counts?.[k])), 'pool_summary_contract');
  check(sum.counts.total <= CAP && (!expectedSettings || JSON.stringify(sum.settings) === JSON.stringify(expectedSettings)), 'settings_or_cap_changed');
  await leaseRows();
  return { sql, sum, mock };
}
async function until(label, read, predicate, timeout = 90000, interval = 1800) {
  const end = Math.min(deadline, Date.now() + timeout);
  do { running(); const result = await read(); if (predicate(result)) return result; await sleep(interval); } while (Date.now() < end);
  check(false, `${label}_timeout`);
}
async function drain() {
  return until('hold_drain', sqlState, row => row.holds === 0 && row.catalog_holds === 0, 15000, 250);
}
async function settled(total, leases) {
  return until('verified_ready', observe, value => value.sql.members === total && value.sql.ready === total
    && value.sql.provisioning === 0 && value.sql.leases === leases && value.sum.counts.total === total
    && value.sum.counts.ready_idle === total - leases && value.sum.counts.provisioning === 0
    && value.mock.counters.callbacksSucceeded === value.mock.counters.taskPosts
    && (!value.mock.loginQueue || value.mock.loginQueue.active === 0 && value.mock.loginQueue.pending === 0));
}
async function identityStillSame(oldRows) {
  const rows = await inventory();
  check(rows.length === oldRows.length && rows.every((row, n) => row.identity === oldRows[n].identity
    && row.sso_created_at === oldRows[n].sso_created_at && row.sso_user === oldRows[n].sso_user
    && row.gh_login === oldRows[n].gh_login), 'existing_members_replaced_or_relinked');
}
async function bind(caller) {
  const row = await until('active_binding', leaseRows, rows => rows.some(item => item.caller_id === caller && item.phase === 'active'), 6000, 100);
  const found = row.find(item => item.caller_id === caller);
  const old = bindings.get(caller);
  check(!old || bindingKey(old) === bindingKey(found), 'caller_binding_rotated');
  bindings.set(caller, found); historicalBindings.add(bindingKey(found));
  return found;
}
function mark(caller, control, owner) {
  check(report.requests.inference < INFERENCE_LIMIT, 'lifecycle_inference_budget'); report.requests.inference++;
  const id = `lifecycle-${++markerSequence}`;
  const record = { caller, identity: bindings.get(caller)?.member_identity, status: control.status ?? 200,
    outcome: control.streamMode === 'hold' ? 'cancelled' : control.status ? 'http_error' : 'complete', owner };
  markers.set(id, record);
  return { id, record };
}
async function infer(caller, { service = 'proxy2', control = {}, expected = 200, code, label = 'inference',
  path = '/v1/messages', stream = false, owner = phase } = {}) {
  const { id, record } = mark(caller, control, owner);
  if (expected !== 200 && !control.status) record.absent = true; // Admission failure must never reach upstream.
  const result = await request(service, path, { ...inferOptions(caller, path, `POOL_TEST:${JSON.stringify({ id, ...control })}`, stream), timeout: 35000 });
  if (expected === 200) {
    successful(result, path, stream);
    owner.successful++; report.requests.successful++;
    if (!bindings.has(caller)) record.identity = (await bind(caller)).member_identity;
  } else expectedFailure(result, expected, code, label, owner);
  return result;
}
async function admit(indices) {
  await Promise.all(indices.map((n, index) => infer(callers[n], { service: SERVICES[index % 2] })));
  await leaseRows();
}
async function canaries() {
  // Same six real authenticated callers on both replicas; no unmarked inference.
  await Promise.all([0, 1].map(n => infer(callers[n], { service: SERVICES[n] })));
}
function startTraffic() {
  check(!traffic, 'traffic_already_running'); trafficStop = false;
  traffic = (async () => {
    while (!trafficStop && !shutdown.signal.aborted) {
      check(trafficRequests < 180, 'ongoing_traffic_budget');
      const n = trafficIndex++ % KEEP; trafficRequests++;
      await infer(callers[n], { service: SERVICES[Math.floor(trafficIndex / KEEP) % 2] });
      await sleep(1800);
    }
  })().catch(error => { trafficError = error; });
}
async function stopTraffic() {
  trafficStop = true; await traffic; traffic = undefined;
  if (trafficError) throw trafficError;
}
function noNewObjects(before, after) {
  check(['users', 'seats'].every(k => before.counts[k] === after.counts[k])
    && ['scimCreates', 'seatAssignments', 'scimUpdates', 'scimDeletes', 'scimConflicts'].every(k => before.counters[k] === after.counters[k]), 'repair_or_pause_created_external_objects');
}
async function noGrowth(total, leaseCount, rounds = 3) {
  const before = counts(await get('mock', '/test/counts')), beforeMembers = await inventory();
  for (let n = 0; n < rounds; n++) {
    await canaries(); await sleep(1800);
    const value = await observe();
    check(value.sql.members === total && value.sql.ready === total && value.sql.leases === leaseCount
      && value.sql.provisioning === 0, 'pause_shrink_or_cap_changed_inventory');
    noNewObjects(before, value.mock);
    check(value.mock.counters.taskPosts === before.counters.taskPosts, 'pause_shrink_or_cap_started_login');
  }
  await identityStillSame(beforeMembers);
}
async function refill(label, totalBefore, totalAfter, leaseCount) {
  startPhase(label);
  const before = counts(await get('mock', '/test/counts'));
  const [fence] = await select('SELECT COALESCE(MAX(id),0) id FROM user_pool_events');
  const firstMarker = markerSequence + 1;
  await change({ idle_target: TARGET, max_accounts: CAP, paused: 0 });
  let observedProvisioning = 0, concurrentSuccesses = 0, completionSamplesWithProvisioning = 0, nextObservation = 0;
  // SQL-only fast sampling catches short real-worker bursts without spending
  // hundreds of HTTP polls. Start canaries as soon as reservation is observed,
  // not after a slower summary/mock read. Full observations remain periodic.
  await until('refill', async () => {
    const sql = await sqlState();
    if (sql.provisioning > 0 && sql.members > totalBefore) {
      observedProvisioning++;
      if (concurrentSuccesses < 12) {
        await canaries(); concurrentSuccesses += 2;
        // This brackets completed HTTP with real SQL state without comparing
        // cloud host clocks. Provisioning must still be present afterwards.
        const afterRequests = await sqlState();
        if (afterRequests.provisioning > 0) completionSamplesWithProvisioning++;
      }
    }
    if (Date.now() >= nextObservation) { await observe(); nextObservation = Date.now() + 1800; }
    return sql;
  }, sql => sql.ready === totalAfter && sql.members === totalAfter && sql.provisioning === 0, 90000, 100);
  await change({ paused: 1 }); await settled(totalAfter, leaseCount);
  const after = counts(await get('mock', '/test/counts'));
  check(observedProvisioning > 0 && concurrentSuccesses >= 2 && completionSamplesWithProvisioning > 0, 'refill_lacked_concurrent_successful_requests');
  check(['scimCreates', 'seatAssignments', 'taskPosts', 'callbacksSucceeded'].every(k => after.counters[k] - before.counters[k] === totalAfter - totalBefore), 'refill_side_effect_count');
  const burst = { label, added: totalAfter - totalBefore, observedProvisioning, concurrentSuccesses, completionSamplesWithProvisioning };
  const windows = await select(`SELECT r.identity, MIN(r.at) reserved_at, MIN(a.at) ready_at
    FROM user_pool_events r JOIN user_pool_events a ON a.identity=r.identity AND a.action='account_ready' AND a.id>r.id
    JOIN user_pool_accounts p ON p.identity=r.identity
    WHERE r.action='name_reserved' AND r.id>? AND p.ordinal>=? AND p.ordinal<? GROUP BY r.identity`, [fence.id, totalBefore, totalAfter]);
  check(windows.length === totalAfter - totalBefore && windows.every(row => Number(row.ready_at) >= Number(row.reserved_at)), 'refill_worker_event_windows');
  check(markerSequence >= firstMarker + 1, 'refill_canary_markers_missing');
  report.refillBursts.push(burst);
  phase.checks.push('new_members_via_real_workers_while_existing_callers_succeed', 'six_bindings_preserved');
}
async function release(indices) {
  // Only our disposable nonpersistent callers, after SQL holds drain. The six
  // protected callers retain their post-repair epochs at successful completion.
  await drain();
  for (const n of indices) {
    check(n >= KEEP && bindings.has(callers[n]), 'release_scope');
    const row = bindings.get(callers[n]);
    const result = status(await request(SERVICES[n % 2], `/api/user-pool/leases/${encodeURIComponent(row.lease_id)}/release`,
      { method: 'POST', body: { confirm: true } }), 200, 'lease_release');
    check(result.data?.released === true, 'release_not_confirmed');
    bindings.delete(callers[n]);
  }
  const rows = await leaseRows();
  check(indices.every(n => !rows.some(row => row.caller_id === callers[n])), 'released_leases_remain');
  phase.releasedLeases = (phase.releasedLeases ?? 0) + indices.length;
}
async function heldRelease(n) {
  check(n >= KEEP && bindings.has(callers[n]), 'hold_scope');
  const controller = new AbortController(); heldControllers.add(controller);
  const owner = phase, { id, record } = mark(callers[n], { streamMode: 'hold' }, owner);
  const row = bindings.get(callers[n]); let response;
  try {
    response = await open('proxy2', '/responses', { ...inferOptions(callers[n], '/responses',
      `POOL_TEST:${JSON.stringify({ id, streamMode: 'hold' })}`, true), timeout: 15000, signal: controller.signal });
    check(response.status === 200 && response.headers.get('content-type')?.includes('text/event-stream'), 'held_stream_start');
    await until('persisted_hold', () => select('SELECT COUNT(*) n FROM user_pool_holds WHERE lease_id=?', [row.lease_id]), rows => Number(rows[0].n) > 0, 5000, 100);
    expectedFailure(await request('proxy', `/api/user-pool/leases/${encodeURIComponent(row.lease_id)}/release`,
      { method: 'POST', body: { confirm: true } }), 409, 'lease_in_use', 'held_cross_replica_release');
  } finally { controller.abort(); await response?.body?.cancel().catch(() => {}); heldControllers.delete(controller); }
  await drain();
  record.identity = row.member_identity;
  phase.checks.push('held_release_refused_before_cancellation_and_sql_drain');
}
async function action(identity, operation, expected = 200, code) {
  check(['disable', 'resume', 'retry'].includes(operation), 'unsupported_member_action');
  const result = await request('proxy2', `/api/user-pool/accounts/${encodeURIComponent(identity)}/${operation}`, { method: 'POST', body: {} });
  if (expected === 200) { status(result, 200, 'member_action'); check(result.data?.accepted === true, 'member_action_not_accepted'); }
  else expectedFailure(result, expected, code, 'retry_disabled_rejected');
}
async function inventory() {
  const rows = await select(`SELECT p.identity, p.ordinal, p.state, p.stage, p.verified_at, p.sso_created_at,
    p.task_id, p.attempts, p.last_error, p.reauth_count, a.sso_user, a.gh_login,
    (a.copilot_oauth_status='valid' AND LENGTH(a.copilot_oauth_token)>0 AND a.copilot_oauth_attempt_id IS NULL) credential_valid
    FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity ORDER BY p.ordinal`);
  return rows;
}
async function fresh() {
  startPhase('preflight_empty_fixed_fixture');
  // Same real manifests/auth/readiness contracts as mysql-smoke, through this
  // runner's bounded transport so a hung preflight cannot outlive the budget.
  for (const service of Object.keys(urls)) {
    const value = await get(service, '/__mysql/manifest', { headers: {} });
    check(value.fixture === true && value.project === PROJECT && value.database === 'ghcp_pool_mysql_test'
      && value.service === service && value.mysqlPort === 33184, 'wrong_fixture_manifest');
    await get(service, '/healthz', { headers: {} });
    if (SERVICES.includes(service)) check((await get(service, '/readyz', { headers: {} })).storage === 'mysql', 'not_mysql_proxy');
  }
  check((await get('mock', '/healthz', { headers: {} })).fixture === true, 'not_mock_fixture');
  for (const service of ['sso', 'login']) await get('mock', `/__mysql/${service}/healthz`, { headers: {} });
  // connectDatabase('observer') is the existing fixed pool_observer SELECT-only
  // account and verifies fixture_identity; never use its privileged load role.
  let connectTimer, abandoned = false;
  const connection = connectDatabase('observer').then(value => { if (abandoned) { value.destroy(); throw new Error('late_connection'); } return value; });
  try { db = await Promise.race([connection, new Promise((_, reject) => { connectTimer = setTimeout(() => { abandoned = true; reject(new Error('connect_timeout')); }, 8000); })]); }
  finally { clearTimeout(connectTimer); }
  const [a, b, sql, mock, sso, login, adapter] = await Promise.all([summary('proxy'), summary(), sqlState(),
    get('mock', '/test/counts'), get('mock', '/__mysql/sso/api/users?page=1&pageSize=1'),
    get('mock', '/__mysql/login/api/tasks?page=1&pageSize=1'), get('mock', '/__mysql/load-state')]);
  counts(mock);
  check(a.enabled && b.enabled && a.counts.total === 0 && b.counts.total === 0 && a.settings.idle_target === 0
    && b.settings.idle_target === 0 && JSON.stringify(a.settings) === JSON.stringify(b.settings), 'fresh_zero_target_pool_required');
  check(['accounts', 'members', 'leases', 'holds', 'catalog_holds', 'catalog_cooldowns', 'initializations', 'stats', 'events', 'next_ordinal']
    .every(k => sql[k] === 0), 'fresh_empty_database_required');
  check(sso.total === 0 && login.total === 0 && Object.values(mock.counts).every(n => n === 0)
    && COUNTERS.every(k => mock.counters[k] === 0), 'fresh_empty_sources_required');
  check(!mock.loginQueue || ['active', 'pending', 'accepted', 'finished', 'failed', 'peakActive'].every(k => mock.loginQueue[k] === 0), 'fresh_login_queue_required');
  check(adapter.fixture === true && adapter.registered === 0 && adapter.requests === 0 && adapter.active === 0
    && adapter.modelLists === 0, 'ready_seed_adapter_forbidden');
  for (const service of SERVICES) expectedFailure(await request(service, '/api/user-pool/summary', { headers: {} }), 401, null, 'internal_auth_required');
  expectedFailure(await request('mock', '/test/counts', { headers: {} }), 401, null, 'mock_auth_required');
  initialOwner = sql.owner_hash;
  // Refuse all writes INCLUDING cleanup on wrong/nonempty/unconfirmed fixtures.
  writable = true; report.cleanup.eligible = true;
  const configured = await change({ idle_target: TARGET, max_accounts: CAP, paused: 1, lease_seconds: 600 });
  expectedFailure(await request('proxy', '/api/user-pool/settings', { method: 'PATCH',
    body: { expectedVersion: configured.version - 1, changes: { paused: 0 } } }), 409, 'settings_version_conflict', 'stale_cross_replica_cas');
  expectedFailure(await request('proxy', '/api/user-pool/settings', { method: 'PATCH',
    body: { expectedVersion: configured.version, changes: { max_accounts: TARGET - 1 } } }), 400, 'invalid_pool_settings', 'cap_below_target_rejected');
  check(JSON.stringify((await summary()).settings) === JSON.stringify(configured), 'rejected_settings_mutated_state');
  phase.checks.push('fixed_manifests_real_mysql_empty_sso_login_mock_database', 'no_ready_seed', 'auth_and_cas_validation');
}
async function lifecycle() {
  startPhase('initial_worker_warmup_eight');
  await change({ paused: 0 }); await settled(TARGET, 0); await change({ paused: 1 });
  const initial = counts(await get('mock', '/test/counts'));
  check(['scimCreates', 'seatAssignments', 'taskPosts', 'callbacksSucceeded'].every(k => initial.counters[k] === TARGET), 'initial_provision_chain');
  await admit([0, 1, 2, 3, 4, 5]);
  for (const caller of callers.slice(0, KEEP)) persistent.set(caller, bindings.get(caller));
  // Existing canary helper validates canonical JSON and SSE on every protocol.
  for (const [n, path] of ['/v1/messages', '/chat/completions', '/responses'].entries()) {
    for (const stream of [false, true]) await infer(callers[n], { service: SERVICES[Number(stream)], path, stream });
  }
  const catalog = await get('proxy2', '/v1/models', { headers: inferOptions(callers[0], '', '').headers });
  check(catalog.data.some(row => row.id === MODEL), 'catalog_canonical_model');
  check((await drain()).leases === KEEP, 'catalog_created_extra_lease');
  phase.checks.push('six_exclusive_active_callers', 'three_protocol_json_sse_canaries');
  startTraffic();

  await refill('refill_one_under_traffic', 8, 14, 6);
  await admit([6, 7, 8, 9, 10, 11]);
  await refill('refill_two_under_traffic', 14, 20, 12);
  await admit([12, 13, 14, 15, 16, 17]);
  await refill('refill_three_under_traffic', 20, 26, 18);

  startPhase('pause_shrink_below_inventory_and_release');
  await change({ paused: 1, idle_target: 2, max_accounts: 12 });
  await noGrowth(26, 18, 2);
  // Production validates cap >= target, NOT cap >= existing inventory. Lowering
  // the cap only stops new reservations; it never deletes existing members.
  await change({ paused: 0 }); await noGrowth(26, 18, 3); await change({ paused: 1 });
  await heldRelease(6); await release([6, 7, 8, 9, 10, 11]);
  await settled(26, 12); await admit([6, 7, 8, 9, 10, 11]);
  phase.checks.push('cap_twelve_below_twenty_six_inventory_is_nondestructive', 'target_two_preserves_six_callers', 'released_idle_members_reused');

  startPhase('resume_expand_and_drain_eight');
  await change({ idle_target: TARGET, max_accounts: CAP, paused: 1 });
  await admit([18, 19, 20, 21, 22, 23, 24, 25]);
  await refill('refill_four_reaches_cap', 26, 32, 26);
  startPhase('cap_exhaustion_without_rotation');
  await admit([26, 27, 28, 29, 30, 31]);
  await change({ paused: 0 }); await noGrowth(CAP, CAP, 3); await change({ paused: 1 });
  for (const service of SERVICES) {
    const result = await infer(outsider, { service, expected: 429, code: 'pool_exhausted', label: 'cap_exhausted' });
    check(Number(result.headers.get('retry-after')) > 0, 'exhaustion_retry_after');
  }
  phase.checks.push('all_thirty_two_exclusively_leased', 'cap_blocks_reservations_and_extra_caller_upstream');

  startPhase('safe_idle_disable_resume_and_failed_retry');
  const chosen = bindings.get(callers[31]).member_identity;
  await release([31]); allowDisabled = true;
  const before = counts(await get('mock', '/test/counts'));
  await action(chosen, 'disable');
  let row = (await inventory()).find(item => item.identity === chosen);
  check(row?.state === 'disabled' && row.stage === 'ready' && row.attempts === 0 && row.last_error === null, 'disable_not_safe_idle_ready');
  await action(chosen, 'retry', 409, 'invalid_member_state');
  await action(chosen, 'resume');
  row = (await inventory()).find(item => item.identity === chosen);
  check(row?.state === 'provisioning' && row.stage === 'warmup' && row.verified_at === null, 'resume_must_revalidate_not_seed_ready');
  allowDisabled = false;
  await change({ paused: 0 }); await settled(CAP, CAP - 1); await change({ paused: 1 });
  let after = counts(await get('mock', '/test/counts')); noNewObjects(before, after);
  check(after.counters.taskPosts === before.counters.taskPosts, 'resume_unnecessarily_reauthorized');
  await admit([31]); check(bindings.get(callers[31]).member_identity === chosen, 'idle_resume_changed_member');
  const retryLeases = await leaseRows(), retryMembers = await inventory();
  const retryLease = bindings.get(callers[31]);
  const [retryFence] = await select('SELECT COALESCE(MAX(id),0) id FROM user_pool_events');
  allowFailed = true;
  await infer(callers[31], { control: { status: 401 }, expected: 401, label: 'retry_setup_existing_member_401' });
  await drain();
  row = (await inventory()).find(item => item.identity === chosen);
  check(row?.state === 'failed' && row.stage === 'synced' && row.last_error === 'upstream_unauthorized'
    && row.attempts === 0 && row.reauth_count === 1, 'manual_retry_not_safe_known_failure');
  const afterFailure = await leaseRows();
  check(afterFailure.length === CAP - 1 && !afterFailure.some(item => item.caller_id === callers[31]
    || item.lease_id === retryLease.lease_id) && retryLeases.filter(old => old.caller_id !== callers[31])
    .every(old => afterFailure.some(item => bindingKey(item) === bindingKey(old) && item.phase === 'active')), 'manual_401_must_expire_only_failed_lease');
  await expiredWithoutRenewal([retryLease], retryFence);
  bindings.delete(callers[31]);
  await infer(callers[31], { service: 'proxy', expected: 429, code: 'pool_exhausted', label: 'failed_member_no_ready_capacity' });
  // The failed request's final hold drained and expired this nonpersistent
  // lease, even while paused. Retry the inventory member, not a stale lease
  // release (which would be 404). Keep all other caller bindings protected.
  await action(chosen, 'retry');
  await change({ paused: 0 }); await settled(CAP, CAP - 1); await change({ paused: 1 });
  allowFailed = false;
  await identityStillSame(retryMembers);
  after = counts(await get('mock', '/test/counts')); noNewObjects(before, after);
  check(after.counters.taskPosts === before.counters.taskPosts + 1 && after.counters.callbacksSucceeded === after.counters.taskPosts, 'manual_retry_chain');
  await admit([31]);
  check(bindings.get(callers[31]).member_identity === chosen && bindings.get(callers[31]).lease_id !== retryLease.lease_id, 'manual_retry_requires_new_lease_epoch');
  phase.checks.push('idle_disable_resume_reverifies_credentials_without_login', 'known_failed_synced_retry_after_lease_expiry',
    'failed_caller_exhausted_without_upstream_then_new_lease_epoch', 'no_new_scim_seats_users');

  await stopTraffic(); await drain();
  const oldLeases = await leaseRows(), oldMembers = await inventory();
  check(persistent.size === KEEP, 'initial_six_protection_missing');
  phase.checks.push('six_initial_lease_epochs_preserved_through_refill_cap_and_management_until_storm');
  startPhase('all_thirty_two_existing_member_401_storm');
  const stormBefore = counts(await get('mock', '/test/counts'));
  check(oldLeases.length === CAP && new Set(oldLeases.map(item => item.member_identity)).size === CAP
    && oldMembers.every(item => item.state === 'ready' && item.reauth_count < 3), 'storm_requires_all_existing_ready_members');
  const [stormFence] = await select('SELECT COALESCE(MAX(id),0) id FROM user_pool_events');
  allowFailed = true;
  await Promise.all(callers.map((caller, n) => infer(caller, { service: SERVICES[n % 2], control: { status: 401 },
    expected: 401, label: 'existing_member_upstream_401' })));
  // Only this deliberate all-member invalidation ends the six protected initial
  // epochs. Every injected-401 marker has captured its OLD identity before we
  // clear current bindings; retain historicalBindings for request-stat ownership.
  bindings.clear(); persistent.clear();
  await drain();
  const failed = await inventory(), duringLeases = await leaseRows();
  check(failed.length === CAP && failed.every(item => item.state === 'failed' && item.stage === 'synced'
    && item.verified_at === null && item.last_error === 'upstream_unauthorized' && item.attempts === 0
    && item.reauth_count === oldMembers.find(old => old.identity === item.identity).reauth_count + 1), 'storm_did_not_schedule_exact_existing_repairs');
  check(duringLeases.length === 0, 'storm_old_leases_remain_after_hold_drain');
  await expiredWithoutRenewal(oldLeases, stormFence);
  for (const [n, caller] of callers.slice(0, KEEP).entries()) await infer(caller, { service: SERVICES[n % 2],
    expected: 429, code: 'pool_exhausted', label: 'storm_exhausted_before_upstream' });
  const stormPaused = counts(await get('mock', '/test/counts')); noNewObjects(stormBefore, stormPaused);
  check(stormPaused.counters.taskPosts === stormBefore.counters.taskPosts, 'paused_storm_started_login');
  phase.checks.push('thirty_two_marker_scoped_401_no_global_control', 'all_old_leases_expired_without_renewal_after_hold_drain',
    'failed_admissions_absent_upstream_no_replay');

  startPhase('automatic_existing_member_repair_at_cap');
  await change({ paused: 0 }); await settled(CAP, 0); await change({ paused: 1 }); allowFailed = false;
  const repaired = counts(await get('mock', '/test/counts')); noNewObjects(stormBefore, repaired);
  await identityStillSame(oldMembers);
  check(repaired.counters.taskPosts === stormBefore.counters.taskPosts + CAP
    && repaired.counters.callbacksSucceeded === repaired.counters.taskPosts && (await sqlState()).reauth_scheduled === CAP + 1, 'storm_repair_not_exactly_once');
  check((await leaseRows()).length === 0, 'repair_recreated_leases_without_admission');
  await expiredWithoutRenewal(oldLeases, stormFence);
  await Promise.all(callers.map((caller, n) => infer(caller, { service: SERVICES[(n + 1) % 2] })));
  await drain();
  const newLeases = await leaseRows(), oldLeaseIds = new Set(oldLeases.map(row => row.lease_id));
  check(newLeases.length === CAP && new Set(newLeases.map(row => row.caller_id)).size === CAP
    && new Set(newLeases.map(row => row.member_identity)).size === CAP && new Set(newLeases.map(row => row.lease_id)).size === CAP
    && callers.every(caller => newLeases.some(row => row.caller_id === caller && row.phase === 'active'
      && bindingKey(row) === bindingKey(bindings.get(caller)))) && newLeases.every(row => !oldLeaseIds.has(row.lease_id)), 'fresh_admissions_require_exclusive_new_lease_epochs');
  for (const caller of callers.slice(0, KEEP)) persistent.set(caller, bindings.get(caller));
  phase.checks.push('automatic_oauth_callback_and_warmup_of_same_thirty_two_members', 'no_new_scim_seats_sso_users',
    'thirty_two_fresh_requests_succeed_no_replay', 'six_new_lease_epochs_protected_for_release_waves');

  startPhase('release_waves_preserve_six_active_callers');
  await heldRelease(6); await release(Array.from({ length: 13 }, (_, n) => n + 6)); await settled(CAP, 19);
  await canaries();
  await heldRelease(19); await release(Array.from({ length: 13 }, (_, n) => n + 19)); await settled(CAP, KEEP);
  await change({ idle_target: 0, paused: 1 });
  await Promise.all(callers.slice(0, KEEP).map((caller, n) => infer(caller, { service: SERVICES[n % 2] })));
  await drain();
  phase.checks.push('two_release_waves_only_after_hold_drain', 'six_new_lease_epochs_retained_twenty_six_idle');
}
async function verifyFinal() {
  startPhase('final_identity_correlation_and_no_replay');
  const rows = await inventory(), leases = await leaseRows(), value = await observe();
  check(rows.length === CAP && rows.every((row, n) => row.ordinal === n && row.state === 'ready' && row.stage === 'ready'
    && Number(row.verified_at) > 0 && Number(row.credential_valid) === 1 && row.sso_created_at && row.task_id
    && row.identity === row.sso_user && row.gh_login && row.attempts === 0 && row.last_error === null), 'final_real_verified_inventory');
  check(new Set(rows.map(row => row.identity)).size === CAP && new Set(rows.map(row => row.task_id)).size === CAP, 'final_inventory_uniqueness');
  check(leases.length === KEEP && value.sql.holds === 0 && value.sql.catalog_holds === 0
    && value.sql.initializations === 0 && value.sql.catalog_cooldowns === 0 && value.sum.counts.ready_idle === CAP - KEEP
    && value.sum.settings.paused === 1 && value.sum.settings.idle_target === 0 && value.sum.settings.max_accounts === CAP, 'final_retained_state');
  for (const service of SERVICES) {
    const [accounts, page] = await Promise.all([get(service, '/api/user-pool/page/accounts?page=1&pageSize=100'), get(service, '/api/user-pool/page/leases?page=1&pageSize=100')]);
    check(accounts.total === CAP && accounts.items.length === CAP && accounts.items.every((item, n) => item.identity === rows[n].identity
      && item.ordinal === n && item.state === 'ready' && item.oauthStatus === 'valid' && item.verifiedAt > 0), 'replica_inventory_disagrees');
    check(page.total === KEEP && page.items.length === KEEP && page.items.every(item => persistent.get(item.callerKeyHash)?.lease_id === item.leaseId
      && persistent.get(item.callerKeyHash)?.member_identity === item.memberIdentity && item.phase === 'active' && item.inUse === false), 'replica_persistent_leases_disagree');
  }
  const [sso, login, adapter, mock] = await Promise.all([get('mock', '/__mysql/sso/api/users?page=1&pageSize=100'),
    get('mock', '/__mysql/login/api/tasks?page=1&pageSize=1'), get('mock', '/__mysql/load-state'),
    get('mock', '/test/state', { maxBytes: 2 * 1024 * 1024 })]);
  check(sso.total === CAP && sso.items.length === CAP && login.total === 0 && adapter.fixture === true
    && adapter.registered === 0 && adapter.requests === 0 && adapter.modelLists === 0, 'sso_real_login_or_seed_adapter_changed');
  check(mock.fixture === true && mock.nextControl === null && mock.users.length === CAP && mock.seats.length === CAP
    && mock.tasks.length === CAP * 2 + 1 && mock.otherInference.length === 0, 'final_mock_objects');
  const users = new Map(mock.users.map(item => [item.userName, item])), tasks = new Map(mock.tasks.map(item => [item.id, item]));
  const ssoUsers = new Map(sso.items.map(item => [item.ssoUser, item])), seats = new Set(mock.seats);
  check(users.size === CAP && ssoUsers.size === CAP && tasks.size === CAP * 2 + 1 && seats.size === CAP, 'final_external_uniqueness');
  for (const row of rows) {
    const user = users.get(row.identity), member = ssoUsers.get(row.identity), task = tasks.get(row.task_id);
    check(user?.active === true && user.githubLogin === row.gh_login && seats.has(row.gh_login)
      && member?.ghLogin === row.gh_login && member.emuStatus === 'active' && member.copilotSeatStatus === 'assigned'
      && task?.identity === row.identity && task.ssoUser === row.identity && task.status === 'success', 'final_external_binding');
    check(mock.tasks.filter(item => item.identity === row.identity).length === row.reauth_count + 1, 'duplicate_login_per_identity');
  }
  check(mock.tasks.every(item => item.status === 'success' && item.attempts === 1 && item.finishedAt), 'final_login_tasks_not_terminal');
  const seen = new Set(), warmups = new Map();
  for (const item of mock.inference) {
    check(users.has(item.identity) && integer(item.startedAt) && integer(item.endedAt) && item.endedAt >= item.startedAt, 'unfinished_or_foreign_inference');
    if (item.marker === null) {
      check(item.status === 200 && item.outcome === 'complete' && item.stream === false, 'worker_warmup_failed');
      warmups.set(item.identity, (warmups.get(item.identity) ?? 0) + 1);
    } else {
      const expected = markers.get(item.marker);
      check(expected && !expected.absent && expected.identity === item.identity && expected.status === item.status
        && expected.outcome === item.outcome && !seen.has(item.marker), 'request_replay_rotation_or_outcome_mismatch');
      seen.add(item.marker);
    }
  }
  check([...markers.entries()].every(([id, expected]) => expected.absent ? !seen.has(id) : seen.has(id)), 'missing_marker_or_admission_reached_upstream');
  check(warmups.size === CAP && [...warmups.values()].reduce((a, b) => a + b, 0) === CAP * 2 + 2, 'warmup_total_after_resume_retry_storm');
  check(rows.every(row => warmups.get(row.identity) === row.reauth_count + 1 + Number(row.reauth_count === 2)), 'warmup_duplicate_per_member');
  check(value.mock.counters.scimCreates === CAP && value.mock.counters.seatAssignments === CAP
    && value.mock.counters.taskPosts === CAP * 2 + 1 && value.mock.counters.callbacksSucceeded === CAP * 2 + 1, 'final_side_effect_totals');
  const stats = await until('request_stats', () => select('SELECT identity, caller_id, lease_id, success, path FROM proxy_request_stats'),
    records => callers.slice(0, KEEP).every(caller => records.some(item => item.caller_id === caller && Number(item.success) === 1)), 10000, 500);
  // Catalog holds intentionally use an ephemeral lease ID, not a caller lease.
  const catalogStats = stats.filter(item => item.path === '/v1/models');
  check(catalogStats.length === 1 && catalogStats[0].caller_id === callers[0] && users.has(catalogStats[0].identity)
    && Number(catalogStats[0].success) === 1, 'catalog_stats_ownership');
  check(stats.length > 0 && stats.filter(item => item.path !== '/v1/models')
    .every(item => historicalBindings.has(JSON.stringify([item.caller_id, item.identity, item.lease_id]))), 'request_stats_ownership');
  check(report.refillBursts.length >= 3 && report.refillBursts.every(item => item.concurrentSuccesses >= 2), 'three_real_concurrent_refills_required');
  report.final = { members: CAP, verifiedReady: rows.length, initialLeasesPreservedUntilStorm: KEEP,
    retainedCallers: leases.length, retainedNewLeaseEpochs: leases.length, readyIdle: value.sum.counts.ready_idle,
    holds: value.sql.holds, catalogHolds: value.sql.catalog_holds, provisioning: value.sql.provisioning,
    settings: { idleTarget: 0, maxAccounts: CAP, paused: 1 }, scimCreates: value.mock.counters.scimCreates,
    seatAssignments: value.mock.counters.seatAssignments, loginTasks: mock.tasks.length, callbacks: value.mock.counters.callbacksSucceeded,
    warmups: CAP * 2 + 2, markedUpstreamRequests: seen.size, rejectedBeforeUpstream: markers.size - seen.size,
    rawIdentitiesPersisted: 0, statsRowsChecked: stats.length, ongoingTrafficRequests: trafficRequests };
  phase.checks.push('both_replica_pages_and_sso_scim_seat_task_identity_correlation', 'all_markers_exactly_once_or_absent',
    'select_only_invariants_stats_ownership', 'six_initial_epochs_preserved_until_invalidation_then_six_new_epochs_retained');
}
async function cleanup() {
  trafficStop = true; shutdown.abort();
  for (const controller of heldControllers) controller.abort();
  // No release/delete/reset/automatic retry on failure. Freeze only after ALL
  // empty-fixture checks passed. Supported CAS settings API, either replica.
  if (writable) {
    for (const service of SERVICES) {
      for (let attempt = 0; attempt < 2 && !report.cleanup.frozen; attempt++) {
        try {
          const current = await summary(service, { cleanup: true, timeout: 2000 });
          const response = await request(service, '/api/user-pool/settings', { cleanup: true, timeout: 2000,
            method: 'PATCH', body: { expectedVersion: current.settings.version, changes: { idle_target: 0, paused: 1 } } });
          if (response.status === 409 && response.data?.error?.code === 'settings_version_conflict') continue;
          status(response, 200, 'freeze');
          const verified = await summary(service, { cleanup: true, timeout: 2000 });
          check(verified.settings.idle_target === 0 && verified.settings.paused === 1, 'freeze_not_verified');
          report.cleanup.frozen = true;
        } catch { /* Try only the other fixed replica / bounded settings CAS. */ }
      }
      if (report.cleanup.frozen) break;
    }
    if (!report.cleanup.frozen) { report.passed = false; report.failure ??= 'lifecycle_freeze_failed'; }
  }
  db?.destroy();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  report.failure ??= 'lifecycle_interrupted'; shutdown.abort(); db?.destroy();
});
try {
  check(process.argv.length === 2, 'lifecycle_arguments_forbidden');
  check(process.env.POOL_MYSQL_LIFECYCLE_CONFIRM === PROJECT, 'explicit_lifecycle_confirmation_required');
  started = Date.now(); deadline = started + RUN_MS;
  reportDirectory = await mkdtemp(join(tmpdir(), 'ghcp-mysql-lifecycle-'));
  console.log(`MYSQL_LIFECYCLE_REPORT=${join(reportDirectory, 'report.json')}`);
  watchdog = setTimeout(() => { report.failure = 'lifecycle_run_deadline'; shutdown.abort(); db?.destroy(); }, RUN_MS);
  // Last-resort cap for an unresponsive driver/socket. Normal failure handling
  // freezes and writes the report well before this guard; never extend past 10m.
  emergency = setTimeout(() => { console.error('FAIL mysql_lifecycle hard_deadline'); process.exit(1); }, 599000);
  emergency.unref();
  await fresh(); await lifecycle(); await verifyFinal();
  phase.passed = true; report.passed = true;
} catch (error) {
  report.failure ??= safeFailure(error);
  console.error(`FAIL mysql_lifecycle ${report.failure}`);
} finally {
  clearTimeout(watchdog);
  await cleanup();
  if (phase?.startedAt) { phase.wallMs = Date.now() - phase.startedAt; delete phase.startedAt; }
  report.wallMs = started ? Date.now() - started : 0;
  if (lastState) report.lastObserved = { members: lastState.members, ready: lastState.ready, leases: lastState.leases,
    holds: lastState.holds, provisioning: lastState.provisioning, failed: lastState.failed, disabled: lastState.disabled };
  if (!report.passed) process.exitCode = 1;
  if (reportDirectory) {
    try { await writeFile(join(reportDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch { console.error('FAIL mysql_lifecycle report_write_failed'); process.exitCode = 1; }
  }
  console.log(JSON.stringify({ event: 'mysql_lifecycle_result', passed: report.passed, failure: report.failure ?? null,
    phases: report.phases.length, refillBursts: report.refillBursts.length, wallMs: report.wallMs, requests: report.requests, cleanup: report.cleanup }));
  clearTimeout(emergency);
}
