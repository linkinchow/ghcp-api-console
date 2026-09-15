// Node 22, fixed disposable mysql-smoke targets only. Never loads .env, seeds
// READY rows, retries failed accounts/inference, or starts a service.
// POOL_MYSQL_PROVISION_CONFIRM=ghcp-user-pool-mysql-test node mysql-provision-load.mjs
// [--members=2000] [--failover] [--failover-after=500]
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PROJECT, auth, urls, hash, check, safeFailure, sleep, status,
  inferOptions, successful, health, connectDatabase } from './mysql-smoke.mjs';

const execute = promisify(execFile);
const TARGET = 2000, POLL_MS = 2000, STALL_MS = 180000, MAX_MS = 2 * 60 * 60 * 1000;
const STAGES = ['new', 'sso-creating', 'sso-created', 'scim-syncing', 'scim-synced', 'seat-assigning',
  'synced', 'oauth-starting', 'oauth-dispatch', 'oauth-wait', 'warmup', 'ready'];
const COUNTERS = ['scimCreates', 'scimConflicts', 'scimUpdates', 'scimDeletes', 'seatAssignments',
  'taskPosts', 'callbacksSucceeded', 'callbacksFailed', 'modelLists'];
const QUEUE_FIELDS = ['concurrency', 'delayMs', 'active', 'peakActive', 'pending', 'accepted',
  'finished', 'failed', 'totalWaitMs', 'maxWaitMs'];
const SAMPLE_COUNTS = ['users', 'seats', 'tasks', 'inference', 'otherInference'];
const prefix = `provision-${randomUUID().slice(0, 8)}`;
const report = { version: 1, fixture: PROJECT, kind: 'real_worker_provisioning', node: process.version,
  scope: 'real Proxy workers, SSO and MySQL; mock SCIM, seats, Login completion and inference; not production capacity',
  passed: false, checks: [], samples: 0, maxima: {}, metrics: [], failover: null, cleanup: {} };
