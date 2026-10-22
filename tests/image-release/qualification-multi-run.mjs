// Multi-enterprise in-place upgrade qualification (docs/multi-enterprise-design.md §9.4, §9.5), dispatched from
// qualification-run.mjs when RELEASE_QUALIFICATION_MODE is multi-upgrade (MySQL 8.4, two Proxy replicas; steps
// 1–5 and 7) or multi-upgrade-sqlite (SQLite direct mode; step 6). The fresh modes qualify a new single-enterprise
// deployment on empty databases without a registry: multi-fresh (MySQL, Proxy auto-migrates), multi-fresh-dba (MySQL
// prepared with scripts/proxy-mysql-initial.sql, MYSQL_AUTO_MIGRATE=false, DML-only runtime account) and
// multi-fresh-sqlite (SQLite direct mode).
//
// Safety rules (unchanged from the single-slug qualification): a fresh Compose project and fresh subnets; only this
// project's containers are started, stopped or killed; never `down`, `rm`, `prune` or volume removal; app
// containers sit on an internal network; only the bridge publishes 127.0.0.1 ports; synthetic credentials only; no
// .env and a sanitized environment; no image builds or pulls. A failure stops the services and keeps everything
// (containers, volumes, logs) for inspection. Evidence goes to <run>/qualification-report.json; raw command output
// (which may contain synthetic tokens) stays under <run>/logs.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMPOSE, loadState, PROJECT, ROOT } from './qualification-prepare.mjs';
import * as lib from './qualification-multi-lib.mjs';

const CONTEXT = 'desktop-linux';
const DATABASE = 'ghcp_pool_mysql_test';
const SSO_DEFAULT_PASSWORD = 'mysql-fixture-sso-only';
const SSO_SESSION_SECRET = 'mysql-fixture-session-only';
const SAME_NAME_PASSWORD = 'Contoso-Fixture-Same-Name-2026';
const CONSOLE_ADMIN = { username: 'mysql-fixture-admin', password: 'mysql-fixture-console-only' };
const BACKUP_VOLUME = `${PROJECT}_qualification-backup`;
const INFRA = ['mysql', 'mock', 'bridge'];
const ENTERPRISE_TABLES = [
  'proxy_accounts',
  'user_pool_accounts',
  'proxy_request_stats',
  'proxy_identity_initializations',
];
const CONTOSO = lib.GHE_TENANT.enterpriseId;

const h = {
  mode: undefined, state: undefined, files: [], current: 'baseline', owned: false, commandIndex: 0,
  children: new Set(), smoke: undefined, db: undefined, report: undefined, step: undefined, helperIndex: 0,
  configs: {}, volumeNames: {}, secrets: {}, aborter: new AbortController(), activeEnd: 0, finalEnd: 0,
};

function fixtureError(name) {
  return Object.assign(new Error(name), { fixtureFailure: true });
}

/** Records one planned assertion of the current step; a failed one ends the run (environment kept). */
function check(condition, name, detail) {
  const passed = Boolean(condition);
  h.step?.assertions.push({ name, pass: passed, ...(detail === undefined ? {} : { detail }) });
  console.log(JSON.stringify({ step: h.step?.id, assertion: name, pass: passed }));
  if (!passed) throw fixtureError(name);
}

/** Internal precondition (not a planned assertion); fails the run with a snake_case reason. */
function ensure(condition, name) {
  if (!condition) throw fixtureError(name);
}

function evidence(values) {
  Object.assign(h.step.evidence, values);
}

