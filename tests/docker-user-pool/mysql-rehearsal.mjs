// Synthetic offline migration rehearsal only. Never reads .env or accepts DB/HTTP URLs.
// node mysql-rehearsal.mjs generate|preflight|import|verify [--source-root=/checkout] [--state=/temp/.../state.json]
// import + verify require POOL_MYSQL_REHEARSAL_CONFIRM=ghcp-user-pool-mysql-test.
// Main starts/recreates the actual Docker replicas/LB with the generated override; this file starts no servers.
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT = 'ghcp-user-pool-mysql-test';
const PREFIX = 'ghcp_pool_test_rehearsal_';
const CONTROL = 'ghcp_pool_mysql_test';
const INTERNAL = 'mysql-fixture-internal-only';
const MODEL = 'claude-opus-5-2';
const API_KEY = 'mysql-fixture-api-only';
const auth = { 'X-Internal-Token': INTERNAL };
const urls = Object.freeze({ proxy: 'http://127.0.0.1:18100', proxy2: 'http://127.0.0.1:18101', mock: 'http://127.0.0.1:18102',
  businessLB: 'http://127.0.0.1:18105', internalLB: 'http://127.0.0.1:18106' });
const runtimeEnv = Object.freeze({ ACCOUNT_ROUTING_MODE: 'caller-lease', STORAGE_DRIVER: 'mysql',
  POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.mysql.example.test', POOL_WARMUP_MODEL: MODEL,
  READY_IDLE_TARGET: '2', POOL_MAX_ACCOUNTS: '8', CALLER_LEASE_TTL_SECONDS: '3600',
  PROVISIONAL_LEASE_TTL_SECONDS: '60', PREWARM_POLL_SECONDS: '1', PREWARM_CONCURRENCY: '2',
  POOL_LOGIN_MAX_PENDING: '5', POOL_EXHAUSTED_RETRY_AFTER_SECONDS: '2', POOL_REQUEST_TIMEOUT_SECONDS: '30' });
const tables = ['proxy_accounts', 'proxy_request_stats', 'user_pool_settings', 'user_pool_accounts', 'user_pool_leases',
  'user_pool_catalog_cooldowns', 'user_pool_events', 'user_pool_holds', 'user_pool_catalog_holds', 'proxy_identity_initializations'];
const check = (condition, label) => { if (!condition) throw Object.assign(new Error(label), { rehearsalCheck: true }); };
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const same = (a, b, label) => check(hash(canonical(a)) === hash(canonical(b)), label);
const sleep = ms => new Promise(done => setTimeout(done, ms));
const token = index => `mysql-fixture-load-token-${String(index).padStart(4, '0')}`;
const isDatabase = value => typeof value === 'string' && /^ghcp_pool_test_rehearsal_[a-f0-9]{32}$/.test(value);

