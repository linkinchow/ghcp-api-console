// Node 22 + repository mysql2. Fixed disposable targets; never loads .env.
// run | prepare-failover | verify-failover | verify-restart
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PROJECT = 'ghcp-user-pool-mysql-test';
export const MODEL = 'claude-opus-5-2';
export const INTERNAL = 'mysql-fixture-internal-only';
export const API_KEY = 'mysql-fixture-api-only';
export const urls = Object.freeze({ proxy: 'http://127.0.0.1:18100', proxy2: 'http://127.0.0.1:18101', mock: 'http://127.0.0.1:18102', console: 'http://127.0.0.1:18104' });
export const auth = { 'X-Internal-Token': INTERNAL };
export const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
export const check = (condition, label) => { if (!condition) throw Object.assign(new Error(label), { fixtureCheck: true }); };
export const safeFailure = error => error?.fixtureCheck === true && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'fixture_prerequisite_or_transport_failure';
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const callers = Array.from({ length: 3 }, (_, n) => `sha256:${hash(`mysql-smoke-${n}`)}`);
export async function request(service, path, { method = 'GET', body, headers = {}, timeout = 40000, signal } = {}) {
  check(Object.hasOwn(urls, service) && path.startsWith('/') && !path.startsWith('//'), 'invalid_fixture_target');
  const response = await fetch(urls[service] + path, {
    method, redirect: 'error', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  check(text.length < 4 * 1024 * 1024, 'response_size_bound');
  let data;
  try { data = JSON.parse(text); } catch { /* HTML or SSE. */ }
  return { status: response.status, headers: response.headers, text, data };
}
export function status(result, expected, label) {
  check(result.status === expected, `${label}_http_${result.status}_expected_${expected}`);
  return result;
}
export async function poll(label, read, predicate, timeout = 120000) {
  const end = Date.now() + timeout;
  do {
    const result = await read();
    if (predicate(result)) return result;
    await sleep(250);
  } while (Date.now() < end);
  check(false, `${label}_timeout`);
}
export const pool = async (service = 'proxy', summary = false) => status(await request(service, `/api/user-pool${summary ? '/summary' : ''}`, { headers: auth }), 200, 'pool').data;
export const mock = async () => status(await request('mock', '/test/state', { headers: auth }), 200, 'mock').data;
export async function settings(changes, service = 'proxy') {
  const previous = (await pool(service, true)).settings;
  const result = status(await request(service, '/api/user-pool/settings', { method: 'PATCH', headers: auth, body: { expectedVersion: previous.version, changes } }), 200, 'settings').data;
  check(result.version === previous.version + 1, 'settings_version');
  return result;
}
export function inferOptions(caller, path, marker, stream = false) {
  return { method: 'POST', headers: { Authorization: `Bearer ${API_KEY}`, 'X-User-Identity': caller },
    body: { model: MODEL, stream, ...(path === '/responses' ? { input: marker, max_output_tokens: 16 } : { messages: [{ role: 'user', content: marker }], max_tokens: 16 }) } };
}
export function successful(result, path, stream) {
  status(result, 200, 'inference');
  if (stream) {
    check(result.headers.get('content-type')?.includes('text/event-stream'), 'sse_content_type');
    const events = result.text.split(/\r?\n\r?\n/).flatMap(frame => {
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      return data ? [data === '[DONE]' ? data : JSON.parse(data)] : [];
    });
    check(path === '/chat/completions' ? events.includes('[DONE]') : events.some(event => event.type === (path === '/responses' ? 'response.completed' : 'message_stop')), 'sse_terminal');
    check(!events.some(event => event.error || event.type === 'error'), 'sse_in_band_error');
    check(result.text.includes(MODEL) && !result.text.includes('claude-opus-5.2'), 'sse_canonical_model');
  } else {
    check(result.data?.model === MODEL, 'json_canonical_model');
    check(path === '/responses' ? result.data.status === 'completed' && result.data.output?.[0]?.content?.[0]?.text === 'OK'
      : path === '/chat/completions' ? result.data.choices?.[0]?.message?.content === 'OK' : result.data.content?.[0]?.text === 'OK', 'json_output');
  }
}
export async function health({ standbyOnly = false } = {}) {
  for (const service of standbyOnly ? ['proxy2', 'mock'] : Object.keys(urls)) {
    const manifest = status(await request(service, '/__mysql/manifest'), 200, 'manifest').data;
    check(manifest.fixture === true && manifest.project === PROJECT && manifest.database === 'ghcp_pool_mysql_test'
      && manifest.service === service && manifest.mysqlPort === 33184, 'wrong_fixture_manifest');
    status(await request(service, '/healthz'), 200, 'health');
    if (service.startsWith('proxy')) check(status(await request(service, '/readyz'), 200, 'ready').data.storage === 'mysql', 'not_mysql_proxy');
  }
  check(status(await request('mock', '/healthz'), 200, 'fixture_health').data.fixture === true, 'not_mock_fixture');
  for (const service of ['sso', 'login']) status(await request('mock', `/__mysql/${service}/healthz`), 200, 'internal_service_health');
}
export async function connectDatabase(role = 'observer') {
  check(['observer', 'load'].includes(role), 'invalid_database_role');
  // Intentionally no MYSQL_URL / MYSQL_TEST_URL / host / port / password override.
  const { createConnection } = await import('mysql2/promise');
  const db = await createConnection({ host: '127.0.0.1', port: 33184, user: `pool_${role}`,
    password: `mysql-fixture-${role}-only`, database: 'ghcp_pool_mysql_test',
    timezone: 'Z', dateStrings: true, connectTimeout: 5000, multipleStatements: false,
    supportBigNumbers: true, bigNumberStrings: false });
  try {
    const [[row]] = await db.query('SELECT DATABASE() AS db, project FROM fixture_identity WHERE id=1');
    check(row?.db === 'ghcp_pool_mysql_test' && row.project === PROJECT, 'not_disposable_database');
    return db;
  } catch (error) { await db.end(); throw error; }
}
export async function databaseState(db) {
  const [[row]] = await db.query(`SELECT
    (SELECT COUNT(*) FROM user_pool_settings) settings_rows,
    (SELECT SHA2(owner,256) FROM user_pool_settings WHERE id=1) owner_hash,
    (SELECT owner_until FROM user_pool_settings WHERE id=1) owner_until,
    (TIMESTAMPDIFF(MICROSECOND,'1970-01-01',UTC_TIMESTAMP(3)) DIV 1000) now_ms,
    (SELECT COUNT(*) FROM user_pool_accounts) members,
    (SELECT COUNT(*) FROM user_pool_leases) leases,
    (SELECT COUNT(DISTINCT caller_id) FROM user_pool_leases) callers,
    (SELECT COUNT(DISTINCT member_identity) FROM user_pool_leases) leased_members,
    (SELECT COUNT(*) FROM user_pool_holds) holds,
    (SELECT COUNT(*) FROM user_pool_catalog_holds) catalog_holds,
    (SELECT COUNT(*) FROM user_pool_holds h LEFT JOIN user_pool_leases l ON l.lease_id=h.lease_id WHERE l.lease_id IS NULL) orphan_holds,
    (SELECT COUNT(*) FROM user_pool_holds WHERE expires_at<deadline_at OR expires_at-deadline_at<>10000) invalid_hold_deadlines,
    (SELECT COUNT(*) FROM schema_migrations WHERE id='2026-09-12-user-pool-mysql-v1') pool_migrations`);
  return row;
}
export function invariants(row) {
  check(Number(row.settings_rows) === 1, 'settings_not_singleton');
  check(Number(row.leases) === Number(row.callers) && Number(row.leases) === Number(row.leased_members), 'lease_uniqueness');
  check(Number(row.orphan_holds) === 0 && Number(row.invalid_hold_deadlines) === 0, 'hold_invariant');
  check(Number(row.pool_migrations) === 1, 'schema_migration');
}
const leaseFor = (value, caller) => { const found = value.leases.find(lease => lease.callerKeyHash === caller); check(found, 'lease_missing'); return found; };
const stable = lease => ({ leaseId: lease.leaseId, memberIdentity: lease.memberIdentity, phase: lease.phase, lastSuccessAt: lease.lastSuccessAt, expiresAt: lease.expiresAt });
const infer = (service, caller, id, control = {}, stream = false, path = '/v1/messages') => request(service, path,
  inferOptions(caller, path, `Reply OK. POOL_TEST:${JSON.stringify({ id, ...control })}`, stream));
async function drain(db) { return poll('hold_drain', () => databaseState(db), state => Number(state.holds) === 0 && Number(state.catalog_holds) === 0, 15000); }
async function oneMarker(id, identity) {
  const records = (await mock()).inference.filter(record => record.marker === id);
  check(records.length === 1 && (!identity || records[0].identity === identity), 'upstream_replay_or_rotation');
}
async function ownerStable(db) {
  const first = await databaseState(db); invariants(first);
  check(first.owner_hash && Number(first.owner_until) > Number(first.now_ms), 'live_scheduler_owner_missing');
  await sleep(5500);
  const next = await databaseState(db); invariants(next);
  check(next.owner_hash === first.owner_hash && Number(next.owner_until) > Number(first.owner_until), 'scheduler_owner_not_stable_or_renewing');
}
async function consoleCheck() {
  const setup = status(await request('console', '/api/console/setup'), 200, 'console_setup').data;
  const session = status(await request('console', setup.initialized ? '/api/console/login' : '/api/console/setup', {
    method: 'POST', body: { username: 'mysql-fixture-admin', password: 'mysql-fixture-console-only' },
  }), setup.initialized ? 200 : 201, 'console_auth');
  const cookies = session.headers.getSetCookie().map(line => line.split(';', 1)[0]).join('; ');
  check(cookies.length > 0, 'console_session_missing');
  const result = status(await request('console', '/api/console/proxy/user-pool/summary', { headers: { Cookie: cookies } }), 200, 'console_pool_bridge');
  check(result.data.enabled === true, 'console_pool_disabled');
}
async function run(db) {
  await consoleCheck();
  const initial = await pool();
  check(initial.enabled && initial.counts.total === 0 && initial.settings.idle_target === 0, 'fresh_pool_required');
  const [source, sso, login, proxyAccounts] = await Promise.all([
    mock(), request('mock', '/__mysql/sso/api/users?page=1&pageSize=100', { headers: auth }),
    request('mock', '/__mysql/login/api/tasks?page=1&pageSize=100', { headers: auth }),
    request('proxy', '/api/accounts?page=1&pageSize=100', { headers: auth }),
  ]);
  check(source.fixture && source.users.length === 0 && source.tasks.length === 0 && source.seats.length === 0 && source.inference.length === 0, 'fresh_mock_required');
  for (const result of [sso, login, proxyAccounts]) check(status(result, 200, 'empty_source').data.total === 0, 'source_not_empty');
  check((await pool('proxy2')).counts.total === 0, 'replica_source_not_empty');
  for (const service of ['proxy', 'proxy2']) status(await request(service, '/api/user-pool/summary'), 401, 'internal_auth');
  await ownerStable(db);
  console.log('PASS fresh_sources_two_mysql_replicas_single_renewing_owner_schema');

  const changed = await settings({ paused: 1, idle_target: 0, max_accounts: 3, lease_seconds: 600 });
  status(await request('proxy2', '/api/user-pool/settings', { method: 'PATCH', headers: auth,
    body: { expectedVersion: changed.version - 1, changes: { paused: 0 } } }), 409, 'cross_replica_settings_cas');
  await settings({ idle_target: 2, paused: 0 }, 'proxy2');
  await poll('real_mock_prewarm', () => pool('proxy2', true), value => value.counts.ready_idle === 2 && value.counts.provisioning === 0 && value.counts.total === 2);
  await settings({ paused: 1 });
  const warmed = await mock();
  check(warmed.counters.scimCreates === 2 && warmed.counters.taskPosts === 2 && warmed.counters.callbacksSucceeded === 2
    && warmed.counters.callbacksFailed === 0 && warmed.counters.scimConflicts === 0 && warmed.seats.length === 2, 'prewarm_chain_not_exactly_two');
  console.log('PASS real_sso_mock_scim_seats_oauth_callback_warmup_no_duplicate_workers');

  const catalog = status(await request('proxy2', '/v1/models', { headers: inferOptions(callers[0], '', '').headers }), 200, 'models');
  check(catalog.data.data.some(model => model.id === MODEL) && !catalog.text.includes('claude-opus-5.2'), 'canonical_catalog');
  await drain(db); check(Number((await databaseState(db)).leases) === 0, 'catalog_created_lease');
  for (const [index, path] of ['/v1/messages', '/chat/completions', '/responses'].entries()) {
    for (const stream of [false, true]) successful(await infer(stream ? 'proxy2' : 'proxy', callers[0], `protocol-${index}-${stream}`, {}, stream, path), path, stream);
  }
  const raced = await Promise.all(Array.from({ length: 8 }, (_, n) => infer(n % 2 ? 'proxy2' : 'proxy', callers[0], `race-${n}`)));
  raced.forEach(result => successful(result, '/v1/messages', false));
  successful(await infer('proxy2', callers[1], 'caller-b'), '/v1/messages', false);
  await drain(db);
  const a = leaseFor(await pool(), callers[0]), b = leaseFor(await pool('proxy2'), callers[1]);
  check(a.memberIdentity !== b.memberIdentity && a.phase === 'active' && b.phase === 'active', 'exclusive_active_leases');
  check(hash(stable(a)) === hash(stable(leaseFor(await pool('proxy2'), callers[0]))), 'replica_lease_disagreement');
  const records = (await mock()).inference.filter(row => row.marker?.startsWith('protocol-') || row.marker?.startsWith('race-'));
  check(records.length === 14 && records.every(row => row.identity === a.memberIdentity), 'same_caller_rotation_or_replay');
  const beforeExhaustion = (await mock()).inference.length;
  for (const service of ['proxy', 'proxy2']) {
    const denied = status(await infer(service, callers[2], `exhausted-${service}`), 429, 'exhaustion');
    check(denied.data.error.code === 'pool_exhausted' && Number(denied.headers.get('retry-after')) > 0, 'exhaustion_shape');
  }
  check((await mock()).inference.length === beforeExhaustion, 'exhaustion_reached_upstream');
  console.log('PASS canonical_json_sse_alternating_replicas_exclusive_shared_leases_exhaustion');

  await settings({ idle_target: 1, paused: 0 }, 'proxy2');
  await poll('spare_member', () => pool('proxy2', true), value => value.counts.total === 3 && value.counts.ready_idle === 1 && value.counts.provisioning === 0);
  await settings({ paused: 1 });
  const before = stable(leaseFor(await pool(), callers[0]));
  const limited = status(await infer('proxy', callers[0], 'limited', { status: 429, retryAfter: 30 }), 429, 'upstream_429');
  check(limited.headers.get('retry-after') === '30', 'retry_after_not_preserved');
  await drain(db); await oneMarker('limited', a.memberIdentity);
  const blocked = status(await infer('proxy2', callers[0], 'cooling-no-rotation'), 429, 'cross_replica_cooling');
  check(blocked.data.error.code === 'member_cooling', 'cooling_error');
  check(!(await mock()).inference.some(row => row.marker === 'cooling-no-rotation'), 'cooling_rotated_to_spare');
  check(hash(before) === hash(stable(leaseFor(await pool('proxy2'), callers[0]))), 'failed_request_renewed_lease');
  console.log('PASS persisted_cooling_no_renewal_no_rotation_with_spare_ready');

  const baseline = stable(leaseFor(await pool(), callers[1]));
  const controller = new AbortController();
  const options = inferOptions(callers[1], '/responses', 'POOL_TEST:{"id":"hold","streamMode":"hold"}', true);
  const held = await fetch(urls.proxy2 + '/responses', { ...options, headers: { ...options.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(options.body), redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) });
  try {
    check(held.status === 200, 'hold_start');
    await poll('sql_hold', () => databaseState(db), row => Number(row.holds) === 1, 5000);
    const release = status(await request('proxy', `/api/user-pool/leases/${b.leaseId}/release`, { method: 'POST', headers: auth, body: { confirm: true } }), 409, 'cross_replica_hold_release');
    check(release.data.error.code === 'lease_in_use', 'hold_release_error');
  } finally { controller.abort(); await held.body?.cancel().catch(() => {}); }
  await drain(db);
  await poll('mock_cancel', mock, value => value.inference.some(row => row.marker === 'hold' && row.outcome === 'cancelled'), 10000);
  check(hash(baseline) === hash(stable(leaseFor(await pool(), callers[1]))), 'aborted_stream_renewed_lease');
  invariants(await databaseState(db));
  const end = await mock();
  check(end.counters.scimCreates === 3 && end.counters.taskPosts === 3 && end.counters.callbacksSucceeded === 3 && end.counters.callbacksFailed === 0, 'provisioning_duplicate');
  console.log('PASS sql_holds_cross_replica_release_protection_cancellation_drain_invariants');
}
async function snapshot(db, path) {
  await settings({ paused: 1 });
  successful(await infer('proxy2', callers[1], `baseline-${Date.now()}`), '/v1/messages', false);
  await drain(db);
  const value = await pool(), state = await databaseState(db), fixture = await mock();
  const lease = leaseFor(value, callers[1]);
  const saved = { version: 1, project: PROJECT, savedAt: Date.now(), ownerHash: state.owner_hash,
    settingsHash: hash(value.settings), membersHash: hash(value.accounts.map(row => row.identity).sort()),
    leaseHash: hash({ leaseId: lease.leaseId, identity: lease.memberIdentity }), expiresAt: lease.expiresAt, counters: fixture.counters };
  const target = path ?? join(await mkdtemp(join(tmpdir(), 'ghcp-mysql-smoke-')), 'snapshot.json');
  await writeFile(target, JSON.stringify(saved, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(`MYSQL_SMOKE_SNAPSHOT ${target}`);
  console.log('PASS failover_prepared_stop_initial_proxy_owner_externally');
}
async function verify(db, path, failover) {
  check(path, 'snapshot_path_required');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  check(saved.version === 1 && saved.project === PROJECT && saved.expiresAt > Date.now(), 'snapshot_expired_or_invalid');
  if (failover) {
    // proxy is the deterministic FIRST owner on a fresh Compose boot. Demand it
    // actually be down so a mere owner timestamp comparison cannot fake failover.
    let unavailable = false;
    try { unavailable = (await request('proxy', '/readyz', { timeout: 3000 })).status !== 200; } catch { unavailable = true; }
    check(unavailable, 'stop_initial_proxy_before_verify_failover');
    await poll('standby_takeover', () => databaseState(db), row => row.owner_hash && row.owner_hash !== saved.ownerHash && Number(row.owner_until) > Number(row.now_ms), 45000);
    await ownerStable(db);
  }
  const value = await pool('proxy2'), fixture = await mock();
  const lease = leaseFor(value, callers[1]);
  check(hash(value.settings) === saved.settingsHash && hash(value.accounts.map(row => row.identity).sort()) === saved.membersHash, 'restart_settings_or_members_changed');
  check(hash({ leaseId: lease.leaseId, identity: lease.memberIdentity }) === saved.leaseHash, 'restart_lease_changed');
  for (const key of ['scimCreates', 'taskPosts', 'callbacksSucceeded', 'callbacksFailed']) check(fixture.counters[key] === saved.counters[key], 'restart_repeated_provisioning');
  const id = `verify-${Date.now()}`;
  successful(await infer('proxy2', callers[1], id), '/v1/messages', false);
  await oneMarker(id, lease.memberIdentity); await drain(db);
  invariants(await databaseState(db));
  console.log(`PASS ${failover ? 'standby_takeover_owner_renewal' : 'replica_restart'}_shared_lease_credentials_no_reprovision`);
}
async function main() {
  let db;
  try {
    const mode = process.argv[2] ?? 'run', path = process.argv[3];
    check(['run', 'prepare-failover', 'verify-failover', 'verify-restart'].includes(mode) && process.argv.length <= 4, 'invalid_smoke_arguments');
    await health({ standbyOnly: mode === 'verify-failover' });
    db = await connectDatabase();
    if (mode === 'run') { await run(db); await snapshot(db, path); }
    else if (mode === 'prepare-failover') await snapshot(db, path);
    else await verify(db, path, mode === 'verify-failover');
    console.log(`PASS mysql_smoke_${mode}`);
  } catch (error) {
    // No driver errors / SQL values / response bodies / identities / tokens.
    console.error(`FAIL mysql_smoke ${safeFailure(error)}`);
    process.exitCode = 1;
  } finally { await db?.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