async function runStep(id, body) {
  const planned = lib.qualificationPlan(h.mode).find((row) => row.id === id);
  h.step = { id, title: planned.title, startedAt: new Date().toISOString(), assertions: [], evidence: {}, pass: false };
  h.report.stepResults.push(h.step);
  const started = Date.now();
  console.log(JSON.stringify({ step: id, phase: 'start', title: planned.title }));
  try {
    await body();
    h.step.pass = true;
  } finally {
    h.step.elapsedMs = Date.now() - started;
    console.log(JSON.stringify({ step: id, phase: 'end', pass: h.step.pass, elapsedMs: h.step.elapsedMs }));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Docker and Compose

function environment(phase = h.current) {
  const target = phase === 'candidate' ? h.state.candidate : h.state.baseline;
  const env = {
    ...process.env,
    COMPOSE_DISABLE_ENV_FILE: '1',
    RELEASE_QUALIFICATION_DIR: h.state.directory,
    RELEASE_QUALIFICATION_PREFIX: target.prefix,
    RELEASE_QUALIFICATION_TAG: target.tag,
    ...(h.state.mysqlImage ? { RELEASE_QUALIFICATION_MYSQL_IMAGE: h.state.mysqlImage } : {}),
  };
  // Never let the caller's Compose, Docker, MySQL or per-enterprise settings leak into commands or containers.
  const inherited = ['COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES', 'COMPOSE_ENV_FILES',
    'COMPOSE_PATH_SEPARATOR', 'MYSQL_TEST_URL', 'MYSQL_URL', 'DOCKER_HOST', 'DOCKER_CONTEXT',
    'ENTERPRISE_REGISTRY_FILE', ...Object.values(lib.LEGACY_ENV_KEYS).flat()];
  for (const name of inherited) delete env[name];
  return env;
}

function execute(args, { phase = h.current, timeout = 120000, cleanup = false, optional = false, input,
  logStdout = true } = {}) {
  ensure(cleanup || !h.aborter.signal.aborted, 'workflow_deadline');
  const limit = Math.min(timeout, (cleanup ? h.finalEnd : h.activeEnd) - Date.now());
  ensure(limit > 0, 'workflow_deadline');
  const ordinal = ++h.commandIndex;
  return new Promise((accept, reject) => {
    let stdout = '';
    let stderr = '';
    let size = 0;
    let timedOut = false;
    let finished = false;
    const proc = spawn('docker', ['--context', CONTEXT, ...args], {
      cwd: ROOT,
      env: environment(phase),
      shell: false,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    h.children.add(proc);
    const forceKill = () => {
      timedOut = true;
      proc.kill('SIGKILL');
    };
    const timer = setTimeout(forceKill, limit);
    const abort = () => {
      if (!cleanup) forceKill();
    };
    h.aborter.signal.addEventListener('abort', abort, { once: true });
    const collect = (which, chunk) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        forceKill();
        return;
      }
      if (which === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    proc.stdout.on('data', (chunk) => collect('stdout', chunk));
    proc.stderr.on('data', (chunk) => collect('stderr', chunk));
    if (input !== undefined) {
      proc.stdin.on('error', () => {});
      proc.stdin.end(input);
    }
    const finish = async (code, spawnError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      h.aborter.signal.removeEventListener('abort', abort);
      h.children.delete(proc);
      try {
        // Docker output may include synthetic tokens; keep it only under the ignored, run-owned logs directory.
        await writeFile(
          join(h.state.directory, 'logs', `${String(ordinal).padStart(3, '0')}.json`),
          JSON.stringify({ args, code, timedOut, stdout: logStdout ? stdout : `<${stdout.length} bytes>`, stderr }),
          { flag: 'wx', mode: 0o600 },
        );
        if (spawnError || timedOut || (code !== 0 && !optional)) {
          reject(fixtureError(timedOut ? 'command_or_workflow_deadline' : 'docker_command_failed'));
        } else {
          accept({ code, stdout, stderr, ordinal });
        }
      } catch (error) {
        reject(error);
      }
    };
    proc.once('error', () => finish(null, true));
    proc.once('exit', (code) => finish(code, false));
  });
}

function composeArgs(files, args) {
  return ['compose', '--env-file', join(h.state.directory, 'empty.env'), '--project-directory', ROOT, '-p', PROJECT,
    ...files.flatMap((file) => ['-f', file]), ...args];
}

const compose = (args, options = {}) => execute(composeArgs(options.files ?? h.files, args), options);

function phaseFiles(name) {
  const files = h.state.composeFiles;
  if (name === 'legacy') return [files.base.path, files.legacy.path];
  if (name === 'registry') return [files.base.path, files.registry.path];
  if (name === 'sqlite') return [files.sqlite.path];
  if (name === 'fresh') return [files.fresh.path];
  throw new Error(`unknown compose phase ${name}`);
}

const ALL = () => (lib.isSqliteMode(h.mode) ? lib.SQLITE_ALL : lib.MYSQL_ALL);
const APPS = () => (lib.isSqliteMode(h.mode) ? lib.SQLITE_APPS : lib.APPS);
const serviceName = (row) => row.Config.Labels['com.docker.compose.service'];
const exitStatus = (row) => ({ service: serviceName(row), code: row.State.ExitCode, oom: row.State.OOMKilled,
  running: row.State.Running });

async function containerIds(services) {
  const result = await compose(['ps', '-a', '-q', ...services]);
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}

async function inspect(ids) {
  return ids.length ? JSON.parse((await execute(['inspect', ...ids])).stdout) : [];
}

/** Every container is this project's, apps run the expected image and mount only owned volumes and fixtures. */
async function verifyOwnedContainers(phase = h.current, services = ALL()) {
  const data = await inspect(await containerIds(services));
  ensure(data.length === services.length, 'owned_container_count');
  const target = phase === 'candidate' ? h.state.candidate : h.state.baseline;
  for (const row of data) {
    const labels = row.Config.Labels;
    const ownedService = services.includes(serviceName(row));
    ensure(labels['com.docker.compose.project'] === PROJECT && ownedService, 'foreign_container');
    const service = serviceName(row);
    if (!APPS().includes(service)) continue;
    const component = service === 'proxy2' ? 'proxy' : service;
    const reference = `${target.prefix}-${component}:${target.tag}`;
    ensure(row.Config.Image === reference, 'wrong_runtime_image_reference');
    ensure(row.Image === h.report.images[reference].id, 'image_changed_since_preflight');
    ensure(!row.HostConfig.PortBindings || Object.keys(row.HostConfig.PortBindings).length === 0, 'app_port_published');
    ensure(row.Mounts.every((mount) => (mount.Type === 'volume'
      ? mount.Name.startsWith(`${PROJECT}_`)
      : ['/qualification', '/certs', '/registry'].includes(mount.Destination) && mount.RW === false)),
    'app_source_or_foreign_mount');
  }
  return data;
}

async function infrastructureIds() {
  const rows = await inspect(await containerIds(lib.isSqliteMode(h.mode) ? ['mock'] : INFRA));
  return Object.fromEntries(rows.map((row) => [serviceName(row), row.Id]));
}

async function startApps(phase, services = APPS(), { wait = true, timeoutSeconds = 300 } = {}) {
  h.current = phase;
  const waitArgs = wait ? ['--wait', '--wait-timeout', String(timeoutSeconds)] : [];
  await compose(['up', '-d', '--no-build', '--pull', 'never', '--no-deps', ...waitArgs, ...services],
    { timeout: (timeoutSeconds + 30) * 1000 });
}

/** Stops services and returns their exit status; candidates must exit 0 (graceful shutdown), r4 is observed. */
async function stopApps(services = APPS(), seconds = 35) {
  await compose(['stop', '-t', String(seconds), ...services], { timeout: (seconds + 60) * 1000 });
  return (await inspect(await containerIds(services))).map(exitStatus);
}

async function renderConfig(files) {
  return JSON.parse((await compose(['config', '--format', 'json'], { files })).stdout);
}

/** Runs a throwaway helper container (left stopped, never removed) and returns its JSON result line. */
async function helper({ image = lib.NODE_IMAGE, entrypoint = 'node', mounts, args, phase = h.current }) {
  const name = `${PROJECT}-helper-${++h.helperIndex}`;
  const mountArgs = mounts.flatMap((mount) => ['--mount', mount]);
  const result = await execute(['run', '--name', name, '--label', `ghcp.qualification=${PROJECT}`, '--network', 'none',
    '--entrypoint', entrypoint, ...mountArgs, image, ...args], { phase, timeout: 180000, optional: true });
  const line = lib.lastJsonLine(result.stdout);
  return { code: result.code, line, name };
}

const fixturesMount = () => `type=bind,source=${join(h.state.directory, 'fixtures')},target=/fixtures,readonly`;

async function volumeCopy(operation, keys) {
  const mounts = keys.map((key) => `type=volume,source=${h.volumeNames[key]},target=/volumes/${key}`);
  mounts.push(`type=volume,source=${BACKUP_VOLUME},target=/backup`, fixturesMount());
  const { code, line } = await helper({ mounts, args: ['/fixtures/multi-volume-copy.mjs', operation, ...keys] });
  ensure(code === 0 && line?.volumeCopy === true, `volume_${operation}_failed`);
  return line.volumes;
}

/** In-network HTTP requests (SSO and Login are never published) through the mock container. */
async function probe(requests) {
  const result = await compose(['exec', '-T', 'mock', 'node', '/fixtures/multi-probe.mjs', lib.encodeProbe(requests)],
    { timeout: 90000 });
  const line = lib.lastJsonLine(result.stdout, (value) => value.probe === true);
  ensure(Array.isArray(line?.results) && line.results.length === requests.length, 'probe_failed');
  return line.results;
}

const one = async (request) => (await probe([request]))[0];

/** MySQL as root inside the MySQL container; SQL arrives on stdin so nothing is quoted through a shell. */
function mysqlRoot(sql, { database = DATABASE, timeout = 120000, optional = false, logStdout = true,
  clientCharset } = {}) {
  if (clientCharset !== undefined && !/^[a-z0-9]+$/.test(clientCharset)) throw new Error('invalid client charset');
  const charset = clientCharset ? `--default-character-set=${clientCharset} ` : '';
  const command = `MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql ${charset}--protocol=tcp -h127.0.0.1 -uroot -N -B ${database}`;
  return compose(['exec', '-T', 'mysql', 'sh', '-c', command], { input: sql, timeout, optional, logStdout });
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP through the loopback bridge (Proxy, Console, mock) and the MySQL observer

const internal = () => h.smoke.auth;

async function api(service, path, options = {}) {
  return h.smoke.request(service, path, { ...options, headers: { ...internal(), ...(options.headers ?? {}) } });
}

async function ensureObserver() {
  try {
    await h.db.ping();
    await h.db.query('SELECT 1 FROM fixture_identity LIMIT 1');
  } catch {
    await h.db?.end().catch(() => {});
    h.db = await connectFixtureDatabase('observer');
  }
}

/** Connection-level failures of the loopback bridge path (Docker Desktop port forwarding), never SQL errors. */
const TRANSPORT_ERRORS = new Set(['ER_NET_READ_INTERRUPTED', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED',
  'PROTOCOL_CONNECTION_LOST', 'ER_HANDSHAKE_ERROR']);

/**
 * The smoke fixture's disposable-database connection, retried (3 attempts) when the handshake through the loopback
 * bridge times out. Retries are counted in the report; the fixture still verifies the database identity.
 */
async function connectFixtureDatabase(role) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await h.smoke.connectDatabase(role);
    } catch (error) {
      if (attempt >= 3 || !TRANSPORT_ERRORS.has(error?.code)) throw error;
      h.report.transport ??= { databaseConnectRetries: 0, codes: [] };
      h.report.transport.databaseConnectRetries++;
      h.report.transport.codes.push(error.code);
      await new Promise((done) => setTimeout(done, 3000 * attempt));
    }
  }
}

async function query(sql, values = []) {
  await ensureObserver();
  return (await h.db.query({ sql, timeout: 15000 }, values))[0];
}

const scoped = (phase) => phase === 'candidate';

async function poolSettings(service = 'proxy', phase = h.current) {
  if (!scoped(phase)) return (await h.smoke.pool(service, true)).settings;
  return h.smoke.status(await api(service, '/api/user-pool/settings'), 200, 'pool_settings').data;
}

async function patchSettings(changes, service = 'proxy', phase = h.current) {
  const previous = await poolSettings(service, phase);
  const result = h.smoke.status(await api(service, '/api/user-pool/settings', {
    method: 'PATCH', body: { expectedVersion: previous.version, changes },
  }), 200, 'pool_settings_patch').data;
  ensure(result.version === previous.version + 1, 'pool_settings_version');
  return result;
}

async function defaultLeases(service = 'proxy', phase = h.current) {
  if (!scoped(phase)) return (await h.smoke.pool(service)).leases;
  return h.smoke.status(await api(service, '/api/enterprises/default/user-pool/leases'), 200, 'leases').data.items;
}

async function pauseDrain(phase = h.current) {
  const settings = await poolSettings('proxy', phase);
  if (Number(settings.paused) !== 1) await patchSettings({ paused: 1 }, 'proxy', phase);
  await ensureObserver();
  await h.smoke.poll('qualification_drain', () => h.smoke.databaseState(h.db),
    (row) => Number(row.holds) === 0 && Number(row.catalog_holds) === 0, 20000);
  h.smoke.invariants(await h.smoke.databaseState(h.db));
}

async function columnsOf(table) {
  return (await query('SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()'
    + ' AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table])).map((row) => row.name);
}

/**
 * MySQL logical snapshot with the r4 column lists, so hashes compare across the upgrade. Enterprise columns,
 * the pool config fingerprint, the schema and the migration ids are reported separately.
 */
async function logicalSnapshot({ expectLeaseMinutes = 60 } = {}) {
  await ensureObserver();
  await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  try {
    const settings = await query('SELECT id,version,idle_target,max_accounts,lease_seconds,paused,next_ordinal,'
      + 'account_domain FROM user_pool_settings ORDER BY id');
    const [{ config_fingerprint: configFingerprint }] = await query(
      'SELECT config_fingerprint FROM user_pool_settings',
    );
    const accounts = await query('SELECT identity,sso_user,gh_login,SHA2(copilot_oauth_token,256) AS token_hash,'
      + 'copilot_oauth_status,copilot_oauth_attempt_id,copilot_oauth_updated_at,created_at,updated_at'
      + ' FROM proxy_accounts ORDER BY identity');
    const members = await query('SELECT identity,ordinal,state,stage,attempt_id,oauth_attempt_id,sso_created_at,'
      + 'task_id,attempts,retry_at,last_error,updated_at,cooldown_until,verified_at,generation,reauth_count,'
      + 'reauth_window_at FROM user_pool_accounts ORDER BY identity');
    const leases = await query('SELECT caller_id,member_identity,lease_id,phase,assigned_at,last_success_at,expires_at'
      + ' FROM user_pool_leases ORDER BY caller_id');
    const stats = await query('SELECT id,identity,caller_id,lease_id,requested_at,path,model,success'
      + ' FROM proxy_request_stats ORDER BY id');
    const schema = {
      columns: await query('SELECT TABLE_NAME,COLUMN_NAME,ORDINAL_POSITION,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,'
        + 'COLLATION_NAME,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()'
        + ' ORDER BY TABLE_NAME,ORDINAL_POSITION'),
      indexes: await query('SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,COLLATION,SUB_PART'
        + ' FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()'
        + ' ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX'),
      constraints: await query('SELECT TABLE_NAME,CONSTRAINT_NAME,CONSTRAINT_TYPE,ENFORCED'
        + ' FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE()'
        + ' ORDER BY TABLE_NAME,CONSTRAINT_NAME'),
      triggers: await query('SELECT TRIGGER_NAME,EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS'
        + ' WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME'),
    };
    const migrations = (await query('SELECT id FROM schema_migrations ORDER BY id')).map((row) => row.id);
    const [{ max_event: maxEventId }] = await query('SELECT COALESCE(MAX(id),0) AS max_event FROM user_pool_events');
    await query('COMMIT');
    ensure(settings.length === 1 && Number(settings[0].paused) === 1, 'snapshot_not_paused');
    ensure(accounts.length === 3 && accounts.every((row) => row.token_hash && row.copilot_oauth_status === 'valid'),
      'snapshot_credentials_incomplete');
    const leaseBudget = Date.now() + expectLeaseMinutes * 60000;
    ensure(leases.length === 2 && leases.every((row) => Number(row.expires_at) > leaseBudget),
      'snapshot_lease_expiry_budget');
    const hashes = {
      settingsHash: lib.sha(settings),
      credentialsHash: lib.sha(accounts),
      membersHash: lib.sha(members),
      leasesHash: lib.sha(leases),
      statsHash: lib.sha(stats),
      schemaHash: lib.sha(schema),
      migrationsHash: lib.sha(migrations),
    };
    const mocks = await h.smoke.mock();
    return {
      ...hashes, configFingerprint, migrations, stats, leases, accounts: accounts.map((row) => row.identity),
      maxEventId: Number(maxEventId),
      ownerHash: (await h.smoke.databaseState(h.db)).owner_hash,
      counters: mocks.counters,
      public: { accounts: accounts.length, members: members.length, leases: leases.length, stats: stats.length,
        migrations: migrations.length, ...hashes },
    };
  } catch (error) {
    await query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function enterpriseBackfill(maxEventId) {
  const tables = {};
  for (const table of ENTERPRISE_TABLES) {
    const [row] = await query(`SELECT COUNT(*) AS total, SUM(enterprise_id='default') AS d FROM ${table}`);
    tables[table] = { total: Number(row.total), default: Number(row.d ?? 0) };
  }
  const [events] = await query('SELECT COUNT(*) AS total, SUM(enterprise_id=\'default\') AS d FROM user_pool_events'
    + ' WHERE id <= ?', [maxEventId]);
  tables.user_pool_events = { total: Number(events.total), default: Number(events.d ?? 0), upToId: maxEventId };
  return tables;
}

async function scheduler(previousOwnerHash) {
  const first = await h.smoke.poll('replacement_scheduler_owner', () => h.smoke.databaseState(h.db),
    (row) => row.owner_hash && row.owner_hash !== previousOwnerHash && Number(row.owner_until) > Number(row.now_ms),
    60000);
  const renewed = await h.smoke.poll('replacement_scheduler_renewal', () => h.smoke.databaseState(h.db),
    (row) => row.owner_hash === first.owner_hash && Number(row.owner_until) > Number(first.owner_until), 20000);
  h.smoke.invariants(renewed);
  return renewed.owner_hash === first.owner_hash && Number(renewed.owner_until) > Number(first.owner_until);
}

async function runtime(phase, apiScope, ssoUsers = 3) {
  const data = {};
  for (const service of APPS()) {
    const label = phase === 'rollback' ? 'rollback' : phase;
    const output = await compose(['exec', '-T', service, 'node', '/qualification/qualification-verify-runtime.mjs',
      service, label, apiScope, String(ssoUsers)], { timeout: 120000, optional: true });
    const record = lib.lastJsonLine(output.stdout, (row) => row?.service === service);
    ensure(output.code === 0 && record?.pass === true, `runtime_${service}_failed`);
    data[service] = record;
  }
  return data;
}

function persistenceProblems(before, after, { exact = false } = {}) {
  const problems = [];
  if (before.console.adminFileSha256 !== after.console.adminFileSha256) problems.push('console_admin_file_changed');
  for (const field of ['certSha256', 'userCount']) {
    if (before.sso[field] !== after.sso[field]) problems.push(`sso_${field}_changed`);
  }
  problems.push(...lib.tableDiff(before.sso.logicalTables, after.sso.logicalTables, { exact }).map((p) => `sso_${p}`));
  problems.push(...lib.tableDiff(before.login.logicalTables, after.login.logicalTables, { exact })
    .map((p) => `login_${p}`));
  return problems;
}

/** Six requests (JSON + SSE on each protocol) for one preserved caller, alternating replicas, same lease. */
async function protocol(snapshot, label, phase = h.current) {
  const caller = snapshot.leases.find((row) => row.caller_id === `sha256:${h.smoke.hash('mysql-smoke-1')}`);
  ensure(caller, 'preserved_active_caller_missing');
  let n = 0;
  for (const path of ['/v1/messages', '/chat/completions', '/responses']) {
    for (const stream of [false, true]) {
      const id = `qualification-${label}-${n++}`;
      const options = h.smoke.inferOptions(caller.caller_id, path, `POOL_TEST:${JSON.stringify({ id })}`, stream);
      h.smoke.successful(await h.smoke.request(n % 2 ? 'proxy' : 'proxy2', path, options), path, stream);
      const rows = (await h.smoke.mock()).inference.filter((row) => row.marker === id);
      ensure(rows.length === 1 && rows[0].identity === caller.member_identity && rows[0].outcome === 'complete',
        'protocol_lease_binding');
    }
  }
  await pauseDrain(phase);
  const prior = new Set(snapshot.stats.map((row) => row.id));
  const enterpriseColumn = (await columnsOf('proxy_request_stats')).includes('enterprise_id');
  const extra = enterpriseColumn ? ',enterprise_id' : '';
  const rows = await query(`SELECT id,identity,caller_id,lease_id,path,success${extra}`
    + ' FROM proxy_request_stats');
  const appended = rows.filter((row) => !prior.has(row.id));
  const bound = appended.length === 6 && appended.every((row) => row.identity === caller.member_identity
    && row.caller_id === caller.caller_id && row.lease_id === caller.lease_id && Number(row.success) === 1
    && (!enterpriseColumn || row.enterprise_id === 'default'));
  const shape = ['/v1/messages', '/chat/completions', '/responses']
    .every((path) => appended.filter((row) => row.path === path).length === 2);
  const lease = (await defaultLeases('proxy', phase)).find((row) => row.callerKeyHash === caller.caller_id);
  return { bound, shape, sameLease: lease?.leaseId === caller.lease_id, requests: 6, enterpriseColumn };
}

async function consoleLogin() {
  const session = h.smoke.status(await h.smoke.request('console', '/api/console/login', {
    method: 'POST', body: CONSOLE_ADMIN,
  }), 200, 'qualification_console_login');
  return session.headers.getSetCookie().map((line) => line.split(';', 1)[0]).join('; ');
}

async function consoleGet(path) {
  return h.smoke.request('console', path, { headers: { Cookie: h.secrets.consoleCookie } });
}

/** Root (`default`) SSO login of an existing pool user; returns the session cookie pair. */
async function ssoLogin(path, username, password) {
  const response = await one({ target: 'sso', method: 'POST', path, form: { username, password } });
  return { status: response.status, cookies: lib.parseSetCookies(response.headers?.['set-cookie'] ?? []) };
}

async function samlWith(path, cookie, loginPath) {
  const response = await one({ target: 'sso', path, headers: cookie ? { cookie } : {} });
  return lib.samlOutcome(response, loginPath);
}

async function saveSecrets() {
  await writeFile(join(h.state.directory, 'secrets.json'), JSON.stringify(h.secrets), { mode: 0o600 });
}

// ---------------------------------------------------------------------------------------------------------------
// Preflight

async function inspectImages(targets = [h.state.baseline, h.state.candidate]) {
  h.report.images = {};
  for (const target of targets) {
    for (const component of ['proxy', 'console', 'sso', 'login']) {
      const reference = `${target.prefix}-${component}:${target.tag}`;
      const [image] = JSON.parse((await execute(['image', 'inspect', reference], { timeout: 20000 })).stdout);
      ensure(image.Os === 'linux' && image.Architecture === 'amd64', 'wrong_image_platform');
      h.report.images[reference] = {
        id: image.Id, os: image.Os, architecture: image.Architecture, workingDir: image.Config.WorkingDir,
        cmd: image.Config.Cmd, entrypoint: image.Config.Entrypoint,
        labels: Object.fromEntries(Object.entries(image.Config.Labels ?? {})
          .filter(([key]) => /^org\.opencontainers|release/i.test(key))),
      };
    }
  }
  if (!lib.isSqliteMode(h.mode)) await execute(['image', 'inspect', h.state.mysqlImage], { timeout: 20000 });
  await execute(['image', 'inspect', lib.NODE_IMAGE], { timeout: 20000 });
}

const entryOf = (component) => (component === 'console' ? 'dist/server/index.js' : 'dist/index.js');
const probeToken = () => ({ 'x-internal-token': internal()['X-Internal-Token'] });

function candidateDefaults() {
  return ['proxy', 'console', 'sso', 'login'].every((component) => {
    const image = h.report.images[`${h.state.candidate.prefix}-${component}:${h.state.candidate.tag}`];
    return image.workingDir === `/app/src/${component}`
      && JSON.stringify(image.cmd) === JSON.stringify(['node', entryOf(component)])
      && JSON.stringify(image.entrypoint) === JSON.stringify(['/usr/bin/tini', '-g', '--']);
  });
}

async function freshProject() {
  const old = await compose(['ps', '-a', '-q']);
  const volumes = await execute(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`]);
  const backup = await execute(['volume', 'ls', '-q', '--filter', `name=^${BACKUP_VOLUME}$`]);
  return !old.stdout.trim() && !volumes.stdout.trim() && !backup.stdout.trim();
}

/** Old Kubernetes/Rancher templates override the Proxy command; the candidate image must still start and stop. */
async function legacyCommandCheck() {
  const image = `${h.state.candidate.prefix}-proxy:${h.state.candidate.tag}`;
  const name = `${PROJECT}-legacy-command`;
  await execute(['run', '-d', '--name', name, '--label', `ghcp.qualification=${PROJECT}`, '--network', 'none',
    '--entrypoint', 'node', '-e', 'DB_PATH=/tmp/proxy.sqlite', '-e', 'INTERNAL_API_TOKEN=legacy-fixture-only',
    '-e', 'PROXY_ERROR_DIAGNOSTICS_ENABLED=false', image, 'src/proxy/dist/index.js'],
  { phase: 'candidate', timeout: 60000 });
  let logs = '';
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline && !/\[proxy\] listening/.test(logs)) {
    const result = await execute(['logs', name], { phase: 'candidate', timeout: 20000 });
    logs = result.stdout + result.stderr;
    if (!/\[proxy\] listening/.test(logs)) await new Promise((done) => setTimeout(done, 1000));
  }
  await execute(['stop', '-t', '35', name], { phase: 'candidate', timeout: 60000 });
  const [container] = await inspect([name]);
  return /\[proxy\] listening/.test(logs) && container.State.ExitCode === 0 && !container.State.OOMKilled;
}

async function preflightMysql() {
  check(await freshProject(), 'fresh_project_and_volumes');
  const legacy = await renderConfig(phaseFiles('legacy'));
  const registry = await renderConfig(phaseFiles('registry'));
  const original = await renderConfig([COMPOSE]);
  h.configs = { legacy, registry, original };
  const rules = { project: PROJECT, services: lib.MYSQL_ALL, apps: lib.APPS, bridgePorts: 5 };
  const legacyProblems = lib.composeViolations(legacy, rules);
  const aliases = legacy.services.mock.networks?.isolated?.aliases ?? [];
  check(legacyProblems.length === 0 && lib.gheHosts().every((host) => aliases.includes(host)),
    'compose_isolated_legacy_phase', { problems: legacyProblems, aliases });
  const registryProblems = lib.composeViolations(registry, rules);
  const registryMounts = lib.REGISTRY_SERVICES.every((service) => registry.services[service].volumes
    .some((volume) => volume.target === '/registry' && volume.read_only === true));
  check(registryProblems.length === 0 && registryMounts, 'compose_isolated_registry_phase',
    { problems: registryProblems, registryMounts });
  h.volumeNames = Object.fromEntries(Object.entries(legacy.volumes).map(([key, volume]) => [key, volume.name]));
  // "Env unchanged" (step 2): the rendered legacy-phase environment equals the r4 qualification's, service by service.
  h.envEquality = Object.fromEntries(lib.APPS.map((service) => [service,
    JSON.stringify(sortObject(legacy.services[service].environment))
      === JSON.stringify(sortObject(original.services[service].environment))]));
  await inspectImages();
  check(true, 'images_present_locally', { images: Object.keys(h.report.images) });
  check(candidateDefaults(), 'candidate_shipped_defaults');
  h.owned = true;
  check(await legacyCommandCheck(), 'candidate_legacy_command_starts_and_stops_cleanly');
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------------------------------------------
// MySQL steps

async function runBaselineSmoke() {
  const snapshotPath = join(h.state.directory, 'smoke-snapshot.json');
  const child = spawn(process.execPath, [join(h.state.directory, 'fixtures/mysql-smoke.mjs'), 'run', snapshotPath],
    { cwd: ROOT, env: environment('baseline'), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  h.children.add(child);
  const passes = [];
  const code = await new Promise((accept) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), Math.min(300000, h.activeEnd - Date.now()));
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', () => accept(null));
    child.once('exit', async (exitCode) => {
      clearTimeout(timer);
      h.children.delete(child);
      await writeFile(join(h.state.directory, 'logs/mysql-smoke.json'), JSON.stringify({ exitCode, stdout, stderr }),
        { flag: 'wx', mode: 0o600 });
      passes.push(...stdout.split(/\r?\n/).filter((line) => line.startsWith('PASS ')).map((line) => line.slice(5)));
      accept(exitCode);
    });
  });
  return { code, passes };
}

async function step1() {
  await runStep('step1', async () => {
    h.files = phaseFiles('legacy');
    h.current = 'baseline';
    await compose(['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '400'],
      { timeout: 430000 });
    await verifyOwnedContainers('baseline');
    h.infra = await infrastructureIds();
    h.smoke = await import(pathToFileURL(join(h.state.directory, 'fixtures/mysql-smoke.mjs')).href);
    await h.smoke.health();
    const smoke = await runBaselineSmoke();
    check(smoke.code === 0, 'baseline_smoke_passed', { passes: smoke.passes });
    h.db = await connectFixtureDatabase('observer');

    // The run takes longer than the smoke's 600 s leases: lengthen them and renew both callers once.
    await patchSettings({ lease_seconds: 7200 });
    for (const caller of ['mysql-smoke-0', 'mysql-smoke-1']) {
      const options = h.smoke.inferOptions(`sha256:${h.smoke.hash(caller)}`, '/v1/messages',
        `POOL_TEST:${JSON.stringify({ id: `renew-${caller}` })}`);
      // The smoke leaves mysql-smoke-0's member cooling for 30 s (429 member_cooling, never sent upstream).
      const renewed = await h.smoke.poll(`renew_${caller}`, () => h.smoke.request('proxy', '/v1/messages', options),
        (result) => result.status !== 429 || result.data?.error?.code !== 'member_cooling', 90000);
      h.smoke.successful(renewed, '/v1/messages', false);
    }
    await pauseDrain('baseline');
    const leases = await query('SELECT expires_at FROM user_pool_leases');
    check(leases.length === 2 && leases.every((row) => Number(row.expires_at) > Date.now() + 100 * 60000),
      'baseline_leases_renewed_for_run');

    h.secrets.consoleCookie = await consoleLogin();
    const me = await consoleGet('/api/console/me');
    const summary = await consoleGet('/api/console/proxy/user-pool/summary');
    check(me.status === 200 && me.data?.username === CONSOLE_ADMIN.username && summary.status === 200,
      'baseline_console_session');

    const mock = await h.smoke.mock();
    h.ssoUser = mock.users[0]?.userName;
    ensure(h.ssoUser, 'baseline_sso_user_missing');
    const login = await ssoLogin('/login', h.ssoUser, SSO_DEFAULT_PASSWORD);
    h.secrets.r4SsoCookie = lib.cookieHeader(login.cookies, 'sso_session');
    const r4Saml = await samlWith('/sso', h.secrets.r4SsoCookie, '/login');
    const metadata = await one({ target: 'sso', path: '/metadata' });
    h.r4Metadata = lib.metadataIdentity(metadata.text);
    await saveSecrets();
    check(login.status === 200 && h.secrets.r4SsoCookie && r4Saml === 'saml_response' && h.r4Metadata.entityId,
      'baseline_sso_root_session_cookie', { saml: r4Saml, metadata: h.r4Metadata });

    h.runtime = { baseline: await runtime('baseline', 'unscoped') };
    check(true, 'baseline_runtime_verified', { releaseLines: releaseLines(h.runtime.baseline) });
    h.baseline = await logicalSnapshot({ expectLeaseMinutes: 100 });
    check(true, 'baseline_quiescent_snapshot', { snapshot: h.baseline.public });

    const exits = await stopApps();
    check(exits.every((row) => !row.running && !row.oom), 'baseline_applications_stopped',
      { exits, r4NpmShutdownIsObservationOnly: true });
    await backup();
  });
}

function releaseLines(records) {
  return Object.fromEntries(Object.entries(records).map(([service, record]) => [service, record.releaseLine ?? null]));
}

async function backup() {
  const dumpCommand = `MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump --protocol=tcp -h127.0.0.1 -uroot `
    + `${lib.MYSQLDUMP_ARGS.join(' ')} ${DATABASE}`;
  const dump = await compose(['exec', '-T', 'mysql', 'sh', '-c', dumpCommand], { timeout: 180000, logStdout: false });
  const path = join(h.state.directory, 'backups/mysql.sql');
  await writeFile(path, dump.stdout, { flag: 'wx', mode: 0o600 });
  h.dump = { path, bytes: Buffer.byteLength(dump.stdout), sha256: lib.sha(dump.stdout) };
  check(dump.stdout.includes('CREATE TABLE `proxy_accounts`') && dump.stdout.includes('CREATE TABLE `fixture_identity`')
    && !dump.stdout.includes('proxy_enterprises'), 'backup_mysql_dump_written',
  { bytes: h.dump.bytes, sha256: h.dump.sha256 });
  await execute(['volume', 'create', '--label', `ghcp.qualification=${PROJECT}`, BACKUP_VOLUME]);
  h.volumeBackup = await volumeCopy('backup', lib.MYSQL_APP_VOLUMES);
  check(Object.values(h.volumeBackup).every((row) => row.live.sha256 === row.backup.sha256), 'backup_volumes_copied',
    { volumes: h.volumeBackup });
}

async function step2() {
  await runStep('step2', async () => {
    check(Object.values(h.envEquality).every(Boolean), 'candidate_env_equals_r4_env', { services: h.envEquality });
    await startApps('candidate');
    await verifyOwnedContainers('candidate');
    const infra = await infrastructureIds();
    check(JSON.stringify(infra) === JSON.stringify(h.infra), 'infrastructure_not_recreated');
    await h.smoke.health();
    const after = await logicalSnapshot();
    const differences = lib.snapshotDifferences(h.baseline, after, lib.UPGRADE_STABLE_HASHES);
    check(differences.length === 0, 'snapshot_preserved_except_schema',
      { differences, before: h.baseline.public, after: after.public });
    check(after.configFingerprint !== h.baseline.configFingerprint && /^[a-f0-9]{64}$/.test(after.configFingerprint),
      'pool_config_fingerprint_rewritten');
    const missing = lib.missingMigrationIds(after.migrations, lib.expectedProxyMigrationIds('mysql'));
    const retained = lib.missingMigrationIds(after.migrations, h.baseline.migrations);
    check(missing.length === 0 && retained.length === 0, 'schema_migrations_complete_mysql',
      { missing, retained, migrations: after.migrations });
    const backfill = await enterpriseBackfill(h.baseline.maxEventId);
    check(Object.values(backfill).every((row) => row.total === row.default), 'enterprise_id_default_backfilled',
      backfill);
    check(await enterpriseColumnsFailClosed(), 'enterprise_columns_fail_closed', h.failClosed);
    const enterprises = await query('SELECT id,state,max_accounts,inventory_count,policy_version,profile_fingerprint'
      + ' FROM proxy_enterprises ORDER BY id');
    const [settings] = await query('SELECT max_accounts FROM user_pool_settings');
    h.defaultFingerprint = enterprises[0]?.profile_fingerprint;
    check(enterprises.length === 1 && enterprises[0].id === 'default' && enterprises[0].state === 'active'
      && Number(enterprises[0].max_accounts) === Number(settings.max_accounts)
      && Number(enterprises[0].inventory_count) === 3 && /^[a-f0-9]{64}$/.test(h.defaultFingerprint ?? ''),
    'default_enterprise_row_seeded', { enterprises: enterprises.map(({ profile_fingerprint: _f, ...row }) => row) });
    check(await scheduler(h.baseline.ownerHash), 'replacement_scheduler_owner_renewing');

    const me = await consoleGet('/api/console/me');
    const list = await consoleGet('/api/console/proxy/enterprises');
    const summary = await consoleGet('/api/console/proxy/enterprises/default/user-pool/summary');
    const unscoped = await consoleGet('/api/console/proxy/user-pool/summary');
    check(me.status === 200 && list.status === 200 && list.data?.items?.some((row) => row.id === 'default')
      && summary.status === 200 && unscoped.status === 400
      && unscoped.data?.error?.code === 'enterprise_scope_required',
    'console_session_and_enterprise_api', { statuses: [me.status, list.status, summary.status, unscoped.status] });

    h.runtime.candidate = await runtime('candidate', 'scoped');
    check(true, 'candidate_runtime_verified');
    const problems = persistenceProblems(h.runtime.baseline, h.runtime.candidate);
    check(problems.length === 0, 'sso_login_persistent_rows_preserved', { problems });
    const metadata = lib.metadataIdentity((await one({ target: 'sso', path: '/metadata' })).text);
    check(metadata.entityId === h.r4Metadata.entityId && metadata.certificateSha256 === h.r4Metadata.certificateSha256,
      'sso_root_metadata_identity_unchanged', { r4: h.r4Metadata, candidate: metadata });
    const r4Session = await samlWith('/sso', h.secrets.r4SsoCookie, '/login');
    check(r4Session === 'saml_response', 'sso_existing_root_session_valid');
    const login = await ssoLogin('/login', h.ssoUser, SSO_DEFAULT_PASSWORD);
    const payload = lib.decodeSessionCookie(login.cookies.sso_session);
    h.secrets.defaultSsoCookie = lib.cookieHeader(login.cookies, 'sso_session');
    await saveSecrets();
    check(login.status === 200 && payload?.e === 'default' && payload?.user?.ssoUser === h.ssoUser
      && typeof payload?.user?.createdAt === 'string', 'sso_root_login_issues_default_cookie');
    const loginRecord = h.runtime.candidate.login;
    check(loginRecord.pass === true && !problems.some((problem) => problem.startsWith('login_')),
      'login_task_history_preserved', { realLoginTasks: 0 });
    const result = await protocol(after, 'candidate', 'candidate');
    check(result.bound && result.shape && result.sameLease && result.enterpriseColumn, 'same_lease_protocol_json_sse',
      result);
    const lines = releaseLines(h.runtime.candidate);
    const values = new Set(Object.values(lines));
    check(values.size === 1 && [null, 'multi'].includes([...values][0])
      && Object.values(releaseLines(h.runtime.baseline)).every((line) => [null, 'single'].includes(line)),
    'release_line_health_evidence', { candidate: lines, baseline: releaseLines(h.runtime.baseline) });
    h.candidateSnapshot = after;
  });
}

/** Proves old writers fail closed: NOT NULL without default, and a real INSERT without enterprise_id is refused. */
async function enterpriseColumnsFailClosed() {
  const columns = await query('SELECT TABLE_NAME AS t, IS_NULLABLE AS n, COLUMN_DEFAULT AS d'
    + ' FROM information_schema.COLUMNS'
    + " WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='enterprise_id' ORDER BY TABLE_NAME");
  const strict = ENTERPRISE_TABLES
    .every((table) => columns.some((row) => row.t === table && row.n === 'NO' && row.d === null));
  const load = await connectFixtureDatabase('load');
  let refused = false;
  let code = null;
  try {
    await load.query({ sql: 'INSERT INTO proxy_request_stats (id,identity,requested_at,path,success)'
      + ' VALUES (?,?,UTC_TIMESTAMP(3),?,1)', timeout: 10000 },
    [`q2-${randomUUID()}`, 'fixture-old-writer', '/v1/messages']);
  } catch (error) {
    code = error?.code ?? null;
    refused = code === 'ER_NO_DEFAULT_FOR_FIELD';
  } finally {
    await load.end().catch(() => {});
  }
  h.failClosed = { columns, insertWithoutEnterprise: code };
  return strict && refused;
}

async function step3() {
  await runStep('step3', async () => {
    const before = await logicalSnapshot();
    const image = `${h.state.baseline.prefix}-proxy:${h.state.baseline.tag}`;
    const name = `${PROJECT}-r4-on-migrated`;
    const env = h.configs.legacy.services.proxy.environment;
    const network = h.configs.legacy.networks.isolated.name;
    await execute(['run', '-d', '--name', name, '--label', `ghcp.qualification=${PROJECT}`, '--network', network,
      ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]), image], { phase: 'baseline' });
    let container;
    const deadline = Date.now() + 150000;
    do {
      await new Promise((done) => setTimeout(done, 2000));
      [container] = await inspect([name]);
    } while (container.State.Running && Date.now() < deadline);
    if (container.State.Running) await execute(['stop', '-t', '10', name], { phase: 'baseline', timeout: 60000 });
    const logs = await execute(['logs', name], { phase: 'baseline', timeout: 30000 });
    const text = logs.stdout + logs.stderr;
    check(!container.State.Running && container.State.ExitCode !== 0 && !container.State.OOMKilled,
      'r4_proxy_exits_nonzero', { exitCode: container.State.ExitCode });
    check(!/\[proxy\] listening/.test(text), 'r4_proxy_never_listened',
      { schemaOrFingerprintMessage: /schema|column|enterprise|fingerprint|validat/i.test(text),
        logLines: text.split('\n').length });
    const after = await logicalSnapshot();
    check(before.schemaHash === after.schemaHash && before.migrationsHash === after.migrationsHash
      && before.configFingerprint === after.configFingerprint, 'migrated_schema_untouched_by_r4');
    await h.smoke.health();
    check(true, 'candidate_replicas_still_ready');
  });
}

async function enterprisesList(service = 'proxy') {
  return h.smoke.status(await api(service, '/api/enterprises'), 200, 'enterprise_list').data.items;
}

async function contosoSummary() {
  const response = await api('proxy', `/api/enterprises/${CONTOSO}/user-pool/summary`);
  return h.smoke.status(response, 200, 'contoso_summary').data;
}

async function step4() {
  await runStep('step4', async () => {
    h.files = phaseFiles('registry');
    for (const service of ['sso', 'login', 'proxy', 'proxy2', 'console']) await startApps('candidate', [service]);
    const containers = await verifyOwnedContainers('candidate');
    const legacyKeys = Object.values(lib.LEGACY_ENV_KEYS).flat();
    const cleared = containers.filter((row) => lib.REGISTRY_SERVICES.includes(serviceName(row))).every((row) => {
      const names = row.Config.Env.map((entry) => entry.split('=', 1)[0]);
      return row.Config.Env.includes(`ENTERPRISE_REGISTRY_FILE=${lib.REGISTRY_FILE}`)
        && !names.some((name) => legacyKeys.includes(name))
        && row.Mounts.some((mount) => mount.Destination === '/registry' && mount.RW === false);
    });
    check(cleared, 'registry_env_cleared');
    await h.smoke.health();
    check(true, 'rolling_restart_healthy', { order: ['sso', 'login', 'proxy', 'proxy2', 'console'] });
    const [row] = await query("SELECT profile_fingerprint FROM proxy_enterprises WHERE id='default'");
    check(row?.profile_fingerprint === h.defaultFingerprint, 'registry_default_identity_unchanged');

    const items = await enterprisesList();
    const items2 = await enterprisesList('proxy2');
    const contoso = items.find((item) => item.id === CONTOSO);
    check(contoso?.pool?.state === 'draft' && contoso.pool.maxAccounts === lib.GHE_TENANT.initialMaxAccounts
      && contoso.pool.inventory === 0 && items2.find((item) => item.id === CONTOSO)?.pool?.state === 'draft',
    'new_enterprise_is_draft', { contoso: contoso?.pool ?? null, ids: items.map((item) => item.id) });
    const ready = await h.smoke.poll('contoso_readiness', async () => (await enterprisesList())
      .find((item) => item.id === CONTOSO)?.readiness, (value) => value?.ready === true, 90000).catch(() => undefined);
    check(ready?.ready === true && (ready.blockers ?? []).length === 0, 'new_enterprise_ready',
      { readiness: ready ?? null });

    const version = contoso.pool.policyVersion;
    const stale = await api('proxy', `/api/enterprises/${CONTOSO}/pool-policy`, {
      method: 'PATCH', body: { expectedVersion: version + 1, state: 'active' },
    });
    check(stale.status === 409 && stale.data?.error?.code === 'policy_version_conflict',
      'stale_policy_version_rejected');
    const activated = await api('proxy2', `/api/enterprises/${CONTOSO}/pool-policy`, {
      method: 'PATCH', body: { expectedVersion: version, state: 'active' },
    });
    const policy = activated.data;
    check(activated.status === 200 && policy?.state === 'active' && policy?.policyVersion === version + 1,
      'new_enterprise_activated', { policy: activated.data });
    const settings = await poolSettings();
    const cap = await api('proxy', '/api/user-pool/settings', {
      method: 'PATCH', body: { expectedVersion: settings.version, changes: { max_accounts: 10 } },
    });
    check(cap.status === 409 && cap.data?.error?.code === 'use_enterprise_cap', 'global_cap_patch_rejected');

    await replenishAndInfer();
    await crossTenantChecks();
  });
}

async function replenishAndInfer() {
  const before = await h.smoke.mock();
  await patchSettings({ idle_target: 3, paused: 0 });
  const summary = await h.smoke.poll('contoso_replenishment', contosoSummary,
    (value) => value.counts.total === 2 && value.counts.ready_idle === 2 && value.counts.provisioning === 0, 300000);
  const defaultSummary = h.smoke.status(await api('proxy', '/api/enterprises/default/user-pool/summary'), 200,
    'default_summary').data;
  const inventory = await query('SELECT id,inventory_count FROM proxy_enterprises ORDER BY id');
  const members = await query('SELECT a.identity, a.enterprise_id AS member_enterprise,'
    + ' p.enterprise_id AS account_enterprise'
    + ' FROM user_pool_accounts a JOIN proxy_accounts p ON p.identity=a.identity ORDER BY a.identity');
  const contosoMembers = members.filter((row) => row.member_enterprise === CONTOSO);
  const after = await h.smoke.mock();
  check(summary.counts.total === 2 && defaultSummary.counts.total === 3 && contosoMembers.length === 2
    && contosoMembers.every((row) => row.account_enterprise === CONTOSO)
    && Number(inventory.find((row) => row.id === CONTOSO)?.inventory_count) === 2
    && Number(inventory.find((row) => row.id === 'default')?.inventory_count) === 3
    && after.counters.scimCreates === before.counters.scimCreates, 'replenished_into_new_enterprise_only',
  { contoso: summary.counts, default: defaultSummary.counts, inventory });
  const tenant = after.tenants?.[CONTOSO];
  h.contosoMembers = contosoMembers.map((row) => row.identity);
  check(tenant?.users.length === 2 && tenant.seats.length === 2
    && tenant.users.every((user) => user.githubLogin.length <= 30
    && !user.githubLogin.includes('_') && user.githubLogin === user.userName.toLowerCase().replace(/[^a-z0-9-]/g, '-')),
  'ghe_tenant_unsuffixed_handles', { logins: tenant?.users.map((user) => user.githubLogin.length) });
  check(tenant.counters.callbacksSucceeded === 2 && tenant.counters.callbacksFailed === 0
    && tenant.audit.scopedCallbacks === 2 && tenant.audit.userLookups >= 2
    && tenant.tasks.every((task) => task.enterpriseId === CONTOSO), 'ghe_tenant_callbacks_scoped',
  { counters: tenant.counters, audit: tenant.audit });

  // A new caller lands on the enterprise with an eligible idle member; default has one, contoso two.
  let caller;
  let lease;
  for (const name of ['mysql-multi-a', 'mysql-multi-b']) {
    const callerId = `sha256:${h.smoke.hash(name)}`;
    const marker = `POOL_TEST:${JSON.stringify({ id: `admit-${name}` })}`;
    const options = h.smoke.inferOptions(callerId, '/v1/messages', marker);
    h.smoke.successful(await h.smoke.request('proxy', '/v1/messages', options), '/v1/messages', false);
    const response = await api('proxy', `/api/enterprises/${CONTOSO}/user-pool/leases`);
    const leases = h.smoke.status(response, 200, 'leases').data.items;
    lease = leases.find((row) => row.callerKeyHash === callerId);
    if (lease) {
      caller = callerId;
      break;
    }
  }
  ensure(caller && h.contosoMembers.includes(lease.memberIdentity), 'no_caller_admitted_to_new_enterprise');
  for (const [n, path] of ['/v1/messages', '/chat/completions', '/responses'].entries()) {
    for (const stream of [false, true]) {
      const id = `contoso-${n}-${stream}`;
      const options = h.smoke.inferOptions(caller, path, `POOL_TEST:${JSON.stringify({ id })}`, stream);
      h.smoke.successful(await h.smoke.request(stream ? 'proxy2' : 'proxy', path, options), path, stream);
    }
  }
  const state = await h.smoke.mock();
  const markers = state.tenants[CONTOSO].inference.filter((row) => row.marker?.startsWith('contoso-'));
  check(markers.length === 6
    && markers.every((row) => row.identity === lease.memberIdentity && row.outcome === 'complete')
    && !state.inference.some((row) => row.marker?.startsWith('contoso-')), 'inference_through_new_enterprise',
  { requests: markers.length });
  await pauseDrain('candidate');
  const stats = await query('SELECT identity, enterprise_id FROM proxy_request_stats WHERE caller_id=?', [caller]);
  check(stats.length >= 7
    && stats.every((row) => row.enterprise_id === CONTOSO && row.identity === lease.memberIdentity),
    'new_enterprise_stats_scoped', { rows: stats.length });
  h.contosoLease = lease;
}

async function crossTenantChecks() {
  const callerOne = `sha256:${h.smoke.hash('mysql-smoke-1')}`;
  const defaultMember = h.candidateSnapshot.leases.find((row) => row.caller_id === callerOne);
  const memberD = defaultMember.member_identity;
  const memberC = h.contosoLease.memberIdentity;
  const accountsBefore = await query('SELECT identity, SHA2(copilot_oauth_token,256) AS t, copilot_oauth_status AS s,'
    + ' copilot_oauth_attempt_id AS a, enterprise_id AS e FROM proxy_accounts ORDER BY identity');
  const tokenBody = () => ({ oauthAttemptId: randomUUID(), copilotOauthToken: 'synthetic-wrong-enterprise-token' });
  const wrong = [
    await api('proxy', `/internal/enterprises/${CONTOSO}/accounts/${memberD}/copilot-oauth-token`,
      { method: 'PUT', body: tokenBody() }),
    await api('proxy2', `/internal/enterprises/default/accounts/${memberC}/copilot-oauth-token`,
      { method: 'PUT', body: tokenBody() }),
    await api('proxy', `/internal/enterprises/${CONTOSO}/accounts/${memberD}/oauth-attempts/${randomUUID()}/prepare`, {
      method: 'POST', body: { ssoUser: memberD, ghLogin: 'synthetic', ssoType: 'custom', previousAttemptId: null },
    }),
    await api('proxy', `/internal/enterprises/${CONTOSO}/accounts/${memberD}/login-task-protection`),
  ];
  const accountsAfter = await query('SELECT identity, SHA2(copilot_oauth_token,256) AS t, copilot_oauth_status AS s,'
    + ' copilot_oauth_attempt_id AS a, enterprise_id AS e FROM proxy_accounts ORDER BY identity');
  check(wrong.every((response) => response.status === 404) && lib.sha(accountsBefore) === lib.sha(accountsAfter),
    'wrong_enterprise_callback_404', { statuses: wrong.map((response) => response.status) });

  const defaultLease = h.candidateSnapshot.leases[0];
  const management = [
    await api('proxy', `/api/enterprises/${CONTOSO}/accounts/${memberD}`),
    await api('proxy', `/api/enterprises/${CONTOSO}/user-pool/accounts/${memberD}/disable`,
      { method: 'POST', body: {} }),
    await api('proxy', `/api/enterprises/${CONTOSO}/user-pool/leases/${defaultLease.lease_id}/release`, {
      method: 'POST', body: { confirm: true },
    }),
  ];
  const [leaseRow] = await query('SELECT lease_id FROM user_pool_leases WHERE lease_id=?', [defaultLease.lease_id]);
  const [memberRow] = await query('SELECT state FROM user_pool_accounts WHERE identity=?', [memberD]);
  check(management.every((response) => response.status === 404) && leaseRow && memberRow?.state !== 'disabled',
    'wrong_enterprise_management_404', { statuses: management.map((response) => response.status) });

  const [unknownSso, unknownSsoApi, unknownLogin] = await probe([
    { target: 'sso', path: '/enterprises/nope-x/metadata' },
    { target: 'sso', path: '/api/enterprises/nope-x/users', headers: probeToken() },
    { target: 'login', path: '/api/enterprises/nope-x/tasks', headers: probeToken() },
  ]);
  const unknownProxy = await api('proxy', '/api/enterprises/nope-x/user-pool/summary');
  const unknownInternal = await api('proxy', `/internal/enterprises/nope-x/accounts/${memberD}/copilot-oauth-token`,
    { method: 'PUT', body: tokenBody() });
  check([unknownSso, unknownSsoApi, unknownLogin, unknownProxy, unknownInternal].every((row) => row.status === 404),
    'unknown_enterprise_404');

  await sameNameAndCookies(memberD);

  const token = { 'x-internal-token': internal()['X-Internal-Token'] };
  const unscoped = [
    await api('proxy', '/api/user-pool/summary'),
    await api('proxy', '/api/request-stats'),
    await api('proxy', `/internal/accounts/${memberD}/copilot-oauth-token`, { method: 'PUT', body: tokenBody() }),
    ...await probe([
      { target: 'sso', path: '/api/users', headers: token },
      { target: 'sso', method: 'POST', path: `/internal/users/${memberD}/login-credentials`, headers: token, body: {} },
      { target: 'login', path: '/api/tasks', headers: token },
    ]),
    await consoleGet('/api/console/proxy/user-pool/summary'),
  ];
  const code = (row) => row.data?.error?.code ?? row.json?.error?.code;
  check(unscoped.every((row) => row.status === 400 && code(row) === 'enterprise_scope_required'), 'unscoped_paths_400',
    { statuses: unscoped.map((row) => row.status) });

  const accounts = await query('SELECT identity, SHA2(copilot_oauth_token,256) AS t FROM proxy_accounts'
    + " WHERE enterprise_id='default'"
    + ' ORDER BY identity');
  const leases = await query('SELECT caller_id, lease_id FROM user_pool_leases');
  const mock = await h.smoke.mock();
  const defaultLeasesKept = h.candidateSnapshot.leases
    .every((row) => leases.some((lease) => lease.lease_id === row.lease_id));
  check(accounts.length === 3 && accounts.every((row) => h.candidateSnapshot.accounts.includes(row.identity))
    && defaultLeasesKept && mock.counters.scimCreates === h.baseline.counters.scimCreates
    && mock.counters.taskPosts === h.baseline.counters.taskPosts, 'default_tenant_untouched');
}

/** Same SSO user name in two enterprises, cookie swaps and forged enterprise claims (design §5.5). */
async function sameNameAndCookies(name) {
  const token = { 'x-internal-token': internal()['X-Internal-Token'] };
  const contosoLogin = `/enterprises/${CONTOSO}/login`;
  const [created, defaultUser, contosoUser] = await probe([
    { target: 'sso', method: 'POST', path: `/api/enterprises/${CONTOSO}/users`, headers: token,
      body: { ssoUser: name, password: SAME_NAME_PASSWORD } },
    { target: 'sso', path: `/api/enterprises/default/users/${name}`, headers: token },
    { target: 'sso', path: `/api/enterprises/${CONTOSO}/users/${name}`, headers: token },
  ]);
  const crossDefault = await ssoLogin(contosoLogin, name, SSO_DEFAULT_PASSWORD);
  const crossContoso = await ssoLogin('/login', name, SAME_NAME_PASSWORD);
  const ownContoso = await ssoLogin(contosoLogin, name, SAME_NAME_PASSWORD);
  const ownDefault = await ssoLogin('/login', name, SSO_DEFAULT_PASSWORD);
  check(created.status === 201 && defaultUser.status === 200 && contosoUser.status === 200
    && defaultUser.json?.createdAt !== contosoUser.json?.createdAt
    && defaultUser.json?.ghLogin !== contosoUser.json?.ghLogin
    && crossDefault.status === 401 && crossContoso.status === 401
    && ownContoso.status === 200 && ownDefault.status === 200,
  'same_name_sso_user_isolated', { statuses: [created.status, crossDefault.status, crossContoso.status,
    ownContoso.status, ownDefault.status] });

  const contosoName = `sso_session_${CONTOSO}`;
  const defaultCookie = lib.cookieHeader(ownDefault.cookies, 'sso_session');
  const contosoCookie = lib.cookieHeader(ownContoso.cookies, contosoName);
  const outcomes = {
    defaultOwn: await samlWith('/sso', defaultCookie, '/login'),
    contosoOwn: await samlWith(`/enterprises/${CONTOSO}/sso`, contosoCookie, contosoLogin),
    defaultAsContoso: await samlWith(`/enterprises/${CONTOSO}/sso`, lib.renameCookie(ownDefault.cookies, 'sso_session',
      contosoName), contosoLogin),
    contosoAsDefault: await samlWith('/sso', lib.renameCookie(ownContoso.cookies, contosoName, 'sso_session'),
      '/login'),
  };
  check(outcomes.defaultOwn === 'saml_response' && outcomes.contosoOwn === 'saml_response'
    && outcomes.defaultAsContoso === 'login_redirect' && outcomes.contosoAsDefault === 'login_redirect',
  'sso_cookie_swap_rejected', outcomes);

  const contosoSecret = lib.CONTOSO_SECRETS['contoso/session-secret'];
  const defaultCreated = defaultUser.json?.createdAt;
  const contosoCreated = contosoUser.json?.createdAt;
  const forged = {
    // Control: a correctly signed default cookie for the default user must work, so the negatives are meaningful.
    control: await samlWith('/sso', lib.forgeSessionCookie('sso_session',
      { e: 'default', user: { ssoUser: name, createdAt: defaultCreated } }, SSO_SESSION_SECRET), '/login'),
    defaultClaimOnContoso: await samlWith(`/enterprises/${CONTOSO}/sso`, lib.forgeSessionCookie(contosoName,
      { e: 'default', user: { ssoUser: name, createdAt: contosoCreated } }, contosoSecret), contosoLogin),
    contosoClaimOnDefault: await samlWith('/sso', lib.forgeSessionCookie('sso_session',
      { e: CONTOSO, user: { ssoUser: name, createdAt: defaultCreated } }, SSO_SESSION_SECRET), '/login'),
    contosoSecretOnDefault: await samlWith('/sso', lib.forgeSessionCookie('sso_session',
      { e: 'default', user: { ssoUser: name, createdAt: defaultCreated } }, contosoSecret), '/login'),
  };
  check(forged.control === 'saml_response' && forged.defaultClaimOnContoso === 'login_redirect'
    && forged.contosoClaimOnDefault === 'login_redirect' && forged.contosoSecretOnDefault === 'login_redirect',
  'sso_forged_enterprise_claim_rejected', forged);
}

async function step5() {
  await runStep('step5', async () => {
    const exits = await stopApps();
    check(exits.every((row) => !row.running && !row.oom && row.code === 0), 'candidate_applications_stopped',
      { exits });
    await h.db?.end().catch(() => {});
    h.db = undefined;
    const dump = await readFile(h.dump.path, 'utf8');
    ensure(lib.sha(dump) === h.dump.sha256, 'backup_dump_changed');
    await mysqlRoot(lib.restorePreamble(DATABASE) + dump, { database: '', timeout: 300000 });
    h.db = await connectFixtureDatabase('observer');
    const tables = (await query('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()'))
      .map((row) => row.t);
    check(!tables.includes('proxy_enterprises') && tables.includes('proxy_accounts'), 'mysql_restored_from_dump');
    const restored = await volumeCopy('restore', lib.MYSQL_APP_VOLUMES);
    check(Object.entries(restored).every(([key, row]) => row.live.sha256 === h.volumeBackup[key].live.sha256),
      'volumes_restored_from_backup', { volumes: restored });
    h.files = phaseFiles('legacy');
    await startApps('baseline');
    await verifyOwnedContainers('baseline');
    await h.smoke.health();
    check(JSON.stringify(await infrastructureIds()) === JSON.stringify(h.infra), 'r4_restarted_healthy');
    const after = await logicalSnapshot({ expectLeaseMinutes: 15 });
    const differences = lib.snapshotDifferences(h.baseline, after, lib.ROLLBACK_STABLE_HASHES);
    check(differences.length === 0 && after.configFingerprint === h.baseline.configFingerprint,
      'rollback_snapshot_equals_baseline', { differences, after: after.public });
    const columns = await query("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()"
      + " AND COLUMN_NAME='enterprise_id'");
    check(Number(columns[0].n) === 0 && !after.migrations.some((id) => id.startsWith('enterprise-v1/')),
      'rollback_has_no_enterprise_schema');
    check(await scheduler(h.baseline.ownerHash), 'rollback_replacement_scheduler_owner');
    h.runtime.rollback = await runtime('rollback', 'unscoped');
    const problems = persistenceProblems(h.runtime.baseline, h.runtime.rollback, { exact: true });
    check(problems.length === 0, 'rollback_runtime_and_persistence', { problems });
    const me = await consoleGet('/api/console/me');
    const saml = await samlWith('/sso', h.secrets.r4SsoCookie, '/login');
    check(me.status === 200 && saml === 'saml_response', 'rollback_console_and_sso_sessions',
      { console: me.status, saml });
    const result = await protocol(after, 'rollback', 'baseline');
    check(result.bound && result.shape && result.sameLease && !result.enterpriseColumn, 'rollback_same_lease_protocol',
      result);
    h.rollbackSnapshot = after;
  });
}

async function processlist() {
  const result = await mysqlRoot('SELECT ID, USER, COALESCE(STATE,\'\'), LEFT(COALESCE(INFO,\'\'), 120)'
    + ' FROM information_schema.PROCESSLIST;', { database: '', timeout: 60000 });
  // Empty trailing columns must survive: never trim the lines themselves.
  return result.stdout.split(/\r?\n/).filter((line) => /^\d+\t/.test(line)).map((line) => {
    const [id, user = '', state = '', info = ''] = line.split('\t');
    return { id: Number(id), user, state, info };
  });
}

async function step7() {
  await runStep('step7', async () => {
    const exits = await stopApps();
    check(exits.every((row) => !row.running), 'r4_applications_stopped', { exits });
    const rounds = Number(process.env.RELEASE_QUALIFICATION_STATS_DOUBLINGS ?? 10);
    const columns = await columnsOf('proxy_request_stats');
    const [{ n: beforeRows }] = await query('SELECT COUNT(*) AS n FROM proxy_request_stats');
    const inflateStarted = Date.now();
    await mysqlRoot(lib.statsInflationSql(columns, rounds).join('\n'), { timeout: 300000 });
    const [{ n: afterRows }] = await query('SELECT COUNT(*) AS n FROM proxy_request_stats');
    check(Number(afterRows) === Number(beforeRows) * 2 ** rounds, 'stats_table_inflated',
      { rows: Number(afterRows), rounds, inflateMs: Date.now() - inflateStarted });

    // Hold a metadata lock on the stats table so the candidate's migration blocks inside step 05.
    const holder = mysqlRoot('LOCK TABLES proxy_request_stats READ;\nSELECT SLEEP(240);\n',
      { timeout: 300000, optional: true });
    holder.catch(() => {});
    await h.smoke.poll('migration_lock_holder', processlist,
      (rows) => rows.some((row) => row.info.startsWith('SELECT SLEEP(240)')), 60000);
    const migrationStarted = Date.now();
    await startApps('candidate', ['proxy'], { wait: false });
    let blocked;
    const deadline = Date.now() + 120000;
    while (!blocked && Date.now() < deadline) {
      blocked = (await processlist()).find((row) => /^ALTER TABLE proxy_request_stats/.test(row.info)
        && /metadata lock/i.test(row.state));
      if (!blocked) await new Promise((done) => setTimeout(done, 1000));
    }
    const recordedWhileBlocked = (await query('SELECT id FROM schema_migrations ORDER BY id')).map((row) => row.id);
    check(blocked && lib.isMidMigrationCrashState(recordedWhileBlocked), 'migration_blocked_mid_step',
      { state: blocked?.state ?? null, info: blocked?.info ?? null, recorded: recordedWhileBlocked,
        waitedMs: Date.now() - migrationStarted });
    await compose(['kill', '-s', 'SIGKILL', 'proxy'], { timeout: 60000 });
    const [killed] = await inspect(await containerIds(['proxy']));
    check(!killed.State.Running && killed.State.ExitCode === 137, 'proxy_killed_mid_migration',
      { exitCode: killed.State.ExitCode });

    // The killed replica's MySQL sessions (and its migration lock) end as a lost connection would end them. They go
    // first: releasing the table lock while its ALTER still waits would let that ALTER finish after the "crash".
    const sessions = (await processlist()).filter((row) => row.user === 'pool_fixture');
    await mysqlRoot(sessions.map((row) => `KILL ${Number(row.id)};`).join('\n'), { database: '', optional: true });
    await h.smoke.poll('orphan_migration_gone', processlist,
      (rows) => !rows.some((row) => row.user === 'pool_fixture'), 30000);
    const holders = (await processlist()).filter((row) => row.info.startsWith('SELECT SLEEP(240)'));
    await mysqlRoot(holders.map((row) => `KILL ${Number(row.id)};`).join('\n'), { database: '', optional: true });
    await holder;
    const recorded = (await query('SELECT id FROM schema_migrations ORDER BY id')).map((row) => row.id);
    const statsColumn = (await columnsOf('proxy_request_stats')).includes('enterprise_id');
    check(lib.isMidMigrationCrashState(recorded) && !statsColumn, 'partial_migration_recorded',
      { recorded, statsEnterpriseColumn: statsColumn, killedSessions: sessions.length });

    const restartStarted = Date.now();
    await startApps('candidate', ['proxy']);
    const migrations = (await query('SELECT id FROM schema_migrations ORDER BY id')).map((row) => row.id);
    const missing = lib.missingMigrationIds(migrations, lib.expectedProxyMigrationIds('mysql'));
    check(missing.length === 0, 'restart_completes_all_migration_ids',
      { missing, restartMs: Date.now() - restartStarted });
    const backfill = await enterpriseBackfill(h.baseline.maxEventId);
    const [defaultRow] = await query("SELECT state, inventory_count FROM proxy_enterprises WHERE id='default'");
    check(Object.values(backfill).every((row) => row.total === row.default) && await enterpriseColumnsFailClosed()
      && defaultRow?.state === 'active' && Number(defaultRow.inventory_count) === 3, 'crash_recovery_backfill_complete',
    { backfill });
    await startApps('candidate', ['proxy2', 'sso', 'login', 'console']);
    await h.smoke.health();
    const snapshot = await logicalSnapshot({ expectLeaseMinutes: 5 });
    const result = await protocol(snapshot, 'crash-recovery', 'candidate');
    check(result.bound && result.shape && result.sameLease, 'crash_recovery_protocol', result);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// SQLite steps (step 6)

const SQLITE_TOKEN = { 'x-internal-token': 'release-fixture-internal' };
const SQLITE_MEMBER = 'release-member';

function sqliteInference(stream = false) {
  return { target: 'proxy', method: 'POST', path: '/v1/messages', headers: {
    authorization: 'Bearer release-fixture-api', 'x-user-identity': SQLITE_MEMBER, 'x-claude-code-optimized': 'true',
    'anthropic-version': '2023-06-01',
  }, body: {
    model: 'claude-opus-5-5', max_tokens: 64, stream, messages: [{ role: 'user', content: 'Synthetic question' }],
  } };
}

async function sqliteSnapshots(services = ['proxy', 'sso', 'login']) {
  const result = {};
  for (const service of services) {
    const path = `/data/${service}.sqlite`;
    const script = '/qualification/multi-sqlite-snapshot.mjs';
    const output = await compose(['exec', '-T', service, 'node', script, service, path],
      { timeout: 90000, optional: true });
    const line = lib.lastJsonLine(output.stdout, (value) => value.component === service);
    ensure(output.code === 0 && line?.snapshot === true && line.integrity === 'ok',
      `sqlite_snapshot_${service}_failed`);
    result[service] = line;
  }
  return result;
}

async function preflightSqlite() {
  h.files = phaseFiles('sqlite');
  check(await freshProject(), 'fresh_project_and_volumes');
  const config = await renderConfig(h.files);
  const problems = lib.composeViolations(config, { project: PROJECT, services: lib.SQLITE_ALL, apps: lib.SQLITE_APPS });
  check(problems.length === 0, 'compose_isolated_sqlite', { problems });
  h.configs.sqlite = config;
  h.volumeNames = Object.fromEntries(Object.entries(config.volumes).map(([key, volume]) => [key, volume.name]));
  await inspectImages();
  check(true, 'images_present_locally', { images: Object.keys(h.report.images) });
  h.owned = true;
}

async function sqliteBaseline() {
  await runStep('step6-baseline', async () => {
    h.current = 'baseline';
    await compose(['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '300'],
      { timeout: 330000 });
    await verifyOwnedContainers('baseline');
    const health = await probe([
      { target: 'proxy', path: '/readyz' }, { target: 'sso', path: '/healthz' }, { target: 'login', path: '/healthz' },
      { target: 'console', path: '/healthz' },
    ]);
    check(health.every((row) => row.status === 200), 'sqlite_baseline_healthy');
    const [created, imported, json, sse, setup] = await probe([
      { target: 'sso', method: 'POST', path: '/api/users', headers: SQLITE_TOKEN,
        body: { ssoUser: SQLITE_MEMBER, password: 'release-fixture-password-only',
          email: 'release-member@example.test' } },
      { target: 'proxy', method: 'POST', path: '/api/accounts/copilot-oauth-token/import', headers: SQLITE_TOKEN,
        body: { csvText: `name,copilotOauthToken\n${SQLITE_MEMBER},release-fixture-oauth\n` } },
      sqliteInference(false),
      sqliteInference(true),
      { target: 'console', method: 'POST', path: '/api/console/setup', body: CONSOLE_ADMIN },
    ]);
    const login = await ssoLogin('/login', SQLITE_MEMBER, 'release-fixture-password-only');
    h.secrets.r4SsoCookie = lib.cookieHeader(login.cookies, 'sso_session');
    h.secrets.consoleCookie = (setup.headers?.['set-cookie'] ?? []).map((line) => line.split(';', 1)[0]).join('; ');
    await saveSecrets();
    check(created.status === 201 && imported.status === 200 && imported.json?.summary?.success === 1
      && json.status === 200 && sse.status === 200 && login.status === 200 && h.secrets.r4SsoCookie
      && [200, 201].includes(setup.status) && h.secrets.consoleCookie, 'sqlite_baseline_seeded',
    { statuses: [created.status, imported.status, json.status, sse.status, login.status, setup.status] });
    h.sqliteBaseline = await sqliteSnapshots();
    const proxyTables = h.sqliteBaseline.proxy.logicalTables;
    check(proxyTables.proxy_accounts?.rows.length === 1 && proxyTables.proxy_request_stats?.rows.length === 2,
      'sqlite_baseline_snapshot', { proxyMigrations: h.sqliteBaseline.proxy.migrations.length });
    await stopApps();
    await execute(['volume', 'create', '--label', `ghcp.qualification=${PROJECT}`, BACKUP_VOLUME]);
    h.volumeBackup = await volumeCopy('backup', lib.SQLITE_APP_VOLUMES);
    check(Object.values(h.volumeBackup).every((row) => row.live.sha256 === row.backup.sha256), 'sqlite_baseline_backup',
      { volumes: h.volumeBackup });
  });
}

async function sqliteCandidate() {
  await runStep('step6-candidate', async () => {
    await startApps('candidate');
    await verifyOwnedContainers('candidate');
    check(true, 'sqlite_candidate_healthy');
    const after = await sqliteSnapshots();
    const pick = (snapshot, tables) => Object.fromEntries(tables
      .map((table) => [table, snapshot.proxy.logicalTables[table]]));
    const core = ['proxy_accounts', 'proxy_request_stats'];
    const problems = [
      ...lib.tableDiff(pick(h.sqliteBaseline, core), pick(after, core)).map((problem) => `proxy_${problem}`),
      ...lib.tableDiff(h.sqliteBaseline.sso.logicalTables, after.sso.logicalTables).map((problem) => `sso_${problem}`),
      ...lib.tableDiff(h.sqliteBaseline.login.logicalTables, after.login.logicalTables)
        .map((problem) => `login_${problem}`),
    ];
    const observed = lib.tableDiff(h.sqliteBaseline.proxy.logicalTables, after.proxy.logicalTables)
      .filter((problem) => !core.some((table) => problem.endsWith(table)));
    check(problems.length === 0, 'sqlite_rows_preserved', { problems, observedOtherProxyTables: observed });
    const backfill = { proxy: after.proxy.enterprise, sso: after.sso.enterprise, login: after.login.enterprise };
    const complete = Object.values(backfill).flatMap((tables) => Object.values(tables))
      .every((row) => row.missing === 0 && row.default === row.total);
    check(complete && after.proxy.enterprise.proxy_accounts?.total === 1, 'sqlite_enterprise_default_backfilled',
      backfill);
    const missing = {
      proxy: lib.missingMigrationIds(after.proxy.migrations, lib.expectedProxyMigrationIds('sqlite-direct')),
      sso: lib.missingMigrationIds(after.sso.migrations, lib.SSO_MIGRATION_IDS),
      login: lib.missingMigrationIds(after.login.migrations, lib.LOGIN_MIGRATION_IDS),
    };
    check(Object.values(missing).every((ids) => ids.length === 0), 'sqlite_migration_ids_recorded', missing);
    const triggers = ['proxy_accounts_enterprise_required', 'proxy_accounts_enterprise_immutable',
      'proxy_request_stats_enterprise_required'];
    check(triggers.every((name) => after.proxy.triggers.includes(name))
      && after.login.triggers.includes('login_tasks_enterprise_required'), 'sqlite_fail_closed_triggers_present',
    { proxy: after.proxy.triggers, login: after.login.triggers });
    const [inference] = await probe([sqliteInference(false)]);
    const stats = await sqliteSnapshots();
    const statsRow = stats.proxy.enterprise.proxy_request_stats;
    // REQUEST_STATS_PER_ACCOUNT_LIMIT defaults to 2 (r4 and candidate), so the new row replaces the oldest one.
    const priorIds = new Set(after.proxy.logicalTables.proxy_request_stats.rows.map((row) => row.id));
    const added = stats.proxy.logicalTables.proxy_request_stats.rows.filter((row) => !priorIds.has(row.id)).length;
    check(inference.status === 200 && added === 1 && statsRow.missing === 0 && statsRow.default === statsRow.total,
      'sqlite_direct_inference_and_stats', { added, stats: statsRow });
    const [legacy, requestStats, scopedAccounts, ssoUnscoped, ssoScoped, loginUnscoped, loginScoped] = await probe([
      { target: 'proxy', path: '/api/accounts?page=1&pageSize=100', headers: SQLITE_TOKEN },
      { target: 'proxy', path: '/api/request-stats', headers: SQLITE_TOKEN },
      { target: 'proxy', path: '/api/enterprises/default/accounts?page=1&pageSize=100', headers: SQLITE_TOKEN },
      { target: 'sso', path: '/api/users', headers: SQLITE_TOKEN },
      { target: 'sso', path: '/api/enterprises/default/users?page=1&pageSize=100', headers: SQLITE_TOKEN },
      { target: 'login', path: '/api/tasks', headers: SQLITE_TOKEN },
      { target: 'login', path: '/api/enterprises/default/tasks?page=1&pageSize=100', headers: SQLITE_TOKEN },
    ]);
    check(legacy.status === 200 && legacy.headers.deprecation === 'true'
      && JSON.stringify(legacy.json).includes(SQLITE_MEMBER), 'sqlite_legacy_accounts_deprecated');
    check([requestStats, ssoUnscoped, loginUnscoped].every((row) => row.status === 400
      && row.json?.error?.code === 'enterprise_scope_required')
      && [scopedAccounts, ssoScoped, loginScoped].every((row) => row.status === 200) && ssoScoped.json?.total === 1,
    'sqlite_unscoped_400_scoped_200');
    const saml = await samlWith('/sso', h.secrets.r4SsoCookie, '/login');
    const [me] = await probe([
      { target: 'console', path: '/api/console/me', headers: { cookie: h.secrets.consoleCookie } },
    ]);
    check(saml === 'saml_response' && me.status === 200, 'sqlite_sessions_survive_upgrade',
      { saml, console: me.status });
    h.sqliteCandidate = stats;
  });
}

async function sqliteR4OnMigrated() {
  await runStep('step6-r4-on-migrated', async () => {
    await stopApps();
    await startApps('baseline', ['proxy'], { wait: false });
    const deadline = Date.now() + 90000;
    let container;
    let responses = null;
    do {
      await new Promise((done) => setTimeout(done, 2000));
      [container] = await inspect(await containerIds(['proxy']));
      if (container.State.Health?.Status === 'healthy') break;
    } while (container.State.Running && Date.now() < deadline);
    if (container.State.Running) {
      responses = await probe([
        sqliteInference(false),
        { target: 'proxy', method: 'POST', path: '/api/accounts/copilot-oauth-token/import', headers: SQLITE_TOKEN,
          body: { csvText: 'name,copilotOauthToken\nrelease-member-2,release-fixture-oauth-2\n' } },
      ]);
    }
    await stopApps(['proxy']);
    const image = `${h.state.candidate.prefix}-proxy:${h.state.candidate.tag}`;
    const { code, line } = await helper({
      image,
      mounts: [`type=volume,source=${h.volumeNames['proxy-data']},target=/data`,
        `type=bind,source=${join(h.state.directory, 'fixtures')},target=/qualification,readonly`],
      args: ['/qualification/multi-sqlite-snapshot.mjs', 'proxy', '/data/proxy.sqlite'],
      phase: 'candidate',
    });
    ensure(code === 0 && line?.snapshot === true, 'sqlite_offline_snapshot_failed');
    const before = h.sqliteCandidate.proxy.enterprise;
    const unchanged = Object.entries(line.enterprise).every(([table, row]) => row.missing === 0
      && (!before[table] || row.total === before[table].total));
    // Same rows (by hashed id) in the written tables: an r4 insert would add a row with a NULL enterprise_id.
    const ids = (snapshot, table) => JSON.stringify(snapshot.logicalTables[table].rows
      .map((row) => row.identity ?? row.id).sort());
    const sameRows = ['proxy_accounts', 'proxy_request_stats']
      .every((table) => ids(line, table) === ids(h.sqliteCandidate.proxy, table));
    check(unchanged && sameRows, 'sqlite_r4_writes_refused', {
      r4Started: Boolean(responses), r4ExitCode: container.State.ExitCode,
      r4Statuses: responses?.map((row) => row.status) ?? null,
      r4ImportSummary: responses?.[1]?.json?.summary ?? null, tables: line.enterprise,
    });
  });
}

async function sqliteRestore() {
  await runStep('step6-restore', async () => {
    const restored = await volumeCopy('restore', lib.SQLITE_APP_VOLUMES);
    ensure(Object.entries(restored).every(([key, row]) => row.live.sha256 === h.volumeBackup[key].live.sha256),
      'sqlite_volume_restore_mismatch');
    await startApps('baseline');
    await verifyOwnedContainers('baseline');
    const after = await sqliteSnapshots();
    const problems = ['proxy', 'sso', 'login'].flatMap((service) => lib.tableDiff(
      h.sqliteBaseline[service].logicalTables, after[service].logicalTables, { exact: true },
    ).map((problem) => `${service}_${problem}`));
    check(problems.length === 0 && after.proxy.migrations.every((id) => !id.startsWith('enterprise-v1/')),
      'sqlite_restored_exact', { problems });
    const [inference] = await probe([sqliteInference(false)]);
    const saml = await samlWith('/sso', h.secrets.r4SsoCookie, '/login');
    check(inference.status === 200 && saml === 'saml_response', 'sqlite_r4_inference_after_restore');
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Fresh single-enterprise deployment (multi-fresh, multi-fresh-dba: MySQL + two replicas; multi-fresh-sqlite:
// SQLite direct mode). Empty databases and volumes, no registry: `default` is synthesized from the environment.

const PROTOCOLS = ['/v1/messages', '/chat/completions', '/responses'];
const FRESH_CALLER = 'fresh-caller-a';
const FRESH_OTHER_CALLER = 'fresh-caller-b';
const FRESH_POOL_IDLE_TARGET = 3;
const SQLITE_PASSWORD = 'release-fixture-password-only';
const INITIAL_SQL = 'scripts/proxy-mysql-initial.sql';

const freshSqlite = () => lib.isSqliteMode(h.mode);
/** The internal token of the environment (MySQL and SQLite fixtures use different synthetic values). */
const freshToken = () => (freshSqlite() ? SQLITE_TOKEN : probeToken());
const errorCode = (row) => row.json?.error?.code ?? row.data?.error?.code;
const cookiesOf = (response) => (response.headers?.['set-cookie'] ?? []).map((line) => line.split(';', 1)[0])
  .join('; ');

async function preflightFresh() {
  check(await freshProject(), 'fresh_project_and_volumes');
  const config = await renderConfig(h.files);
  const registry = lib.registryReferences(config);
  if (freshSqlite()) {
    const problems = lib.composeViolations(config, { project: PROJECT, services: lib.SQLITE_ALL,
      apps: lib.SQLITE_APPS });
    check(problems.length === 0 && registry.length === 0, 'compose_isolated_sqlite', { problems, registry });
  } else {
    const problems = lib.composeViolations(config, { project: PROJECT, services: lib.MYSQL_ALL, apps: lib.APPS,
      bridgePorts: 5 });
    const autoMigrate = ['proxy', 'proxy2'].map((service) => config.services[service].environment.MYSQL_AUTO_MIGRATE
      ?? null);
    const expected = h.mode === 'multi-fresh-dba' ? 'false' : null;
    check(problems.length === 0 && registry.length === 0 && autoMigrate.every((value) => value === expected),
      'compose_isolated_fresh', { problems, registry, autoMigrate });
  }
  h.configs.fresh = config;
  h.volumeNames = Object.fromEntries(Object.entries(config.volumes).map(([key, volume]) => [key, volume.name]));
  await inspectImages([h.state.candidate]);
  check(true, 'images_present_locally', { images: Object.keys(h.report.images) });
  check(candidateDefaults(), 'candidate_shipped_defaults');
  h.owned = true;
  if (!freshSqlite()) check(await legacyCommandCheck(), 'candidate_legacy_command_starts_and_stops_cleanly');
}

/** Tables of the Proxy database, read as root inside the MySQL container (the bridge is not up yet). */
async function rootTables() {
  const result = await mysqlRoot(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='${DATABASE}'`
    + ' ORDER BY TABLE_NAME;', { database: '' });
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

/** Columns, indexes, constraints and triggers of the Proxy database, hashed (root, inside the MySQL container). */
async function rootSchemaFingerprint() {
  const where = `WHERE TABLE_SCHEMA='${DATABASE}'`;
  const result = await mysqlRoot([
    'SELECT TABLE_NAME,COLUMN_NAME,ORDINAL_POSITION,COLUMN_TYPE,IS_NULLABLE,COALESCE(COLUMN_DEFAULT,\'<null>\'),'
      + `COALESCE(COLLATION_NAME,''),EXTRA FROM information_schema.COLUMNS ${where} ORDER BY 1,3;`,
    'SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COALESCE(COLUMN_NAME,\'\') FROM information_schema.STATISTICS'
      + ` ${where} ORDER BY 1,2,4;`,
    `SELECT TABLE_NAME,CONSTRAINT_NAME,CONSTRAINT_TYPE FROM information_schema.TABLE_CONSTRAINTS ${where} ORDER BY 1,2;`,
    'SELECT TRIGGER_NAME,EVENT_OBJECT_TABLE,ACTION_TIMING,EVENT_MANIPULATION FROM information_schema.TRIGGERS'
      + ` WHERE TRIGGER_SCHEMA='${DATABASE}' ORDER BY 1;`,
  ].join('\n'), { database: '' });
  return lib.sha(result.stdout);
}

async function rootMigrationIds() {
  const result = await mysqlRoot('SELECT id FROM schema_migrations ORDER BY id;');
  return result.stdout.split(/\r?\n/).filter(Boolean).sort();
}

async function freshDbaSchema() {
  await runStep('fresh-dba-schema', async () => {
    h.current = 'candidate';
    await compose(['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '400', 'mysql', 'mock'],
      { timeout: 430000 });
    const empty = await rootTables();
    check(empty.length === 1 && empty[0] === 'fixture_identity', 'mysql_database_empty', { tables: empty });

    const script = await readFile(join(ROOT, INITIAL_SQL), 'utf8');
    // The mysql client of the official image defaults to a latin1 session (POSIX locale); string literals of the
    // CHECK constraints then carry `_latin1` introducers, which r2's MYSQL_AUTO_MIGRATE=false validator rejects
    // ("proxy_enterprises check constraints"). A utf8mb4 session is what Proxy's own migrations and the
    // integration test use (see docs/multi-enterprise-release-validation.md, fresh deployment findings).
    await mysqlRoot(lib.initialSqlForDatabase(script, DATABASE),
      { database: '', timeout: 180000, clientCharset: 'utf8mb4' });
    const tables = await rootTables();
    const recorded = await rootMigrationIds();
    const scripted = lib.initialSqlMigrationIds(script);
    const [enterpriseRows] = (await mysqlRoot('SELECT COUNT(*) FROM proxy_enterprises;')).stdout.trim().split(/\s+/);
    const clauses = (await mysqlRoot('SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS'
      + ` WHERE CONSTRAINT_SCHEMA='${DATABASE}';`)).stdout;
    // Batch output escapes the clause's own `\'` once more, so any number of backslashes precedes the quote.
    const introducers = [...new Set([...clauses.matchAll(/_([a-z0-9]+)\\*'/g)].map((match) => match[1]))].sort();
    const expectedTables = ['proxy_accounts', 'proxy_enterprises', 'proxy_identity_initializations',
      'proxy_request_stats', 'schema_migrations', 'user_pool_accounts', 'user_pool_catalog_cooldowns',
      'user_pool_catalog_holds', 'user_pool_events', 'user_pool_holds', 'user_pool_leases', 'user_pool_settings'];
    check(expectedTables.every((table) => tables.includes(table)) && JSON.stringify(recorded) === JSON.stringify(scripted)
      && lib.missingMigrationIds(recorded, lib.expectedFreshMysqlMigrationIds()).length === 2
      && Number(enterpriseRows) === 0 && JSON.stringify(introducers) === '["utf8mb4"]', 'initial_sql_applied',
    { script: INITIAL_SQL, scriptSha256: lib.sha(script), clientCharset: 'utf8mb4', checkLiteralCharsets: introducers,
      tables: tables.length, recorded, defaultRows: enterpriseRows });
    h.report.findings.push({ kind: 'dba_initial_sql_client_charset', productChange: false,
      detail: 'Applied through the image mysql client in its default latin1 session, the CHECK literals carry _latin1'
        + ' introducers and Proxy with MYSQL_AUTO_MIGRATE=false refuses to start (proxy_enterprises check'
        + ' constraints). This run applies the script with --default-character-set=utf8mb4.',
      recommendation: 'Start the generated scripts with SET NAMES utf8mb4 (or document the client option), or let'
        + ' the validator accept any charset introducer on ASCII literals.' });

    await mysqlRoot(lib.dbaRuntimeGrantsSql(DATABASE, 'pool_fixture'), { database: '' });
    const grants = (await mysqlRoot("SHOW GRANTS FOR 'pool_fixture'@'%';", { database: '' })).stdout
      .split(/\r?\n/).filter(Boolean);
    const ddl = lib.ddlPrivileges(grants);
    const dml = grants.some((line) => /^GRANT SELECT, INSERT, UPDATE, DELETE ON `ghcp_pool_mysql_test`\.\*/.test(line));
    const trigger = grants.some((line) => /^GRANT TRIGGER ON `ghcp_pool_mysql_test`\.`proxy_accounts`/.test(line));
    check(ddl.length === 0 && dml && trigger, 'runtime_grants_dml_only', { grants, ddl });
    h.dba = { schemaBefore: await rootSchemaFingerprint(), migrationsBefore: recorded };
  });
}

/** `/healthz` of every application from inside the network: each must report releaseLine `multi`. */
async function freshReleaseLines() {
  const targets = freshSqlite() ? ['proxy', 'sso', 'login', 'console'] : ['proxy', 'proxy2', 'sso', 'login', 'console'];
  const results = await probe(targets.map((target) => ({ target, path: '/healthz' })));
  const lines = Object.fromEntries(targets.map((target, index) => [target, results[index].json?.releaseLine ?? null]));
  check(results.every((row) => row.status === 200) && Object.values(lines).every((line) => line === 'multi'),
    'release_line_multi', lines);
}

/** Exactly one row, `default`, in a snapshot's (value-hashed) enterprise table. */
const onlyDefault = (snapshot, table) => snapshot.logicalTables[table]?.rows.length === 1
  && snapshot.logicalTables[table].rows[0].id === lib.sha('default');

async function freshStartMysql() {
  await runStep('fresh-start', async () => {
    h.current = 'candidate';
    await compose(['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '400'], { timeout: 430000 });
    await verifyOwnedContainers('candidate');
    h.infra = await infrastructureIds();
    h.smoke = await import(pathToFileURL(join(h.state.directory, 'fixtures/mysql-smoke.mjs')).href);
    await h.smoke.health();
    h.db = await connectFixtureDatabase('observer');
    check(true, 'fresh_services_healthy');
    await freshReleaseLines();

    const services = await sqliteSnapshots(['sso', 'login']);
    const migrations = (await query('SELECT id FROM schema_migrations ORDER BY id')).map((row) => row.id).sort();
    const expected = lib.expectedFreshMysqlMigrationIds();
    const missing = {
      proxy: lib.missingMigrationIds(migrations, expected),
      unexpectedProxy: migrations.filter((id) => !expected.includes(id)),
      sso: lib.missingMigrationIds(services.sso.migrations, lib.SSO_MIGRATION_IDS),
      login: lib.missingMigrationIds(services.login.migrations, lib.LOGIN_MIGRATION_IDS),
    };
    check(Object.values(missing).every((ids) => ids.length === 0), 'fresh_migration_ids_complete',
      { ...missing, proxyMigrations: migrations });
    if (h.mode === 'multi-fresh-dba') {
      const schemaAfter = await rootSchemaFingerprint();
      const added = migrations.filter((id) => !h.dba.migrationsBefore.includes(id));
      check(schemaAfter === h.dba.schemaBefore
        && JSON.stringify(added) === JSON.stringify([lib.PROXY_MIGRATION_IDS[1], lib.PROXY_MIGRATION_IDS[7]]),
      'dba_startup_no_ddl', { schemaUnchanged: schemaAfter === h.dba.schemaBefore, addedByProxy: added });
    }
    check(await enterpriseColumnsFailClosed(), 'fresh_enterprise_columns_fail_closed', h.failClosed);

    const cap = Number(h.configs.fresh.services.proxy.environment.POOL_MAX_ACCOUNTS);
    const rows = await query('SELECT id,state,max_accounts,inventory_count,policy_version,profile_fingerprint'
      + ' FROM proxy_enterprises ORDER BY id');
    const lists = [await enterprisesList('proxy'), await enterprisesList('proxy2')];
    const listed = (items) => items.length === 1 && items[0].id === 'default' && items[0].pool?.state === 'active'
      && items[0].pool.maxAccounts === cap && items[0].pool.inventory === 0;
    check(rows.length === 1 && rows[0].id === 'default' && rows[0].state === 'active'
      && Number(rows[0].max_accounts) === cap && Number(rows[0].inventory_count) === 0
      && /^[a-f0-9]{64}$/.test(rows[0].profile_fingerprint ?? '') && lists.every(listed),
    'single_default_enterprise_active', {
      enterprises: rows.map(({ profile_fingerprint: _f, ...row }) => row),
      listed: lists.map((items) => items.map((item) => ({ id: item.id, pool: item.pool }))),
      readiness: lists[0][0]?.readiness ?? null,
    });
    check(onlyDefault(services.sso, 'sso_enterprises') && onlyDefault(services.login, 'login_enterprises'),
      'sso_login_single_default_enterprise', { sso: services.sso.logicalTables.sso_enterprises?.rows.length ?? null,
        login: services.login.logicalTables.login_enterprises?.rows.length ?? null });
    check(await scheduler(null), 'single_scheduler_owner_renewing');
  });
}

async function freshStartSqlite() {
  await runStep('fresh-start', async () => {
    h.current = 'candidate';
    await compose(['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '300'], { timeout: 330000 });
    await verifyOwnedContainers('candidate');
    const ready = await probe([{ target: 'proxy', path: '/readyz' }, { target: 'mock', path: '/healthz' }]);
    check(ready.every((row) => row.status === 200) && ready[0].json?.storage === 'sqlite', 'fresh_services_healthy');
    await freshReleaseLines();
    const snapshots = await sqliteSnapshots();
    const missing = {
      proxy: lib.missingMigrationIds(snapshots.proxy.migrations, lib.expectedProxyMigrationIds('sqlite-direct')),
      sso: lib.missingMigrationIds(snapshots.sso.migrations, lib.SSO_MIGRATION_IDS),
      login: lib.missingMigrationIds(snapshots.login.migrations, lib.LOGIN_MIGRATION_IDS),
    };
    check(Object.values(missing).every((ids) => ids.length === 0)
      && Object.values(snapshots).every((row) => row.integrity === 'ok'), 'sqlite_fresh_migration_ids_complete',
    { missing, proxyMigrations: snapshots.proxy.migrations });
    const triggers = ['proxy_accounts_enterprise_required', 'proxy_accounts_enterprise_immutable',
      'proxy_request_stats_enterprise_required'];
    check(triggers.every((name) => snapshots.proxy.triggers.includes(name))
      && snapshots.login.triggers.includes('login_tasks_enterprise_required'), 'sqlite_fail_closed_triggers_present',
    { proxy: snapshots.proxy.triggers, login: snapshots.login.triggers });
    const [list, pool] = await probe([
      { target: 'proxy', path: '/api/enterprises', headers: SQLITE_TOKEN },
      { target: 'proxy', path: '/api/enterprises/default/user-pool/summary', headers: SQLITE_TOKEN },
    ]);
    const items = list.json?.items ?? [];
    check(onlyDefault(snapshots.proxy, 'proxy_enterprises') && onlyDefault(snapshots.sso, 'sso_enterprises')
      && onlyDefault(snapshots.login, 'login_enterprises') && list.status === 200 && items.length === 1
      && items[0].id === 'default' && items[0].pool === null && items[0].poolSummary === null,
    'sqlite_single_default_enterprise', { listed: items.map((item) => ({ id: item.id, pool: item.pool })),
      poolSummaryInDirectMode: { status: pool.status, code: errorCode(pool) ?? null },
      proxyEnterpriseStateActive: snapshots.proxy.logicalTables.proxy_enterprises?.rows[0]?.state
        === lib.sha('active') });
  });
}

async function freshConsole() {
  await runStep('fresh-console', async () => {
    const [before, setup] = await probe([
      { target: 'console', path: '/api/console/setup' },
      { target: 'console', method: 'POST', path: '/api/console/setup', body: CONSOLE_ADMIN },
    ]);
    const setupCookie = cookiesOf(setup);
    const [me, after, again] = await probe([
      { target: 'console', path: '/api/console/me', headers: { cookie: setupCookie } },
      { target: 'console', path: '/api/console/setup' },
      { target: 'console', method: 'POST', path: '/api/console/setup',
        body: { username: 'second-fixture-admin', password: 'second-fixture-console-only' } },
    ]);
    check(before.status === 200 && before.json?.initialized === false && setup.status === 201 && setupCookie
      && me.status === 200 && me.json?.username === CONSOLE_ADMIN.username && after.json?.initialized === true
      && again.status === 400, 'console_first_run_setup',
    { statuses: [before.status, setup.status, me.status, after.status, again.status] });

    const [login, wrong, anonymous] = await probe([
      { target: 'console', method: 'POST', path: '/api/console/login', body: CONSOLE_ADMIN },
      { target: 'console', method: 'POST', path: '/api/console/login',
        body: { username: CONSOLE_ADMIN.username, password: 'wrong-fixture-password' } },
      { target: 'console', path: '/api/console/me' },
    ]);
    h.secrets.consoleCookie = cookiesOf(login);
    await saveSecrets();
    const [session] = await probe([
      { target: 'console', path: '/api/console/me', headers: { cookie: h.secrets.consoleCookie } },
    ]);
    check(login.status === 200 && h.secrets.consoleCookie && wrong.status === 401 && anonymous.status === 401
      && session.status === 200 && session.json?.username === CONSOLE_ADMIN.username, 'console_login',
    { statuses: [login.status, wrong.status, anonymous.status, session.status] });

    const cookie = { cookie: h.secrets.consoleCookie };
    const scopedProxy = freshSqlite() ? 'accounts?page=1&pageSize=100' : 'user-pool/summary';
    const [list, overview, users, tasks, stats, unscoped, unauthenticated] = await probe([
      { target: 'console', path: '/api/console/proxy/enterprises', headers: cookie },
      { target: 'console', path: `/api/console/proxy/enterprises/default/${scopedProxy}`, headers: cookie },
      { target: 'console', path: '/api/console/sso/enterprises/default/users?page=1&pageSize=100', headers: cookie },
      { target: 'console', path: '/api/console/login-service/enterprises/default/tasks?page=1&pageSize=100',
        headers: cookie },
      { target: 'console', path: '/api/console/proxy/enterprises/default/request-stats', headers: cookie },
      { target: 'console', path: '/api/console/proxy/request-stats', headers: cookie },
      { target: 'console', path: '/api/console/proxy/enterprises' },
    ]);
    const items = list.json?.items ?? [];
    check(list.status === 200 && items.length === 1 && items[0].id === 'default'
      && [overview, users, tasks, stats].every((row) => row.status === 200)
      && unscoped.status === 400 && errorCode(unscoped) === 'enterprise_scope_required'
      && unauthenticated.status === 401, 'console_default_enterprise_overview',
    { statuses: [list, overview, users, tasks, stats, unscoped, unauthenticated].map((row) => row.status),
      enterprises: items.map((item) => item.id) });
  });
}

async function defaultSummary(service = 'proxy') {
  return h.smoke.status(await api(service, '/api/enterprises/default/user-pool/summary'), 200, 'default_summary')
    .data;
}

async function freshPool() {
  await runStep('fresh-pool', async () => {
    const settings = await poolSettings('proxy', 'candidate');
    const summary = await defaultSummary();
    const initial = await h.smoke.mock();
    check(Number(settings.idle_target) === 0 && summary.counts.total === 0 && initial.users.length === 0
      && initial.tasks.length === 0 && initial.inference.length === 0, 'pool_fresh_settings',
    { settings: { idle_target: settings.idle_target, paused: settings.paused, lease_seconds: settings.lease_seconds },
      counts: summary.counts });

    // Provisioning is requested through the second replica; the scheduler owner may be either one.
    await patchSettings({ idle_target: FRESH_POOL_IDLE_TARGET, paused: 0 }, 'proxy2', 'candidate');
    const started = Date.now();
    const filled = await h.smoke.poll('fresh_replenishment', () => defaultSummary('proxy2'),
      (value) => value.counts.total === FRESH_POOL_IDLE_TARGET && value.counts.ready_idle === FRESH_POOL_IDLE_TARGET
        && value.counts.provisioning === 0, 300000);
    const fillMs = Date.now() - started;
    // Paused, so the SSO inventory stays at the idle target for the rest of the run (admission still works).
    await patchSettings({ paused: 1 }, 'proxy', 'candidate');
    const mock = await h.smoke.mock();
    const accounts = await query('SELECT p.identity, p.enterprise_id AS account_enterprise,'
      + ' p.copilot_oauth_status AS status, a.state, a.enterprise_id AS member_enterprise'
      + ' FROM proxy_accounts p JOIN user_pool_accounts a ON a.identity=p.identity ORDER BY p.identity');
    const [inventory] = await query("SELECT inventory_count FROM proxy_enterprises WHERE id='default'");
    const counters = mock.counters;
    check(filled.counts.ready_idle === FRESH_POOL_IDLE_TARGET && accounts.length === FRESH_POOL_IDLE_TARGET
      && accounts.every((row) => row.status === 'valid' && row.state === 'ready')
      && Number(inventory?.inventory_count) === FRESH_POOL_IDLE_TARGET
      && counters.scimCreates === FRESH_POOL_IDLE_TARGET && counters.taskPosts === FRESH_POOL_IDLE_TARGET
      && counters.callbacksSucceeded === FRESH_POOL_IDLE_TARGET && counters.callbacksFailed === 0
      && counters.scimConflicts === 0 && mock.seats.length === FRESH_POOL_IDLE_TARGET, 'pool_reaches_idle_target',
    { counts: filled.counts, fillMs, counters, inventory: Number(inventory?.inventory_count),
      warmupInference: mock.inference.filter((row) => row.marker === null).length });

    const [users] = await probe([{ target: 'sso', path: '/api/enterprises/default/users?page=1&pageSize=100',
      headers: probeToken() }]);
    h.freshSsoUser = mock.users[0]?.userName;
    check(accounts.every((row) => row.account_enterprise === 'default' && row.member_enterprise === 'default')
      && mock.tasks.length === FRESH_POOL_IDLE_TARGET && mock.tasks.every((task) => task.enterpriseId === 'default'
        && task.status === 'success') && users.status === 200 && users.json?.total === FRESH_POOL_IDLE_TARGET
      && h.freshSsoUser, 'pool_provisioning_scoped_to_default',
    { tasks: mock.tasks.map((task) => task.enterpriseId ?? null), ssoUsers: users.json?.total ?? null });
  });
}

async function freshCaller() {
  await runStep('fresh-caller', async () => {
    const caller = `sha256:${h.smoke.hash(FRESH_CALLER)}`;
    const options = h.smoke.inferOptions(caller, '/responses', 'POOL_TEST:{"id":"fresh-hold","streamMode":"hold"}',
      true);
    const controller = new AbortController();
    const held = await fetch(`${h.smoke.urls.proxy}/responses`, {
      method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(options.body), redirect: 'error',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]),
    });
    let provisional;
    try {
      ensure(held.status === 200, 'fresh_held_stream_not_started');
      await h.smoke.poll('fresh_hold', () => h.smoke.databaseState(h.db), (row) => Number(row.holds) === 1, 10000);
      provisional = (await defaultLeases('proxy2', 'candidate')).find((row) => row.callerKeyHash === caller);
      const [row] = await query('SELECT lease_id, phase, member_identity, expires_at - assigned_at AS ttl'
        + ' FROM user_pool_leases WHERE caller_id=?', [caller]);
      const upstream = (await h.smoke.mock()).inference.find((record) => record.marker === 'fresh-hold');
      check(provisional?.phase === 'provisional' && row?.phase === 'provisional' && row.lease_id === provisional.leaseId
        && upstream?.identity === provisional.memberIdentity && upstream.outcome === 'pending',
      'caller_provisional_lease', { ttlMs: Number(row?.ttl ?? 0), seenFrom: 'proxy2', requestOn: 'proxy' });
    } finally {
      controller.abort();
      await held.body?.cancel().catch(() => {});
    }
    await h.smoke.poll('fresh_hold_cancelled', () => h.smoke.mock(),
      (value) => value.inference.some((row) => row.marker === 'fresh-hold' && row.outcome === 'cancelled'), 15000);
    await h.smoke.poll('fresh_hold_drain', () => h.smoke.databaseState(h.db), (row) => Number(row.holds) === 0, 15000);

    const member = provisional.memberIdentity;
    let n = 0;
    for (const path of PROTOCOLS) {
      for (const stream of [false, true]) {
        const id = `fresh-protocol-${n}`;
        const service = n++ % 2 ? 'proxy2' : 'proxy';
        const request = h.smoke.inferOptions(caller, path, `POOL_TEST:${JSON.stringify({ id })}`, stream);
        h.smoke.successful(await h.smoke.request(service, path, request), path, stream);
      }
    }
    const records = (await h.smoke.mock()).inference.filter((row) => row.marker?.startsWith('fresh-protocol-'));
    check(records.length === 6 && records.every((row) => row.identity === member && row.outcome === 'complete')
      && PROTOCOLS.every((path) => records.filter((row) => row.path === path).length === 2),
    'caller_protocol_json_sse_same_member', { requests: records.length, replicas: ['proxy', 'proxy2'] });

    await pauseDrain('candidate');
    const leases = [];
    for (const service of ['proxy', 'proxy2']) {
      leases.push((await defaultLeases(service, 'candidate')).find((row) => row.callerKeyHash === caller));
    }
    check(leases.every((lease) => lease?.phase === 'active' && lease.leaseId === provisional.leaseId
      && lease.memberIdentity === member) && leases[0].expiresAt === leases[1].expiresAt,
    'caller_active_lease_both_replicas', { phases: leases.map((lease) => lease?.phase ?? null) });

    const stats = await query('SELECT identity, lease_id, path, success, enterprise_id FROM proxy_request_stats'
      + ' WHERE caller_id=?', [caller]);
    const succeeded = stats.filter((row) => Number(row.success) === 1);
    const [all] = await query("SELECT COUNT(*) AS n, SUM(enterprise_id='default') AS d FROM proxy_request_stats");
    check(succeeded.length === 6 && succeeded.every((row) => row.identity === member
      && row.lease_id === provisional.leaseId) && stats.every((row) => row.enterprise_id === 'default')
      && PROTOCOLS.every((path) => succeeded.filter((row) => row.path === path).length === 2)
      && Number(all.n) === Number(all.d ?? 0), 'caller_stats_default_enterprise',
    { callerRows: stats.length, succeeded: succeeded.length, allRows: Number(all.n) });

    const other = `sha256:${h.smoke.hash(FRESH_OTHER_CALLER)}`;
    const request = h.smoke.inferOptions(other, '/v1/messages', 'POOL_TEST:{"id":"fresh-other"}');
    h.smoke.successful(await h.smoke.request('proxy2', '/v1/messages', request), '/v1/messages', false);
    await pauseDrain('candidate');
    const otherLease = (await defaultLeases('proxy', 'candidate')).find((row) => row.callerKeyHash === other);
    const upstream = (await h.smoke.mock()).inference.find((row) => row.marker === 'fresh-other');
    check(otherLease?.phase === 'active' && otherLease.memberIdentity !== member
      && upstream?.identity === otherLease.memberIdentity, 'second_caller_exclusive_member');
  });
}

async function freshDirect() {
  await runStep('fresh-direct', async () => {
    const [created, imported] = await probe([
      { target: 'sso', method: 'POST', path: '/api/enterprises/default/users', headers: SQLITE_TOKEN,
        body: { ssoUser: SQLITE_MEMBER, password: SQLITE_PASSWORD, email: 'release-member@example.test' } },
      { target: 'proxy', method: 'POST', path: '/api/enterprises/default/accounts/copilot-oauth-token/import',
        headers: SQLITE_TOKEN, body: { csvText: `name,copilotOauthToken\n${SQLITE_MEMBER},release-fixture-oauth\n` } },
    ]);
    check(created.status === 201 && imported.status === 200 && imported.json?.summary?.success === 1
      && imported.json.summary.failed === 0, 'sqlite_scoped_user_and_token_import',
    { statuses: [created.status, imported.status] });
    const [json, sse, evidence] = await probe([sqliteInference(false), sqliteInference(true),
      { target: 'mock', path: '/evidence' }]);
    const requests = evidence.json?.requests ?? [];
    check(json.status === 200 && json.json?.content?.[0]?.text === 'RELEASE_MOCK_OK' && sse.status === 200
      && /text\/event-stream/.test(sse.headers['content-type'] ?? '') && /message_stop/.test(sse.text ?? '')
      && requests.length === 2 && requests.every((row) => row.oauthMatches) && requests[1].stream === true,
    'sqlite_direct_inference_json_sse', { statuses: [json.status, sse.status], upstreamRequests: requests.length });
    const [snapshot] = Object.values(await sqliteSnapshots(['proxy']));
    const stats = snapshot.enterprise.proxy_request_stats;
    const accounts = snapshot.enterprise.proxy_accounts;
    check(stats?.total === 2 && stats.default === 2 && stats.missing === 0 && accounts?.total === 1
      && accounts.default === 1, 'sqlite_stats_default_enterprise', { stats, accounts });
    const [legacy] = await probe([{ target: 'proxy', path: '/api/accounts?page=1&pageSize=100', headers: SQLITE_TOKEN }]);
    check(legacy.status === 200 && legacy.headers.deprecation === 'true'
      && JSON.stringify(legacy.json).includes(SQLITE_MEMBER), 'sqlite_legacy_accounts_deprecated');
  });
}

async function freshScope() {
  await runStep('fresh-scope', async () => {
    const token = freshToken();
    const scopedRequests = [
      { target: 'proxy', path: '/api/enterprises/default/accounts?page=1&pageSize=100', headers: token },
      { target: 'proxy', path: '/api/enterprises/default/request-stats', headers: token },
      { target: 'sso', path: '/api/enterprises/default/users?page=1&pageSize=100', headers: token },
      { target: 'login', path: '/api/enterprises/default/tasks?page=1&pageSize=100', headers: token },
      ...(freshSqlite() ? [] : [
        { target: 'proxy', path: '/api/enterprises/default/user-pool/summary', headers: token },
        { target: 'proxy2', path: '/api/enterprises/default/user-pool/leases', headers: token },
        { target: 'proxy2', path: '/api/enterprises/default/user-pool/events', headers: token },
      ]),
    ];
    const scopedResults = await probe(scopedRequests);
    const accounts = scopedResults[0].json?.total;
    check(scopedResults.every((row) => row.status === 200)
      && accounts === (freshSqlite() ? 1 : FRESH_POOL_IDLE_TARGET), 'scoped_management_200',
    { paths: scopedRequests.map((row, index) => `${row.target} ${row.path.split('?')[0]} ${scopedResults[index].status}`),
      accounts });
    const tokenBody = { oauthAttemptId: randomUUID(), copilotOauthToken: 'synthetic-unscoped-token' };
    const unscopedRequests = [
      { target: 'proxy', path: '/api/request-stats', headers: token },
      { target: 'proxy', method: 'PUT', path: '/internal/accounts/fixture-unscoped/copilot-oauth-token', headers: token,
        body: tokenBody },
      { target: 'sso', path: '/api/users', headers: token },
      { target: 'sso', method: 'POST', path: '/internal/users/fixture-unscoped/login-credentials', headers: token,
        body: {} },
      { target: 'login', path: '/api/tasks', headers: token },
      ...(freshSqlite() ? [] : [
        { target: 'proxy', path: '/api/user-pool/summary', headers: token },
        { target: 'proxy2', path: '/api/user-pool/leases', headers: token },
      ]),
    ];
    const unscoped = await probe(unscopedRequests);
    check(unscoped.every((row) => row.status === 400 && errorCode(row) === 'enterprise_scope_required'),
      'unscoped_management_400',
    { paths: unscopedRequests.map((row, index) => `${row.target} ${row.path} ${unscoped[index].status}`) });
  });
}

async function freshSso(user, password) {
  await runStep('fresh-sso', async () => {
    const login = await ssoLogin('/login', user, password);
    const wrong = await ssoLogin('/login', user, 'wrong-fixture-password');
    const payload = lib.decodeSessionCookie(login.cookies.sso_session);
    const cookie = lib.cookieHeader(login.cookies, 'sso_session');
    check(login.status === 200 && cookie && payload?.e === 'default' && payload?.user?.ssoUser === user
      && wrong.status === 401 && !wrong.cookies.sso_session, 'sso_root_login_default_cookie',
    { statuses: [login.status, wrong.status], enterprise: payload?.e ?? null });
    const saml = await samlWith('/sso', cookie, '/login');
    const anonymous = await samlWith('/sso', '', '/login');
    check(saml === 'saml_response' && anonymous === 'login_redirect', 'sso_root_saml_response', { saml, anonymous });
    const metadata = await one({ target: 'sso', path: '/metadata' });
    const identity = lib.metadataIdentity(metadata.text);
    const pem = await readFile(join(h.state.directory, 'certs/idp-cert.pem'), 'utf8');
    check(metadata.status === 200 && identity.entityId && identity.certificateSha256 === lib.pemCertificateSha256(pem),
      'sso_root_metadata_identity', { entityId: identity.entityId });
  });
}

async function freshRuntime() {
  await runStep('fresh-runtime', async () => {
    const records = await runtime('candidate', 'scoped', freshSqlite() ? 1 : FRESH_POOL_IDLE_TARGET);
    h.runtime = { candidate: records };
    const lines = releaseLines(records);
    check(Object.values(records).every((record) => record.pass === true)
      && Object.values(lines).every((line) => line === 'multi'), 'runtime_verified_scoped',
    { releaseLines: lines, services: Object.keys(records) });
  });
}

async function freshStop() {
  await runStep('fresh-stop', async () => {
    const exits = await stopApps();
    check(exits.length === APPS().length && exits.every((row) => !row.running && !row.oom && row.code === 0),
      'applications_exit_zero', { exits });
  });
}

async function runFresh() {
  await runStep('preflight', preflightFresh);
  if (freshSqlite()) {
    await freshStartSqlite();
    await freshConsole();
    await freshDirect();
    await freshScope();
    await freshSso(SQLITE_MEMBER, SQLITE_PASSWORD);
  } else {
    if (h.mode === 'multi-fresh-dba') await freshDbaSchema();
    await freshStartMysql();
    await freshConsole();
    await freshPool();
    await freshCaller();
    await freshScope();
    await freshSso(h.freshSsoUser, SSO_DEFAULT_PASSWORD);
  }
  await freshRuntime();
  await freshStop();
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point

export function planText(mode) {
  const baselineTag = process.env.RELEASE_QUALIFICATION_BASELINE_TAG || lib.BASELINE_R4_TAG;
  const candidateTag = process.env.RELEASE_QUALIFICATION_CANDIDATE_TAG || 'multi-<sha7>-amd64-r<N>';
  let composePhases = { sqlite: 'generated sibling of tests/image-release/compose.yaml' };
  if (mode === 'multi-upgrade') {
    composePhases = { legacy: 'base + legacy overlay (r4 environment, no registry)',
      registry: 'base + registry overlay (step 4)' };
  } else if (!lib.isSqliteMode(mode)) {
    composePhases = { fresh: 'tests/image-release/qualification-compose.json, proxy2 flattened, no registry'
      + (mode === 'multi-fresh-dba' ? ', MYSQL_AUTO_MIGRATE=false' : ', MYSQL_AUTO_MIGRATE unset (default true)') };
  }
  return JSON.stringify({
    mode,
    baseline: lib.isFreshMode(mode) ? null : `${lib.RELEASE_PREFIX}-<component>:${baselineTag}`,
    candidate: `${lib.RELEASE_PREFIX}-<component>:${candidateTag}`,
    budget: lib.runBudget(mode, process.env.RELEASE_QUALIFICATION_BUDGET_MINUTES),
    composePhases,
    registry: mode === 'multi-upgrade' ? lib.buildRegistry() : undefined,
    clearedInRegistryPhase: mode === 'multi-upgrade' ? lib.LEGACY_ENV_KEYS : undefined,
    steps: lib.qualificationPlan(mode),
  }, null, 2);
}

export async function runMultiQualification(mode, argv) {
  h.mode = mode;
  const budget = lib.runBudget(mode, process.env.RELEASE_QUALIFICATION_BUDGET_MINUTES);
  const started = Date.now();
  h.activeEnd = started + budget.activeMs;
  h.finalEnd = started + budget.finalMs;
  const activeTimer = setTimeout(() => h.aborter.abort(), budget.activeMs);
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (url, options = {}) => fetchOriginal(url, {
    ...options, signal: AbortSignal.any([h.aborter.signal, ...(options.signal ? [options.signal] : [])]),
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      h.aborter.abort();
      for (const child of h.children) child.kill('SIGKILL');
    });
  }
  h.report = {
    version: 2, mode, project: PROJECT, startedAt: new Date(started).toISOString(),
    limits: {
      activeSeconds: budget.activeMs / 1000, finalSeconds: budget.finalMs / 1000, dockerCommandSecondsDefault: 120,
    },
    scope: { realMysql: !lib.isSqliteMode(mode), freshDeployment: lib.isFreshMode(mode),
      mocked: ['GitHub/GHE.com SCIM', 'seats', 'OAuth Login', '/user', 'Copilot models and inference'],
      realLoginTasks: 0, performanceOrStress: false },
    plan: lib.qualificationPlan(mode).map(({ id, title }) => ({ id, title })),
    stepResults: [], findings: [], pass: false,
  };
  let exitCode = 0;
  let stopWatch;
  try {
    ensure(argv.length === 1, 'state_path_required');
    ensure(process.env.RELEASE_QUALIFICATION_CONFIRM === PROJECT, 'explicit_project_confirmation_required');
    h.state = await loadState(resolve(argv[0]));
    ensure(h.state.mode === mode, 'state_mode_mismatch');
    h.report.baseline = h.state.baseline;
    h.report.candidate = h.state.candidate;
    await writeFile(join(h.state.directory, 'started.lock'), `${new Date().toISOString()}\n`,
      { flag: 'wx', mode: 0o600 });
    // The controller's POST /stop drops this file (signals are not portable to Windows); cleanup still runs.
    stopWatch = setInterval(() => {
      if (existsSync(join(h.state.directory, 'stop.request'))) h.aborter.abort();
    }, 2000);
    if (mode === 'multi-upgrade') {
      h.files = phaseFiles('legacy');
      await runStep('preflight', preflightMysql);
      await step1();
      await step2();
      await step3();
      await step4();
      await step5();
      await step7();
    } else if (lib.isFreshMode(mode)) {
      h.current = 'candidate';
      h.files = phaseFiles(lib.isSqliteMode(mode) ? 'sqlite' : 'fresh');
      await runFresh();
    } else {
      await runStep('preflight', preflightSqlite);
      await sqliteBaseline();
      await sqliteCandidate();
      await sqliteR4OnMigrated();
      await sqliteRestore();
    }
    h.report.planCoverage = lib.planCoverage(lib.qualificationPlan(mode), h.report.stepResults);
    h.report.pass = h.report.planCoverage.complete;
    if (!h.report.pass) exitCode = 1;
  } catch (error) {
    exitCode = 1;
    if (h.state) {
      await writeFile(join(h.state.directory, 'failure-detail.json'), JSON.stringify({
        name: error?.name, code: error?.code, message: error?.message, stack: error?.stack, sqlState: error?.sqlState,
        step: h.step?.id,
      }), { flag: 'wx', mode: 0o600 }).catch(() => {});
    }
    // Only snake_case check names reach the report; anything else may carry environment detail.
    h.report.failure = (error?.fixtureFailure || error?.fixtureCheck) && /^[a-z0-9_]+$/.test(error.message)
      ? error.message : 'fixture_prerequisite_or_assertion_failure';
    h.report.failedStep = h.step?.id ?? null;
    h.report.planCoverage = lib.planCoverage(lib.qualificationPlan(mode), h.report.stepResults);
    console.log(JSON.stringify({ step: h.step?.id, failure: h.report.failure }));
  } finally {
    clearTimeout(activeTimer);
    clearInterval(stopWatch);
    for (const child of h.children) child.kill('SIGKILL');
    if (h.db) await h.db.end().catch(() => {});
    if (h.owned) {
      await compose(['logs', '--no-color', '--tail', '200', ...ALL()],
        { timeout: 30000, cleanup: true, optional: true })
        .catch(() => {});
      try {
        // Failure or success: stop only; containers and volumes stay for inspection.
        await compose(['stop', '-t', '10', ...ALL()], { timeout: 150000, cleanup: true });
        h.report.cleanup = 'all_owned_services_stopped_volumes_retained';
      } catch {
        h.report.cleanup = 'owned_stop_incomplete_manual_review_required';
        h.report.pass = false;
        exitCode = 1;
      }
    }
    globalThis.fetch = fetchOriginal;
    h.report.elapsedMs = Date.now() - started;
    h.report.finishedAt = new Date().toISOString();
    if (h.state) {
      await writeFile(join(h.state.directory, 'qualification-report.json'), JSON.stringify(h.report, null, 2),
        { flag: 'wx', mode: 0o600 });
    }
    console.log(JSON.stringify({
      result: 'release_qualification', mode, pass: h.report.pass, failure: h.report.failure ?? null,
      elapsedMs: h.report.elapsedMs, report: h.state ? join(h.state.directory, 'qualification-report.json') : null,
      cleanup: h.report.cleanup ?? 'no_owned_resources_started',
    }));
  }
  return exitCode;
}