function options(args) {
  const mode = args.shift();
  check(['generate', 'preflight', 'import', 'verify'].includes(mode), 'invalid_rehearsal_mode');
  const result = { mode, sourceRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../..') };
  const seen = new Set();
  for (const arg of args) {
    const match = /^--(source-root|state)=(.+)$/.exec(arg);
    check(match && !seen.has(match[1]), 'invalid_rehearsal_argument'); seen.add(match[1]);
    result[match[1] === 'state' ? 'statePath' : 'sourceRoot'] = resolve(match[2]);
  }
  check(mode === 'generate' ? !result.statePath : result.statePath, 'rehearsal_state_argument');
  if (['import', 'verify'].includes(mode)) check(process.env.POOL_MYSQL_REHEARSAL_CONFIRM === PROJECT, 'rehearsal_confirmation_required');
  return result;
}
async function modules(root) {
  // Explicit checkout only: import schema/config/importer modules, never config.ts, index.ts or dotenv.
  const require = createRequire(join(await realpath(root), 'package.json'));
  const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
  const load = path => tsImport(pathToFileURL(join(root, path)).href, { parentURL: import.meta.url, tsconfig: false });
  const [migration, store, names, config, importer] = await Promise.all([
    load('src/proxy/src/db/migrations.ts'), load('src/proxy/src/userPool/store.ts'),
    load('src/proxy/src/userPool/names.ts'), load('src/proxy/src/userPool/config.ts'), load('upgrade/user-pool-mysql/migrate.ts'),
  ]);
  return { Database: require('better-sqlite3'), mysql: require('mysql2/promise'),
    runMigrations: migration.runMigrations, UserPoolStore: store.UserPoolStore, accountName: names.accountName,
    poolConfig: config.readPoolConfig(runtimeEnv), ...importer };
}
function readSource(Database, path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try { db.pragma('query_only=ON'); return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()])); }
  finally { db.close(); }
}
async function sourceUnchanged(state) {
  const bytes = await readFile(state.source);
  check(hash(bytes) === state.sourceSha256 && bytes.length === state.sourceBytes, 'sqlite_backup_bytes_changed');
  check(bytes.subarray(0, 16).toString() === 'SQLite format 3\0' && bytes[18] === 1 && bytes[19] === 1, 'sqlite_not_standalone');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const found = await lstat(state.source + suffix).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    check(!found, 'sqlite_sidecar_found');
  }
}
function override(database) {
  check(isDatabase(database), 'invalid_rehearsal_database');
  const mysql = `mysql://pool_fixture:mysql-fixture-db-only@mysql:3306/${database}`;
  const volumes = ['sso-data', 'login-data', 'login-logs', 'console-data'].map(name =>
    `  ${name}:\n    name: ${PROJECT}-rehearsal-${database.slice(PREFIX.length)}-${name}\n`).join('');
  return `# Generated synthetic rehearsal override; combine only with the existing isolated fixture.\nservices:\n  proxy:\n    environment:\n      MYSQL_URL: ${mysql}\n  proxy2:\n    environment:\n      MYSQL_URL: ${mysql}\n  bridge:\n    environment:\n      MYSQL_REHEARSAL_DB: ${database}\nvolumes:\n${volumes}`;
}
async function generate(m) {
  const directory = await mkdtemp(join(tmpdir(), 'ghcp-mysql-rehearsal-'));
  const source = join(directory, 'backup.sqlite');
  const now = Date.now(), timestamp = new Date(now - 60000).toISOString();
  const database = PREFIX + randomUUID().replaceAll('-', '');
  const db = new m.Database(source);
  try {
    db.pragma('journal_mode=DELETE'); db.pragma('foreign_keys=ON');
    m.runMigrations(db); new m.UserPoolStore(db, m.poolConfig);
    db.transaction(() => {
      // A deliberately unmet idle target proves paused startup cannot provision more members.
      db.prepare('UPDATE user_pool_settings SET paused=1, next_ordinal=3, version=7, owner=?, owner_until=?').run(randomUUID(), now - 1000);
      for (let n = 0; n < 3; n++) {
        const identity = m.accountName(n);
        db.prepare(`INSERT INTO proxy_accounts(identity,sso_user,gh_login,copilot_oauth_token,copilot_oauth_status,
          copilot_oauth_updated_at,created_at,updated_at) VALUES(?,?,?,?,'valid',?,?,?)`)
          .run(identity, identity, `mysql_rehearsal_${n}_test`, token(n), timestamp, timestamp, timestamp);
        db.prepare(`INSERT INTO user_pool_accounts(identity,ordinal,state,stage,attempt_id,oauth_attempt_id,task_id,
          sso_created_at,updated_at,verified_at,generation,reauth_count,reauth_window_at)
          VALUES(?,?,'ready','ready',?,?,?,?,?,?,9,2,?)`)
          .run(identity, n, randomUUID(), randomUUID(), randomUUID(), timestamp, now - 5000, now - 5000, now - 90000);
        const caller = `sha256:${hash(`${database}-caller-${n}`)}`, leaseId = randomUUID();
        if (n < 2) db.prepare('INSERT INTO user_pool_leases VALUES(?,?,?,\'active\',?,?,?)')
          .run(caller, identity, leaseId, now - 5000, now - 4000, now + 3600000);
        // 103 + 2 + 1: import preserves 106; actual startup retention100 leaves 103.
        for (let index = 0; index < [103, 2, 1][n]; index++) db.prepare(`INSERT INTO proxy_request_stats
          (id,identity,gh_login,requested_at,path,model,success,input_tokens,output_tokens,cache_tokens,cache_input_tokens,cache_write_tokens,caller_id,lease_id)
          VALUES(?,?,?,?,?,?,1,12,3,2,2,1,?,?)`).run(`rehearsal-stat-${n}-${String(index).padStart(3, '0')}`, identity,
            `mysql_rehearsal_${n}_test`, new Date(now - 200000 + index * 1000).toISOString(), '/v1/messages', MODEL,
            n < 2 ? caller : null, n < 2 ? leaseId : null);
      }
      db.prepare('INSERT INTO user_pool_events(id,at,action,identity,detail) VALUES(17,?,\'account_ready\',?,\'success\')')
        .run(now - 5000, m.accountName(0));
    })();
  } finally { db.close(); }
  await chmod(source, 0o400);
  const bytes = await readFile(source);
  const state = { version: 1, project: PROJECT, mode: 'rehearsal', directory, source, database,
    rehearsalId: database.slice(PREFIX.length), createdAt: now, sourceSha256: hash(bytes), sourceBytes: bytes.length,
    runtimeEnv, statsRetention: 100, members: 3, liveLeases: 2, sourceStats: 106, startupStats: 103 };
  const preflight = m.preflightSqlite(source);
  check(preflight.counts.proxy_accounts === 3 && preflight.counts.proxy_request_stats === 106 && preflight.counts.user_pool_leases === 2, 'synthetic_source_counts');
  await sourceUnchanged(state);
  await writeFile(join(directory, 'compose.rehearsal.yaml'), override(database), { flag: 'wx', mode: 0o600 });
  const statePath = join(directory, 'state.json');
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`MYSQL_REHEARSAL_STATE ${statePath}`);
  console.log(`MYSQL_REHEARSAL_DATABASE ${database}`);
  console.log(`MYSQL_REHEARSAL_OVERRIDE ${join(directory, 'compose.rehearsal.yaml')}`);
  console.log('PASS generated_paused_readonly_standalone_sqlite_3_valid_accounts_2_live_leases_106_stats_preflight');
}
async function loadState(path) {
  const state = JSON.parse(await readFile(path, 'utf8'));
  const directory = await realpath(dirname(path));
  const temp = await realpath(tmpdir());
  check(state.version === 1 && state.project === PROJECT && state.mode === 'rehearsal' && isDatabase(state.database)
    && state.rehearsalId === state.database.slice(PREFIX.length) && dirname(directory) === temp
    && directory.slice(temp.length + 1).startsWith('ghcp-mysql-rehearsal-')
    && resolve(path) === join(directory, 'state.json') && resolve(state.directory) === directory
    && resolve(state.source) === join(directory, 'backup.sqlite'), 'invalid_rehearsal_state');
  same(state.runtimeEnv, runtimeEnv, 'rehearsal_runtime_config_changed');
  check(!((await lstat(state.source)).isSymbolicLink()), 'rehearsal_source_symlink');
  same(await readFile(join(directory, 'compose.rehearsal.yaml'), 'utf8'), override(state.database), 'rehearsal_override_changed');
  await sourceUnchanged(state); return state;
}
async function request(service, path, { method = 'GET', body, headers = auth } = {}) {
  check(Object.hasOwn(urls, service) && path.startsWith('/') && !path.startsWith('//'), 'invalid_rehearsal_http_target');
  const response = await fetch(urls[service] + path, { method, redirect: 'error', signal: AbortSignal.timeout(40000),
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); check(text.length < 4 * 1024 * 1024, 'rehearsal_response_bound');
  let data; try { data = JSON.parse(text); } catch { /* SSE */ }
  return { status: response.status, headers: response.headers, text, data };
}
const ok = (result, expected = 200) => { check(result.status === expected, 'rehearsal_http_status'); return result; };
async function manifests(state, bootstrap) {
  for (const service of bootstrap ? ['mock'] : Object.keys(urls)) {
    const value = ok(await request(service, '/__mysql/manifest')).data;
    check(value?.fixture === true && value.project === PROJECT && value.service === service && value.mysqlPort === 33184,
      'rehearsal_fixture_manifest_required');
    check(bootstrap ? value.database === CONTROL && !value.mode
      : value.database === state.database && value.mode === 'rehearsal' && value.rehearsalId === state.rehearsalId,
    'rehearsal_fixture_database_manifest_mismatch');
  }
}
async function connect(m, database, root = false) {
  check(database === CONTROL || isDatabase(database), 'invalid_rehearsal_database');
  return m.mysql.createConnection({ host: '127.0.0.1', port: 33184, user: root ? 'root' : 'pool_fixture',
    password: root ? 'mysql-fixture-root-only' : 'mysql-fixture-db-only', database,
    timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: false, connectTimeout: 5000, multipleStatements: false });
}
async function controlGate(m) {
  const db = await connect(m, CONTROL, true);
  try {
    const [[row]] = await db.query('SELECT DATABASE() db, project FROM fixture_identity WHERE id=1');
    check(row?.db === CONTROL && row.project === PROJECT, 'rehearsal_control_database_marker_required');
    return db;
  } catch (error) { await db.end(); throw error; }
}
function sorted(rows, key) { return [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key]))); }
async function inspect(db, source, afterStartup = false, afterInference = false) {
  const [[selected]] = await db.query('SELECT DATABASE() db'); check(isDatabase(selected.db), 'rehearsal_actual_sql_database_mismatch');
  const [accounts] = await db.query('SELECT identity,copilot_oauth_token,copilot_oauth_status FROM proxy_accounts ORDER BY identity');
  same(accounts.map(row => [row.identity, hash(row.copilot_oauth_token), row.copilot_oauth_status]),
    sorted(source.proxy_accounts, 'identity').map(row => [row.identity, hash(row.copilot_oauth_token), row.copilot_oauth_status]), 'rehearsal_credentials_changed');
  const [settings] = await db.query('SELECT version,idle_target,max_accounts,lease_seconds,paused,next_ordinal,account_domain FROM user_pool_settings');
  same(settings, source.user_pool_settings.map(({ id, owner, owner_until, ...rest }) => rest), 'rehearsal_settings_changed');
  if (!afterStartup) {
    const [[owner]] = await db.query('SELECT owner,owner_until FROM user_pool_settings');
    check(owner.owner === null && Number(owner.owner_until) === 0, 'rehearsal_import_owner_not_cleared');
  }
  const [inventory] = await db.query('SELECT * FROM user_pool_accounts');
  same(sorted(inventory, 'identity'), sorted(source.user_pool_accounts, 'identity'), 'rehearsal_inventory_changed');
  const [leases] = await db.query('SELECT * FROM user_pool_leases');
  check(leases.length === 2, 'rehearsal_live_lease_count');
  for (const original of source.user_pool_leases) {
    const actual = leases.find(row => row.caller_id === original.caller_id);
    check(actual && actual.expires_at > Date.now(), 'rehearsal_imported_lease_expired');
    if (afterInference) {
      const { last_success_at, expires_at, ...binding } = actual;
      const { last_success_at: oldSuccess, expires_at: oldExpiry, ...originalBinding } = original;
      same(binding, originalBinding, 'rehearsal_lease_binding_changed');
      check(last_success_at > oldSuccess && expires_at > oldExpiry && expires_at - last_success_at === 3600000, 'rehearsal_success_did_not_renew_original_lease');
    } else same(actual, original, 'rehearsal_lease_deadline_or_binding_changed');
  }
  for (const table of ['user_pool_holds', 'user_pool_catalog_holds', 'proxy_identity_initializations']) {
    const [[row]] = await db.query(`SELECT COUNT(*) total FROM ${table}`); check(Number(row.total) === 0, 'rehearsal_transient_rows_present');
  }
  const [[event]] = await db.query('SELECT * FROM user_pool_events WHERE id=17');
  same(event, source.user_pool_events[0], 'rehearsal_historical_event_changed');
  const [stats] = await db.query('SELECT * FROM proxy_request_stats ORDER BY identity,requested_at DESC,id DESC');
  const expectedStats = source.proxy_accounts.flatMap(account => source.proxy_request_stats.filter(row => row.identity === account.identity)
    .sort((a, b) => b.requested_at.localeCompare(a.requested_at) || b.id.localeCompare(a.id)).slice(0, afterStartup ? 100 : Infinity));
  if (!afterInference) {
    const normalized = stats.map(row => ({ ...row, requested_at: new Date(row.requested_at.replace(' ', 'T') + 'Z').toISOString() }));
    same(sorted(normalized, 'id'), sorted(expectedStats, 'id'), 'rehearsal_import_or_startup_stats_mismatch');
  }
  return { stats, leases };
}
async function importSource(m, state, source) {
  await manifests(state, true);
  const admin = await controlGate(m);
  let db, target;
  try {
    // No IF NOT EXISTS, DROP, target fixture table, merge or automatic retry. Uncertain outcomes require inspection.
    await admin.query(`CREATE DATABASE \`${state.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    // GRANT database patterns treat underscores as wildcards unless escaped.
    await admin.query(`GRANT ALL PRIVILEGES ON \`${state.database.replaceAll('_', '\\_')}\`.* TO 'pool_fixture'@'%'`);
    target = m.mysql.createPool({ host: '127.0.0.1', port: 33184, user: 'pool_fixture', password: 'mysql-fixture-db-only',
      database: state.database, connectionLimit: 6, timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
    const result = await m.migrateSqlitePoolToMysql({ sqlitePath: state.source, pool: target, poolConfig: m.poolConfig,
      confirmOfflineSource: true, confirmEmptyTarget: true });
    check(result.counts.proxy_request_stats === 106 && !result.dryRun, 'rehearsal_import_counts');
    db = await connect(m, state.database);
    await inspect(db, source);
    await sourceUnchanged(state);
    await writeFile(join(state.directory, 'imported.json'), JSON.stringify({ database: state.database, sourceSha256: state.sourceSha256, importedAt: Date.now() }) + '\n', { flag: 'wx', mode: 0o600 });
    console.log('PASS actual_importer_empty_random_mysql_target_credential_hashes_deadlines_106_stats_readonly_source');
    console.log('NEXT main_recreate_proxy_proxy2_bridge_with_generated_override_and_fresh_mock_then_verify');
  } finally { await db?.end(); await target?.end(); await admin.end(); }
}
async function mockNoProvisioning() {
  const data = ok(await request('mock', '/test/state')).data;
  check(data.fixture === true && data.users.length === 0 && data.tasks.length === 0 && data.seats.length === 0 && data.inference.length === 0,
    'rehearsal_mock_must_be_fresh_without_provisioning');
  check(Object.values(data.counters).every(value => value === 0), 'rehearsal_external_activity_detected');
  for (const path of ['/__mysql/sso/api/users?page=1&pageSize=1', '/__mysql/login/api/tasks?page=1&pageSize=1'])
    check(ok(await request('mock', path)).data.total === 0, 'rehearsal_real_fixture_sso_login_not_empty');
}
async function adminSnapshot(service, source, exactDeadlines) {
  const response = ok(await request(service, '/api/user-pool'));
  const value = response.data;
  same(value.settings, Object.fromEntries(['version', 'idle_target', 'max_accounts', 'lease_seconds', 'paused'].map(key => [key, source.user_pool_settings[0][key]])), 'rehearsal_http_settings_mismatch');
  check(value.enabled && value.counts.total === 3 && value.counts.ready_idle === 1 && value.counts.leased === 2
    && value.counts.provisioning === 0 && value.accounts.length === 3 && value.leases.length === 2, 'rehearsal_http_counts_mismatch');
  for (const lease of source.user_pool_leases) {
    const item = value.leases.find(row => row.callerKeyHash === lease.caller_id);
    check(item?.leaseId === lease.lease_id && item.memberIdentity === lease.member_identity && item.assignedAt === lease.assigned_at && item.phase === 'active' && !item.inUse,
      'rehearsal_http_binding_mismatch');
    if (exactDeadlines) check(item.lastSuccessAt === lease.last_success_at && item.expiresAt === lease.expires_at, 'rehearsal_http_deadline_changed_on_startup');
  }
  check(!response.text.includes('mysql-fixture-load-token-'), 'rehearsal_http_credential_leak');
  if (exactDeadlines) {
    const stats = ok(await request(service, '/api/request-stats?limit=1000')).data;
    const expected = source.proxy_accounts.flatMap(account => source.proxy_request_stats.filter(row => row.identity === account.identity)
      .sort((a, b) => b.requested_at.localeCompare(a.requested_at)).slice(0, 100));
    same(sorted(stats.map(row => ({ id: row.id, identity: row.identity, caller: row.callerId ?? null,
      lease: row.leaseId ?? null, at: row.requestedAt, input: row.inputTokens, cache: row.cacheInputTokens })), 'id'),
    sorted(expected.map(row => ({ id: row.id, identity: row.identity, caller: row.caller_id,
      lease: row.lease_id, at: row.requested_at, input: row.input_tokens, cache: row.cache_input_tokens })), 'id'), 'rehearsal_http_imported_stats_mismatch');
  }
}
async function verify(m, state, source) {
  const imported = JSON.parse(await readFile(join(state.directory, 'imported.json'), 'utf8'));
  check(imported.database === state.database && imported.sourceSha256 === state.sourceSha256, 'rehearsal_import_receipt_required');
  await manifests(state, false);
  const control = await controlGate(m); await control.end();
  const db = await connect(m, state.database);
  try {
    const [[actual]] = await db.query('SELECT DATABASE() db'); check(actual.db === state.database, 'rehearsal_actual_sql_database_mismatch');
    for (const service of ['proxy', 'proxy2']) check(ok(await request(service, '/readyz')).data.storage === 'mysql', 'rehearsal_replica_not_mysql');
    await inspect(db, source, true);
    for (const service of ['proxy', 'proxy2', 'internalLB']) await adminSnapshot(service, source, true);
    await mockNoProvisioning();
    const fresh = ok(await request('mock', '/__mysql/load-state')).data;
    check(fresh.fixture === true && fresh.registered === 0 && fresh.requests === 0 && fresh.modelLists === 0, 'rehearsal_requires_fresh_load_mock');
    ok(await request('mock', '/__mysql/load-register', { method: 'POST', body: { confirm: PROJECT, members: 2000 } }), 201);
    console.log('PASS actual_two_replica_startup_paused_unchanged_bindings_deadlines_retention_106_to_103');
    const markers = [], backends = new Map(source.user_pool_leases.map(lease => [lease.caller_id, new Set()]));
    // Each imported caller traverses both replicas via the real business LB, all three API protocols, JSON and SSE.
    for (const [callerIndex, lease] of source.user_pool_leases.entries()) {
      for (const [pathIndex, path] of ['/v1/messages', '/chat/completions', '/responses'].entries()) {
        for (const stream of [false, true]) {
          const marker = `${state.rehearsalId.slice(0, 8)}-${callerIndex}-${pathIndex}-${stream ? 'sse' : 'json'}`;
          markers.push({ marker, memberIndex: source.user_pool_accounts.find(row => row.identity === lease.member_identity).ordinal, path, stream });
          const result = ok(await request('businessLB', path, { method: 'POST', headers: { Authorization: `Bearer ${API_KEY}`, 'X-User-Identity': lease.caller_id },
            body: { model: MODEL, stream, ...(path === '/responses' ? { input: `MYSQL_LOAD:${marker}`, max_output_tokens: 16 }
              : { messages: [{ role: 'user', content: `MYSQL_LOAD:${marker}` }], max_tokens: 16 }) } }));
          const backend = result.headers.get('x-fixture-backend');
          check(['proxy', 'proxy2'].includes(backend), 'rehearsal_actual_lb_backend_missing');
          backends.get(lease.caller_id).add(backend);
          check(result.text.includes(MODEL) && !result.text.includes('claude-opus-5.2'), 'rehearsal_canonical_response_model');
          if (stream) {
            check(result.headers.get('content-type')?.includes('text/event-stream'), 'rehearsal_sse_content_type');
            const frames = result.text.split(/\r?\n\r?\n/).flatMap(frame => frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()))
              .filter(Boolean).map(data => data === '[DONE]' ? data : JSON.parse(data));
            check(!frames.some(frame => frame.error || frame.type === 'error') && (path === '/chat/completions' ? frames.includes('[DONE]')
              : frames.some(frame => frame.type === (path === '/responses' ? 'response.completed' : 'message_stop'))), 'rehearsal_sse_terminal');
            check(frames.some(frame => path === '/chat/completions' ? frame.choices?.[0]?.delta?.content === 'OK'
              : path === '/responses' ? frame.type === 'response.output_text.delta' && frame.delta === 'OK'
                : frame.type === 'content_block_delta' && frame.delta?.text === 'OK'), 'rehearsal_sse_output');
          } else check(result.data?.model === MODEL && (path === '/v1/messages' ? result.data.content?.[0]?.text === 'OK'
            : path === '/chat/completions' ? result.data.choices?.[0]?.message?.content === 'OK' : result.data.status === 'completed' && result.data.output?.[0]?.content?.[0]?.text === 'OK'), 'rehearsal_json_completion');
        }
      }
    }
    check([...backends.values()].every(seen => seen.size === 2), 'rehearsal_both_actual_replicas_not_exercised');
    // Response completion and asynchronous stats persistence can trail each other briefly.
    let final;
    for (let tries = 0; tries < 40; tries++) {
      const [[count]] = await db.query("SELECT COUNT(*) total, (SELECT COUNT(*) FROM user_pool_holds) holds, (SELECT COUNT(*) FROM proxy_request_stats) retained FROM proxy_request_stats WHERE id NOT LIKE 'rehearsal-stat-%'");
      if (Number(count.total) === markers.length && Number(count.holds) === 0 && Number(count.retained) === 109) {
        final = await inspect(db, source, true, true); break;
      }
      await sleep(250);
    }
    check(final, 'rehearsal_inference_stats_timeout');
    const synthetic = ok(await request('mock', '/__mysql/load-state')).data;
    same(synthetic.records.map(({ marker, memberIndex, path, stream }) => ({ marker, memberIndex, path, stream })), markers, 'rehearsal_upstream_replay_or_binding_rotation');
    check(synthetic.records.every(row => row.complete) && synthetic.active === 0, 'rehearsal_upstream_not_drained');
    for (const lease of source.user_pool_leases) {
      const stats = final.stats.filter(row => row.identity === lease.member_identity && !row.id.startsWith('rehearsal-stat-'));
      check(stats.length === 6 && stats.every(row => row.caller_id === lease.caller_id && row.lease_id === lease.lease_id && Number(row.success) === 1), 'rehearsal_inference_stats_correlation');
    }
    check(final.stats.length === 109 && final.stats.filter(row => row.id.startsWith('rehearsal-stat-')).length === 97, 'rehearsal_post_inference_retention');
    const expectedHistorical = source.proxy_accounts.flatMap((account, index) => source.proxy_request_stats
      .filter(row => row.identity === account.identity)
      .sort((a, b) => b.requested_at.localeCompare(a.requested_at) || b.id.localeCompare(a.id))
      .slice(0, index < 2 ? 94 : 100));
    const actualHistorical = final.stats.filter(row => row.id.startsWith('rehearsal-stat-'))
      .map(row => ({ ...row, requested_at: new Date(row.requested_at.replace(' ', 'T') + 'Z').toISOString() }));
    same(sorted(actualHistorical, 'id'), sorted(expectedHistorical, 'id'), 'rehearsal_exact_retained_history');
    for (const service of ['proxy', 'proxy2', 'internalLB']) await adminSnapshot(service, source, false);
    await sleep(2200); await mockNoProvisioning(); await sourceUnchanged(state);
    await writeFile(join(state.directory, 'verified.json'), JSON.stringify({ project: PROJECT, database: state.database, sourceSha256: state.sourceSha256,
      sourceBytesUnchanged: true, importedStats: 106, startupStats: 103, inferenceRequests: markers.length, finalStats: final.stats.length, verifiedAt: Date.now() }) + '\n', { flag: 'wx', mode: 0o600 });
    console.log('PASS actual_lb_12_json_sse_requests_original_member_and_lease_ids_retention_correlation_no_provisioning_sqlite_unchanged');
  } finally { await db.end(); }
}

try {
  const args = options(process.argv.slice(2));
  const m = await modules(args.sourceRoot);
  if (args.mode === 'generate') await generate(m);
  else {
    const state = await loadState(args.statePath);
    const source = readSource(m.Database, state.source);
    m.preflightSqlite(state.source); await sourceUnchanged(state);
    check(source.user_pool_leases.length === 2 && source.user_pool_leases.every(row => row.expires_at > Date.now() + 120000),
      'rehearsal_source_leases_expiring_regenerate_after_soak');
    if (args.mode === 'preflight') console.log('PASS source_only_preflight_readonly_backup_unchanged_no_mysql_connection');
    else if (args.mode === 'import') await importSource(m, state, source);
    else await verify(m, state, source);
  }
} catch (error) {
  console.error(`FAIL ${error?.rehearsalCheck === true && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'rehearsal_prerequisite_or_transport_failure'}`);
  process.exitCode = 1;
}