let options, observer, reportDirectory, started = 0, provisionStarted = 0, hardDeadline = 0;
let writable = false, fixtureConfirmed = false, proxyMayBeStopped = false, initialOwner;
let last, lastProgressAt = 0, highWater = -1, nextProgressAt = 0, nextMetricsAt = 0;
let shutdown = new AbortController(), watchdog, terminating = false, canaryStarted = false;
const elapsed = () => started ? Date.now() - started : 0;
const integer = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function parseOptions() {
  const result = { members: TARGET, failover: false, failoverAfter: 500 }, seen = new Set();
  for (const arg of process.argv.slice(2)) {
    if (arg === '--failover') { check(!seen.has('failover'), 'duplicate_argument'); seen.add('failover'); result.failover = true; continue; }
    const match = /^--(members|failover-after)=([0-9]+)$/.exec(arg);
    check(match && !seen.has(match[1]), 'invalid_provision_argument'); seen.add(match[1]);
    result[match[1] === 'members' ? 'members' : 'failoverAfter'] = Number(match[2]);
  }
  check(integer(result.members) && result.members >= 2 && result.members <= TARGET, 'members_bound');
  if (!seen.has('failover-after')) result.failoverAfter = Math.min(500, Math.floor(result.members / 2));
  check(!seen.has('failover-after') || result.failover, 'failover_flag_required');
  check(integer(result.failoverAfter) && result.failoverAfter >= 1 && result.failoverAfter < result.members, 'failover_threshold_bound');
  return result;
}
function running() {
  check(!terminating && !shutdown.signal.aborted && Date.now() < hardDeadline, 'provision_interrupted_or_deadline');
}
// Stream the full final state with a REAL byte limit, rather than allocating an
// arbitrary response then inspecting its length. Progress never reads /test/state.
async function request(service, path, { method = 'GET', body, headers = auth, timeout = 10000,
  maxBytes = 128 * 1024, cleanup = false } = {}) {
  check(Object.hasOwn(urls, service) && path.startsWith('/') && !path.startsWith('//'), 'invalid_fixture_target');
  if (!cleanup) running();
  const response = await fetch(urls[service] + path, { method, redirect: 'error',
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: cleanup ? AbortSignal.timeout(timeout) : AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeout)]) });
  const reader = response.body?.getReader(), parts = []; let bytes = 0;
  if (reader) try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; check(bytes <= maxBytes, 'provision_response_size_bound'); parts.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  const text = Buffer.concat(parts).toString('utf8'); let data;
  try { data = JSON.parse(text); } catch { /* status/shape checks below reject non-JSON. */ }
  return { status: response.status, headers: response.headers, data, text };
}
const get = async (service, path, extra) => status(await request(service, path, extra), 200, 'provision_read').data;
const summary = (service = 'proxy2', extra) => get(service, '/api/user-pool/summary', extra);
async function changeSettings(changes, extra = {}) {
  const before = await summary('proxy2', extra);
  const value = status(await request('proxy2', '/api/user-pool/settings', { ...extra, method: 'PATCH',
    body: { expectedVersion: before.settings.version, changes } }), 200, 'provision_settings').data;
  check(value.version === before.settings.version + 1 && Object.entries(changes).every(([key, val]) => value[key] === val), 'provision_settings_not_applied');
  return value;
}
async function select(sql, values = []) {
  running(); check(/^SELECT\s/i.test(sql) && !/\b(?:INTO\s+OUTFILE|FOR\s+UPDATE)\b/i.test(sql), 'observer_select_only');
  let timer;
  try {
    return (await Promise.race([observer.query({ sql, values, timeout: 7000 }), new Promise((_, reject) => {
      timer = setTimeout(() => { observer?.destroy(); reject(Object.assign(new Error('observer_timeout'), { fixtureCheck: true })); }, 8000);
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
    (SELECT COUNT(*) FROM user_pool_accounts WHERE state IN ('cooling','disabled')) unavailable,
    (SELECT COUNT(*) FROM user_pool_accounts WHERE last_error IS NOT NULL OR attempts>0) errored,
    (SELECT COUNT(*) FROM user_pool_leases) leases,
    (SELECT COUNT(DISTINCT caller_id) FROM user_pool_leases) callers,
    (SELECT COUNT(DISTINCT member_identity) FROM user_pool_leases) leased_members,
    (SELECT COUNT(*) FROM user_pool_holds) holds,
    (SELECT COUNT(*) FROM user_pool_catalog_holds) catalog_holds,
    (SELECT COUNT(*) FROM user_pool_catalog_cooldowns) catalog_cooldowns,
    (SELECT COUNT(*) FROM proxy_identity_initializations) initializations,
    (SELECT COUNT(*) FROM proxy_request_stats) stats,
    (SELECT COUNT(*) FROM proxy_request_stats WHERE success=0) failed_stats,
    (SELECT COUNT(*) FROM user_pool_events) events,
    (SELECT COUNT(*) FROM user_pool_events WHERE action='provision_failed') provision_failures,
    (SELECT COUNT(*) FROM user_pool_holds h LEFT JOIN user_pool_leases l ON l.lease_id=h.lease_id WHERE l.lease_id IS NULL) orphan_holds,
    (SELECT COUNT(*) FROM user_pool_holds WHERE expires_at<deadline_at OR expires_at-deadline_at<>10000) invalid_hold_deadlines,
    (SELECT COUNT(*) FROM schema_migrations WHERE id='2026-09-12-user-pool-mysql-v1') migrations`);
  for (const key of Object.keys(row)) if (key !== 'owner_hash') { row[key] = Number(row[key]); check(integer(row[key]), 'invalid_sql_count'); }
  return row;
}
function mockCounts(value) {
  check(value?.fixture === true && value.nextControl === null, 'mock_fixture_or_control_invalid');
  for (const [obj, keys] of [[value.counts, SAMPLE_COUNTS], [value.counters, COUNTERS], [value.loginQueue, QUEUE_FIELDS]]) {
    check(obj && keys.every(key => integer(obj[key])), 'mock_counts_or_queue_capability_missing');
  }
  return { counts: Object.fromEntries(SAMPLE_COUNTS.map(k => [k, value.counts[k]])),
    counters: Object.fromEntries(COUNTERS.map(k => [k, value.counters[k]])),
    loginQueue: Object.fromEntries(QUEUE_FIELDS.map(k => [k, value.loginQueue[k]])) };
}
async function control(action, cleanup = false) {
  check(fixtureConfirmed && ['snapshot', 'stop-proxy', 'start-proxy'].includes(action), 'fixture_control_not_authorized');
  if (!cleanup) running();
  const { stdout } = await execute(process.execPath, [fileURLToPath(new URL('./stability-control.mjs', import.meta.url)), action],
    { timeout: 45000, maxBuffer: 128 * 1024, windowsHide: true });
  const value = JSON.parse(stdout);
  check(value?.fixture === true && value.project === PROJECT, 'control_wrong_fixture');
  if (action !== 'snapshot') check(value.action === action && value.running === (action === 'start-proxy') && value.paused === false, 'control_action_failed');
  return value;
}
async function metrics() {
  const value = await control('snapshot');
  const allowed = ['proxy', 'proxy2', 'mysql', 'mock', 'pool-lb'];
  const required = allowed.filter(service => !proxyMayBeStopped || service !== 'proxy');
  check(Array.isArray(value.containers) && value.containers.length >= required.length && value.containers.length <= allowed.length
    && new Set(value.containers.map(row => row.service)).size === value.containers.length
    && required.every(service => value.containers.some(row => row.service === service)), 'metrics_services_missing');
  const containers = value.containers.map(row => {
    check(allowed.includes(row.service) && [row.cpuPercent, row.memoryBytes, row.pids].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0), 'metrics_shape');
    return { service: row.service, cpuPercent: row.cpuPercent, memoryBytes: row.memoryBytes, pids: row.pids };
  });
  check(value.mysql && integer(value.mysql.threadsConnected) && integer(value.mysql.maxUsedConnections), 'mysql_metrics_missing');
  report.metrics.push({ elapsedMs: elapsed(), containers,
    mysql: { threadsConnected: value.mysql.threadsConnected, maxUsedConnections: value.mysql.maxUsedConnections } });
  nextMetricsAt = Date.now() + 60000;
}
async function persistProgress(sample) {
  await appendFile(join(reportDirectory, 'progress.jsonl'), JSON.stringify(sample) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ event: 'provision_progress', ...sample }));
}
function safeSample(value) {
  const sql = Object.fromEntries(Object.entries(value.sql).filter(([key]) => !['owner_hash', 'owner_until', 'now_ms'].includes(key)));
  return { elapsedMs: elapsed(), sql, stages: value.stages, mock: value.mock, ssoTotal: integer(value.ssoTotal) ? value.ssoTotal : null,
    ownerLive: Boolean(value.sql.owner_hash && value.sql.owner_until > value.sql.now_ms),
    ownerChanged: Boolean(initialOwner && value.sql.owner_hash !== initialOwner) };
}
async function observe({ provisioning = true } = {}) {
  const [sql, sum, fixture, sso, rows] = await Promise.all([sqlState(), summary(), get('mock', '/test/counts'),
    get('mock', '/__mysql/sso/api/users?page=1&pageSize=1'),
    select('SELECT stage, COUNT(*) total FROM user_pool_accounts GROUP BY stage')]);
  const stages = Object.fromEntries(STAGES.map(stage => [stage, 0]));
  for (const row of rows) { check(STAGES.includes(row.stage) && integer(Number(row.total)), 'unknown_provision_stage'); stages[row.stage] = Number(row.total); }
  const value = { sql, summary: sum, mock: mockCounts(fixture), stages, ssoTotal: sso.total };
  last = value; report.samples++;
  for (const [key, n] of Object.entries({ members: sql.members, accounts: sql.accounts, ready: sql.ready,
    loginActive: value.mock.loginQueue.active, loginPending: value.mock.loginQueue.pending,
    holds: sql.holds + sql.catalog_holds, sso: sso.total })) report.maxima[key] = Math.max(report.maxima[key] ?? 0, n);
  check(sum.enabled && sql.settings_rows === 1 && sql.migrations === 1, 'pool_or_schema_invalid');
  if (!proxyMayBeStopped) check(sql.owner_hash && sql.owner_until > sql.now_ms, 'live_scheduler_owner_missing');
  if (!options.failover) check(sql.owner_hash === initialOwner, 'unexpected_owner_change_without_fault');
  check(sql.leases === sql.callers && sql.leases === sql.leased_members && sql.orphan_holds === 0 && sql.invalid_hold_deadlines === 0, 'lease_hold_invariant');
  check(integer(sso.total), 'sso_count_invalid');
  const m = value.mock;
  check([sql.members, sql.accounts, sql.next_ordinal, sso.total, m.counts.users, m.counts.seats,
    m.counts.tasks, m.counters.scimCreates, m.counters.seatAssignments, m.counters.taskPosts,
    m.counters.callbacksSucceeded].every(n => n <= options.members), 'provision_over_cap_or_duplicate');
  check(sql.failed === 0 && sql.unavailable === 0 && sql.errored === 0 && sql.provision_failures === 0
    && sql.failed_stats === 0 && sum.counts.failed === 0, 'provision_failed_account_no_retry');
  check(m.counters.scimConflicts === 0 && m.counters.callbacksFailed === 0 && m.loginQueue.failed === 0
    && m.counters.scimUpdates === 0 && m.counters.scimDeletes === 0 && m.counts.otherInference === 0, 'mock_side_effect_failure');
  check(m.loginQueue.concurrency === report.loginQueue.concurrency && m.loginQueue.delayMs === report.loginQueue.delayMs
    && m.loginQueue.active <= m.loginQueue.concurrency && m.loginQueue.peakActive <= m.loginQueue.concurrency, 'login_queue_over_concurrency');
  check(m.loginQueue.active + m.loginQueue.pending <= 5 && stages['oauth-dispatch'] + stages['oauth-wait'] <= 5, 'login_pending_cap_exceeded');
  if (provisioning) {
    check(sql.leases === 0 && sql.holds === 0 && sql.catalog_holds === 0 && sql.stats === 0, 'provisioning_created_caller_state');
    check(sum.settings.paused === 0 && sum.settings.idle_target === options.members
      && sum.settings.max_accounts === options.members, 'provision_settings_changed');
    check(m.counts.inference <= options.members, 'duplicate_warmup_count');
    // Forward stage milestones count as progress; owner renewal and reads do not.
    const score = sql.ready * 100 + Object.entries(stages).reduce((n, [stage, total]) => n + STAGES.indexOf(stage) * total, 0)
      + m.counters.scimCreates + m.counters.seatAssignments + m.counters.taskPosts + m.counters.callbacksSucceeded + m.counts.inference;
    if (score > highWater) { highWater = score; lastProgressAt = Date.now(); }
    check(Date.now() - lastProgressAt < STALL_MS, 'provision_no_progress_180_seconds');
  }
  if (Date.now() >= nextProgressAt) { await persistProgress(safeSample(value)); nextProgressAt = Date.now() + 30000; }
  if (Date.now() >= nextMetricsAt) await metrics();
  return value;
}
async function initialize() {
  await health(); fixtureConfirmed = true;
  const runtime = await get('mock', '/__mysql/sso/api/settings/runtime');
  check(integer(runtime.version) && runtime.version > 0 && (runtime.maxSsoUsers === null || integer(runtime.maxSsoUsers) && runtime.maxSsoUsers > 0), 'sso_runtime_cap_unreadable');
  report.ssoInitialCap = runtime.maxSsoUsers;
  console.log(JSON.stringify({ event: 'sso_capacity_preflight', maxSsoUsers: runtime.maxSsoUsers,
    requestedMembers: options.members, capSufficient: runtime.maxSsoUsers === null || runtime.maxSsoUsers >= options.members }));
  observer = await connectDatabase('observer');
  const [a, b, sql, fixture, sso, login, adapter] = await Promise.all([summary('proxy'), summary(), sqlState(),
    get('mock', '/test/counts'), get('mock', '/__mysql/sso/api/users?page=1&pageSize=1'),
    get('mock', '/__mysql/login/api/tasks?page=1&pageSize=1'), get('mock', '/__mysql/load-state')]);
  const m = mockCounts(fixture);
  check(a.enabled && b.enabled && a.counts.total === 0 && b.counts.total === 0
    && a.settings.idle_target === 0 && b.settings.idle_target === 0 && a.settings.version === b.settings.version, 'fresh_empty_zero_target_pool_required');
  check(['accounts', 'members', 'leases', 'holds', 'catalog_holds', 'catalog_cooldowns', 'initializations', 'stats', 'events', 'next_ordinal']
    .every(key => sql[key] === 0), 'fresh_empty_database_required');
  check(sso.total === 0 && login.total === 0 && Object.values(m.counts).every(n => n === 0)
    && Object.values(m.counters).every(n => n === 0) && m.loginQueue.active === 0 && m.loginQueue.pending === 0
    && m.loginQueue.accepted === 0 && m.loginQueue.finished === 0 && m.loginQueue.failed === 0 && m.loginQueue.peakActive === 0, 'fresh_empty_sources_required');
  check(adapter.fixture === true && adapter.registered === 0 && adapter.requests === 0 && adapter.active === 0, 'ready_seed_adapter_forbidden');
  check(sql.settings_rows === 1 && sql.migrations === 1 && sql.owner_hash && sql.owner_until > sql.now_ms, 'fresh_live_owner_required');
  check(m.loginQueue.concurrency >= 1 && m.loginQueue.delayMs <= 1000, 'login_queue_configuration');
  report.loginQueue = { concurrency: m.loginQueue.concurrency, delayMs: m.loginQueue.delayMs };
  initialOwner = sql.owner_hash;
  for (const service of ['proxy', 'proxy2']) status(await request(service, '/api/user-pool/summary', { headers: {} }), 401, 'internal_auth');
  status(await request('mock', '/test/counts', { headers: {} }), 401, 'counts_auth');
  await metrics();
  writable = true;
  // Supported versioned HTTP configuration only. The fixture default is nullable;
  // an image/operator may have set 1000. Report the actual value, not an assumption.
  const configured = status(await request('mock', '/__mysql/sso/api/settings/runtime', { method: 'PATCH',
    body: { expectedVersion: runtime.version, changes: { maxSsoUsers: options.members } } }), 200, 'sso_runtime_cap_patch').data;
  check(configured.maxSsoUsers === options.members && configured.version === runtime.version + 1
    && (await get('mock', '/__mysql/sso/api/settings/runtime')).maxSsoUsers === options.members, 'sso_runtime_cap_not_applied');
  report.ssoConfiguredCap = options.members;
  await changeSettings({ idle_target: options.members, max_accounts: options.members, paused: 0, lease_seconds: 600 });
  provisionStarted = Date.now(); lastProgressAt = provisionStarted;
  report.checks.push('empty_sources_no_ready_seeding_supported_runtime_settings');
}
async function proxyDown() {
  try { return (await request('proxy', '/readyz', { timeout: 3000 })).status >= 500; }
  catch (error) { if (error?.fixtureCheck) throw error; running(); return true; }
}
async function failover() {
  check(last.sql.owner_hash === initialOwner && last.sql.owner_until > last.sql.now_ms, 'initial_proxy_owner_changed_before_failover');
  check(last.sql.ready < options.members, 'failover_too_late_for_provisioning_progress');
  const before = last, start = Date.now();
  report.failover = { startedAtMs: elapsed(), readyBefore: before.sql.ready, scimBefore: before.mock.counters.scimCreates,
    stopped: false, takeover: false, progressedWhileDown: false, restored: false };
  proxyMayBeStopped = true; await control('stop-proxy');
  check(await proxyDown(), 'proxy_one_still_available'); report.failover.stopped = true;
  console.log(JSON.stringify({ event: 'provision_failover_stopped', ...report.failover }));
  const end = Date.now() + 90000; let takeover;
  while (Date.now() < end) {
    const value = await observe();
    if (value.sql.owner_hash && value.sql.owner_hash !== initialOwner && value.sql.owner_until > value.sql.now_ms) {
      if (!takeover) {
        takeover = { at: Date.now(), ready: value.sql.ready, owner: value.sql.owner_hash, until: value.sql.owner_until };
        report.failover.takeover = true; report.failover.readyAtTakeover = value.sql.ready;
        console.log(JSON.stringify({ event: 'provision_failover_takeover', ...report.failover }));
      }
      check(value.sql.owner_hash === takeover.owner, 'failover_successor_owner_changed');
      if (value.sql.ready > takeover.ready && Date.now() - takeover.at >= 5500 && value.sql.owner_until > takeover.until) {
        check(await proxyDown(), 'proxy_one_returned_before_progress');
        report.failover.progressedWhileDown = true; report.failover.readyWhileDown = value.sql.ready;
        report.failover.scimWhileDown = value.mock.counters.scimCreates;
        break;
      }
    }
    await sleep(POLL_MS);
  }
  check(report.failover.takeover && report.failover.progressedWhileDown, 'failover_takeover_or_new_ready_timeout');
  await control('start-proxy'); await restoredReady(); proxyMayBeStopped = false;
  report.failover.restored = true; report.failover.wallMs = Date.now() - start;
  report.checks.push('proxy_one_down_owner_takeover_new_ready_progress_restore');
}
async function restoredReady(cleanup = false) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    try {
      const value = await request('proxy', '/readyz', { timeout: 5000, cleanup });
      if (value.status === 200 && value.data?.storage === 'mysql') return;
    } catch { /* bounded readiness polling, never a provisioning retry */ }
    await sleep(1000);
  }
  check(false, 'restored_proxy_not_ready');
}
async function provision() {
  for (;;) {
    running(); const value = await observe();
    if (options.failover && !report.failover && value.sql.ready >= options.failoverAfter) await failover();
    if (value.sql.ready === options.members && value.sql.members === options.members
      && value.summary.counts.ready_idle === options.members && value.summary.counts.provisioning === 0
      && value.mock.loginQueue.active === 0 && value.mock.loginQueue.pending === 0
      && value.mock.counters.callbacksSucceeded === options.members) break;
    await sleep(POLL_MS);
  }
  check(!options.failover || report.failover?.progressedWhileDown, 'requested_failover_not_exercised');
  report.provisioningWallMs = Date.now() - provisionStarted;
  report.readyMembersPerSecond = Math.round(options.members * 100000 / report.provisioningWallMs) / 100;
  await changeSettings({ paused: 1 });
}
async function inventory() {
  // No raw token leaves MySQL. Booleans prove every actual worker credential is
  // valid/nonempty; exact identity/SSO/ordinal correlations remain memory-only.
  const rows = await select(`SELECT p.identity, p.ordinal, p.state, p.stage, p.verified_at, p.sso_created_at, p.task_id,
    a.sso_user, a.gh_login, (a.copilot_oauth_status='valid' AND LENGTH(a.copilot_oauth_token)>0
      AND a.copilot_oauth_attempt_id IS NULL) credential_valid
    FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity ORDER BY p.ordinal`);
  check(rows.length === options.members, 'final_inventory_count');
  const identities = new Set(), ssoUsers = new Set(), tasks = new Set();
  for (const [i, row] of rows.entries()) {
    check(row.ordinal === i && row.state === 'ready' && row.stage === 'ready' && Number(row.verified_at) > 0
      && Number(row.credential_valid) === 1 && typeof row.sso_created_at === 'string' && row.sso_created_at.length > 0
      && row.identity === row.sso_user && row.gh_login && row.task_id, 'final_member_not_real_verified_ready');
    identities.add(row.identity); ssoUsers.add(row.sso_user); tasks.add(row.task_id);
  }
  check(identities.size === options.members && ssoUsers.size === options.members && tasks.size === options.members, 'final_identity_sso_task_uniqueness');
  return rows;
}
async function pages(rows) {
  for (const service of ['proxy', 'proxy2']) {
    const all = [];
    for (let page = 1; page <= Math.ceil(options.members / 100); page++) {
      const value = await get(service, `/api/user-pool/page/accounts?page=${page}&pageSize=100`);
      const expected = rows.slice((page - 1) * 100, page * 100);
      check(value.total === options.members && value.items.length === expected.length && value.items.every((item, i) =>
        item.identity === expected[i].identity && item.ordinal === expected[i].ordinal && item.state === 'ready'
        && item.stage === 'ready' && item.oauthStatus === 'valid' && item.verifiedAt > 0), 'paged_inventory_truncated_or_mismatched');
      all.push(...value.items.map(item => item.identity));
    }
    check(all.length === options.members && new Set(all).size === options.members, 'paging_not_exact_target');
  }
  const users = [];
  for (let page = 1; page <= Math.ceil(options.members / 100); page++) {
    const value = await get('mock', `/__mysql/sso/api/users?page=${page}&pageSize=100&sort=ssoUser&dir=asc`);
    check(value.total === options.members && value.items.length === Math.min(100, options.members - users.length), 'sso_paging_not_exact_target');
    users.push(...value.items);
  }
  const source = new Map(users.map(row => [row.ssoUser, row]));
  check(source.size === options.members && rows.every(row => source.get(row.sso_user)?.ghLogin === row.gh_login
    && source.get(row.sso_user)?.emuStatus === 'active' && source.get(row.sso_user)?.copilotSeatStatus === 'assigned'), 'sso_membership_or_entitlement_mismatch');
  report.checks.push('all_pages_and_true_last_page_both_replicas_sso_unique');
}
async function fullMock(rows, expectedCanaries = new Map()) {
  const value = await get('mock', '/test/state', { maxBytes: 4 * 1024 * 1024 });
  check(value.fixture === true && value.nextControl === null, 'final_mock_fixture');
  const members = new Map(rows.map(row => [row.identity, row]));
  check(value.users.length === options.members && value.seats.length === options.members && value.tasks.length === options.members
    && value.inference.length === options.members + expectedCanaries.size && value.otherInference.length === 0, 'final_mock_count_mismatch');
  const byUser = new Map(value.users.map(row => [row.userName, row]));
  const byTask = new Map(value.tasks.map(row => [row.id, row]));
  const seats = new Set(value.seats);
  check(byUser.size === options.members && byTask.size === options.members && seats.size === options.members
    && new Set(value.users.map(row => row.id)).size === options.members
    && new Set(value.tasks.map(row => row.identity)).size === options.members, 'mock_unique_objects');
  for (const row of rows) {
    const user = byUser.get(row.sso_user), task = byTask.get(row.task_id);
    check(user?.active === true && user.githubLogin === row.gh_login && seats.has(row.gh_login), 'mock_user_seat_binding');
    check(task?.identity === row.identity && task.ssoUser === row.sso_user && task.ghLogin === row.gh_login
      && task.status === 'success' && task.attempts === 1 && task.finishedAt, 'mock_task_identity_or_success');
  }
  const warmed = new Set(), seenCanaries = new Set();
  for (const record of value.inference) {
    check(members.has(record.identity) && record.status === 200 && record.outcome === 'complete'
      && integer(record.startedAt) && integer(record.endedAt) && record.endedAt >= record.startedAt, 'warmup_or_canary_incomplete');
    if (record.marker === null) {
      check(!warmed.has(record.identity) && record.stream === false, 'duplicate_or_non_warmup_record'); warmed.add(record.identity);
    } else {
      check(expectedCanaries.get(record.marker) === record.identity && !seenCanaries.has(record.marker), 'canary_replay_or_wrong_binding'); seenCanaries.add(record.marker);
    }
  }
  check(warmed.size === options.members && seenCanaries.size === expectedCanaries.size, 'warmup_not_exactly_once_per_identity');
  const m = mockCounts(await get('mock', '/test/counts'));
  check(['scimCreates', 'seatAssignments', 'taskPosts', 'callbacksSucceeded'].every(key => m.counters[key] === options.members)
    && m.counters.scimConflicts === 0 && m.counters.callbacksFailed === 0 && m.loginQueue.accepted === options.members
    && m.loginQueue.finished === options.members && m.loginQueue.failed === 0 && m.loginQueue.active === 0 && m.loginQueue.pending === 0, 'final_exact_provision_side_effect_counts');
  report.finalMock = m;
}
async function drain() {
  const end = Date.now() + 45000;
  do {
    const value = await sqlState();
    check(value.orphan_holds === 0 && value.invalid_hold_deadlines === 0, 'hold_drain_invariant');
    if (value.holds === 0 && value.catalog_holds === 0) return value;
    await sleep(250);
  } while (Date.now() < end);
  check(false, 'canary_hold_drain_timeout');
}
async function canary(rows) {
  canaryStarted = true;
  const callers = [0, 1].map(n => `sha256:${hash(`${prefix}-caller-${n}`)}`);
  const bindings = new Map(), markers = new Map();
  for (let pass = 0; pass < 2; pass++) {
    for (const [n, caller] of callers.entries()) {
      const service = (n + pass) % 2 ? 'proxy2' : 'proxy', marker = `${prefix}-${pass}-${n}`, path = '/v1/messages';
      const result = await request(service, path, { ...inferOptions(caller, path, `POOL_TEST:${JSON.stringify({ id: marker })}`), timeout: 40000 });
      successful(result, path, false);
      await drain();
      const found = await select('SELECT caller_id, member_identity, lease_id, phase FROM user_pool_leases WHERE caller_id=?', [caller]);
      check(found.length === 1 && found[0].phase === 'active', 'canary_active_lease_missing');
      const binding = found[0], prior = bindings.get(caller);
      if (prior) check(prior.member_identity === binding.member_identity && prior.lease_id === binding.lease_id, 'canary_cross_replica_binding_changed');
      else bindings.set(caller, binding);
      markers.set(marker, binding.member_identity);
    }
  }
  check(new Set([...bindings.values()].map(row => row.member_identity)).size === 2, 'canary_callers_not_exclusive');
  const state = await drain();
  check(state.members === options.members && state.accounts === options.members && state.leases === 2, 'canary_extra_accounts_or_leases');
  const statsEnd = Date.now() + 15000;
  let stats;
  do {
    stats = await select('SELECT identity, caller_id, lease_id, success, path FROM proxy_request_stats');
    if (stats.length >= 4) break;
    await sleep(250);
  } while (Date.now() < statsEnd);
  check(stats.length === 4 && stats.every(row => row.success === 1 && row.path === '/v1/messages'
    && bindings.get(row.caller_id)?.member_identity === row.identity && bindings.get(row.caller_id)?.lease_id === row.lease_id)
    && callers.every(caller => stats.filter(row => row.caller_id === caller).length === 2), 'canary_stats_ownership_mismatch');
  for (const service of ['proxy', 'proxy2']) {
    const page = await get(service, '/api/user-pool/page/leases?page=1&pageSize=100');
    check(page.total === 2 && page.items.length === 2 && page.items.every(row =>
      bindings.get(row.callerKeyHash)?.lease_id === row.leaseId && bindings.get(row.callerKeyHash)?.member_identity === row.memberIdentity
      && row.phase === 'active' && row.inUse === false), 'canary_api_bindings_disagree');
  }
  await fullMock(rows, markers);
  // Release only these two new fixture leases after success, via supported API.
  for (const binding of bindings.values()) status(await request('proxy2', `/api/user-pool/leases/${encodeURIComponent(binding.lease_id)}/release`,
    { method: 'POST', body: { confirm: true } }), 200, 'canary_release');
  const final = await drain();
  check(final.leases === 0 && final.stats === 4, 'final_canary_leases_not_released');
  report.canary = { callers: 2, requests: 4, replicas: 2, successes: 4, stats: 4, releasedLeases: 2, holds: 0 };
  report.checks.push('two_exclusive_callers_both_replicas_stable_bindings_stats_hold_drain_release');
}
async function finish() {
  const rows = await inventory(); await pages(rows); await fullMock(rows);
  const before = await drain();
  check(before.leases === 0 && before.stats === 0 && before.accounts === options.members && before.ready === options.members, 'pre_canary_final_state');
  report.checks.push('exact_real_ready_verified_tokens_unique_identities_sso_ordinals_tasks_warmup_once');
  await canary(rows);
  const value = await observe({ provisioning: false });
  const [runtime, login] = await Promise.all([get('mock', '/__mysql/sso/api/settings/runtime'),
    get('mock', '/__mysql/login/api/tasks?page=1&pageSize=1')]);
  check(runtime.maxSsoUsers === options.members && login.total === 0, 'final_sso_cap_or_real_login_changed');
  check(value.sql.ready === options.members && value.sql.members === options.members && value.sql.leases === 0
    && value.sql.holds === 0 && value.sql.catalog_holds === 0 && value.sql.catalog_cooldowns === 0
    && value.sql.initializations === 0 && value.summary.counts.ready_idle === options.members
    && value.summary.settings.paused === 1 && value.summary.settings.max_accounts === options.members
    && value.summary.settings.idle_target === options.members, 'final_ready_or_pause_state');
  report.final = safeSample(value); await persistProgress(report.final); await metrics();
  report.checks.push('never_over_cap_all_ready_no_remaining_leases_or_holds');
}
async function cleanup() {
  // On failure freeze scheduling BEFORE restoring proxy1. Do not return the idle
  // target to 2000 or auto-retry any failed account. Evidence stays in place.
  if (writable) {
    try { await changeSettings({ paused: 1, ...(report.passed ? {} : { idle_target: 0 }) }, { cleanup: true }); report.cleanup.workerPaused = true; }
    catch { report.cleanup.workerPaused = false; report.passed = false; }
  }
  if (proxyMayBeStopped) {
    try { await control('start-proxy', true); await restoredReady(true); report.cleanup.proxyRestored = true; proxyMayBeStopped = false; }
    catch { report.cleanup.proxyRestored = false; report.passed = false; }
  }
  report.cleanup.mysqlFaultInjected = false; // No pause-mysql action exists in this runner.
  if (report.cleanup.workerPaused === false || report.cleanup.proxyRestored === false) report.failure ??= 'provision_cleanup_incomplete';
  observer?.destroy();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  terminating = true; shutdown.abort(); report.failure ??= 'provision_interrupted';
});
try {
  options = parseOptions();
  check(process.env.POOL_MYSQL_PROVISION_CONFIRM === PROJECT, 'explicit_provision_confirmation_required');
  started = Date.now(); hardDeadline = started + MAX_MS;
  report.members = options.members; report.full2000 = options.members === TARGET; report.failoverRequested = options.failover;
  report.controlMode = process.env.POOL_AZURE_SPLIT_FIXTURE === '1' ? 'fixed_ssh_split_fixture' : 'fixed_local_fixture';
  reportDirectory = await mkdtemp(join(tmpdir(), 'ghcp-mysql-provision-'));
  await writeFile(join(reportDirectory, 'progress.jsonl'), '', { flag: 'wx', mode: 0o600 });
  console.log(`MYSQL_PROVISION_REPORT=${join(reportDirectory, 'report.json')}`);
  watchdog = setTimeout(() => { terminating = true; shutdown.abort(); report.failure = 'provision_two_hour_deadline'; observer?.destroy(); }, MAX_MS);
  await initialize(); await provision(); await finish(); report.passed = true;
} catch (error) {
  report.failure ??= safeFailure(error);
  if (last) report.partial = safeSample(last);
  console.error(`FAIL mysql_provision ${report.failure}`);
} finally {
  clearTimeout(watchdog);
  await cleanup();
  report.wallMs = elapsed(); report.canaryStarted = canaryStarted;
  if (!report.passed) process.exitCode = 1;
  if (reportDirectory) {
    try { await writeFile(join(reportDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch { console.error('FAIL mysql_provision report_write_failed'); process.exitCode = 1; }
  }
  console.log(JSON.stringify({ event: 'provision_result', passed: report.passed, full2000: report.full2000 ?? false,
    members: report.members ?? 0, wallMs: report.wallMs, failure: report.failure ?? null, cleanup: report.cleanup }));
}
