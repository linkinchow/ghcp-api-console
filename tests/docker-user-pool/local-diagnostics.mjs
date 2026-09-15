// Only fixed disposable targets; no environment-derived credentials or endpoints.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { createConnection } from 'mysql2/promise';
import { validateLocalDiagnostics } from './local-diagnostics-contract.mjs';
import {
  PROJECT, auth, health, request, status, mock, sleep, inferOptions, successful, hash, check, safeFailure,
} from './mysql-smoke.mjs';

const run = promisify(execFile);
const report = { kind: 'local_scheduler_observability', passed: false, startedAt: Date.now(), checks: [] };
check(process.env.POOL_LOCAL_DIAGNOSTICS_CONFIRM === PROJECT, 'fixed_fixture_confirmation_required');
let possiblyPaused = false, writableFixture = false, db, completed = false;

const readPool = async () => status(await request('proxy2', '/api/user-pool/summary', { headers: auth, timeout: 6000 }), 200, 'pool').data;
async function changeSettings(changes) {
  const previous = (await readPool()).settings;
  return status(await request('proxy2', '/api/user-pool/settings', {
    method: 'PATCH', headers: auth, body: { expectedVersion: previous.version, changes }, timeout: 6000,
  }), 200, 'settings').data;
}
async function until(label, read, predicate, timeout) {
  const end = Date.now() + timeout;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(250);
  } while (Date.now() < end);
  check(false, `${label}_timeout`);
}
async function diagnostics(service) {
  const start = performance.now();
  const response = status(await request(service, '/api/user-pool/diagnostics/local', { headers: auth, timeout: 4000 }), 200, 'local_diagnostics');
  check(response.headers.get('cache-control') === 'no-store', 'diagnostics_cache_control');
  validateLocalDiagnostics(response.data);
  return { service, durationMs: Math.round(performance.now() - start), ...response.data };
}
async function control(action) {
  const value = JSON.parse((await run(process.execPath, ['tests/docker-user-pool/stability-control.mjs', action], { timeout: 45000, maxBuffer: 1024 * 1024 })).stdout);
  check(value.fixture === true && value.project === PROJECT && value.action === action && value.running === true, 'control_fixture');
  check(value.paused === (action === 'pause-mysql'), 'control_pause_state');
  return value;
}
async function query(sql) { return (await db.query({ sql, timeout: 5000 }))[0]; }
async function holds() {
  const [value] = await query('SELECT (SELECT COUNT(*) FROM user_pool_holds) holds, (SELECT COUNT(*) FROM user_pool_catalog_holds) catalogHolds');
  return { holds: Number(value.holds), catalogHolds: Number(value.catalogHolds) };
}

try {
  await health();
  db = await createConnection({ host: '127.0.0.1', port: 33184, user: 'pool_observer', password: 'mysql-fixture-observer-only',
    database: 'ghcp_pool_mysql_test', timezone: 'Z', connectTimeout: 5000, multipleStatements: false });
  const [identity] = await query('SELECT DATABASE() db, project FROM fixture_identity WHERE id=1');
  check(identity.db === 'ghcp_pool_mysql_test' && identity.project === PROJECT, 'wrong_database');
  const initial = await readPool(), initialMock = await mock(), initialHolds = await holds();
  check(initial.counts.total === 0 && initial.settings.idle_target === 0 && initialHolds.holds === 0 && initialHolds.catalogHolds === 0, 'fresh_pool_required');
  check(initialMock.fixture && initialMock.users.length === 0 && initialMock.tasks.length === 0 && initialMock.seats.length === 0, 'fresh_mock_required');
  writableFixture = true;
  for (const service of ['proxy', 'proxy2']) {
    status(await request(service, '/api/user-pool/diagnostics/local', { timeout: 4000 }), 401, 'diagnostics_auth');
    status(await request(service, '/api/user-pool/diagnostics/local', { headers: { 'X-Internal-Token': 'wrong-fixture-token' }, timeout: 4000 }), 401, 'diagnostics_wrong_auth');
    const invalid = status(await request(service, '/api/user-pool/diagnostics/local?unexpected=1', { headers: auth, timeout: 4000 }), 400, 'diagnostics_query');
    check(invalid.headers.get('cache-control') === 'no-store', 'diagnostics_error_cache_control');
  }
  report.checks.push('two_replica_auth_query_no_store');
  await changeSettings({ idle_target: 3, max_accounts: 8, paused: 0, lease_seconds: 600 });
  await until('warmup', readPool, value => value.counts.total === 3 && value.counts.ready_idle === 3 && value.counts.provisioning === 0, 90000);
  await changeSettings({ paused: 1, idle_target: 0 });
  report.before = await Promise.all(['proxy', 'proxy2'].map(diagnostics));
  const owners = report.before.filter(value => value.localScheduler.state === 'owner');
  check(owners.length === 1, 'one_initial_local_owner');
  const baseline = owners[0];
  report.checks.push('three_real_worker_mock_members_single_local_owner');
  // A lost control response does not prove the pause failed; cleanup must unpause.
  possiblyPaused = true;
  report.pauseStartedAt = Date.now();
  await control('pause-mysql');
  // Renewal runs every five seconds and keeps a five-second SQL operation budget.
  await sleep(12000);
  report.during = await Promise.all(['proxy', 'proxy2'].map(diagnostics));
  const lost = report.during.find(value => value.service === baseline.service).localScheduler;
  check(lost.state === 'standby' && lost.ownershipLosses === baseline.localScheduler.ownershipLosses + 1
    && lost.lastOwnershipLoss?.reason === 'storage_unavailable' && lost.lastOwnershipLoss.storageFailure === 'deadline', 'loss_reason_state_counter');
  check(report.during.every(value => value.localScheduler.state === 'standby'), 'both_local_standby_during_outage');
  const denied = status(await request('proxy2', '/v1/messages', {
    ...inferOptions('sha256:' + hash('observability-probe'), '/v1/messages', 'diagnostic fault probe'), timeout: 10000,
  }), 503, 'storage_fail_closed');
  check(denied.data?.error?.code === 'pool_storage_unavailable', 'safe_storage_error_code');
  report.businessDuring = { status: denied.status, code: denied.data.error.code };
  report.checks.push('diagnostics_both_200_without_database_while_business_503');
  await control('unpause-mysql');
  possiblyPaused = false;
  report.unpausedAt = Date.now();
  report.after = await until('scheduler_recovery', () => Promise.all(['proxy', 'proxy2'].map(diagnostics)),
    values => values.filter(value => value.localScheduler.state === 'owner').length === 1, 45000);
  await health();
  report.recoveryMs = Date.now() - report.unpausedAt;
  successful(await request('proxy2', '/v1/messages', {
    ...inferOptions('sha256:' + hash('observability-probe'), '/v1/messages', 'diagnostic recovery probe'), timeout: 10000,
  }), '/v1/messages', false);
  report.finalHolds = await until('hold_drain', holds, value => value.holds === 0 && value.catalogHolds === 0, 10000);
  report.checks.push('automatic_scheduler_and_business_recovery_no_restart_holds_drained');
  completed = true;
} catch (error) {
  report.failure = safeFailure(error);
  process.exitCode = 1;
} finally {
  if (possiblyPaused) {
    try { await control('unpause-mysql'); possiblyPaused = false; report.restored = true; }
    catch { report.restored = false; process.exitCode = 1; }
  }
  if (writableFixture && !possiblyPaused) {
    try { report.finalSettings = await changeSettings({ paused: 1, idle_target: 0 }); }
    catch { report.cleanupFailure = 'fixture_freeze_failed'; process.exitCode = 1; }
  }
  db?.destroy();
  report.passed = completed && !process.exitCode;
  report.finishedAt = Date.now();
  await writeFile('/opt/ghcp-test/results/post-v4-observability-report.json', JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(report));
}
