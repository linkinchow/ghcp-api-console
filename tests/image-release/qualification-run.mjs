// One-shot coordinator, intended to be spawned by the parent's preview controller.
// No image builds, pulls, .env, deployment credentials, real model catalogue or Login tasks.
// ALL mutations are confined to PROJECT; Docker commands <=120s, whole run <=18 min (Docker Desktop can be slow).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMPOSE, loadState, PROJECT, ROOT, sha } from './qualification-prepare.mjs';
import { MULTI_MODES } from './qualification-multi-lib.mjs';

const APPS = ['proxy', 'proxy2', 'console', 'sso', 'login'];
const ALL = ['mysql', 'mock', ...APPS, 'bridge'];
const CONTEXT = 'desktop-linux';
const started = Date.now();
const activeEnd = started + 900000;
const finalEnd = started + 1080000;
const aborter = new AbortController();
const activeTimer = setTimeout(() => aborter.abort(), Math.max(1, activeEnd - Date.now()));
const fetchOriginal = globalThis.fetch;
// Every fetch (including the smoke fixture's) is cancelled when the active deadline passes.
globalThis.fetch = (url, options = {}) => fetchOriginal(url, {
  ...options,
  signal: AbortSignal.any([aborter.signal, ...(options.signal ? [options.signal] : [])]),
});
let state, smoke, db, child;
let current = 'baseline';
let owned = false;
let commandIndex = 0;
const report = {
  version: 1,
  project: PROJECT,
  startedAt: new Date(started).toISOString(),
  limits: { workflowSeconds: 1080, activeSeconds: 900, dockerCommandSeconds: 120 },
  scope: {
    realMysql: true,
    mocked: ['SCIM', 'seat', 'OAuth Login', 'models', 'inference'],
    realLoginTasks: 0,
    performanceOrStress: false,
    lifecycle32: false,
  },
  steps: [],
  findings: [],
  pass: false,
};

const event = (name, details = {}) => {
  report.steps.push({ name, elapsedMs: Date.now() - started, ...details });
  console.log(JSON.stringify({ step: name, ...details }));
};

function check(condition, name) {
  if (!condition) throw Object.assign(new Error(name), { fixtureFailure: true });
}

function environment(phase = current) {
  const target = phase === 'candidate' ? state.candidate : state.baseline;
  const env = {
    ...process.env,
    COMPOSE_DISABLE_ENV_FILE: '1',
    RELEASE_QUALIFICATION_DIR: state.directory,
    RELEASE_QUALIFICATION_MYSQL_IMAGE: state.mysqlImage,
    RELEASE_QUALIFICATION_PREFIX: target.prefix,
    RELEASE_QUALIFICATION_TAG: target.tag,
  };
  // Never let the caller's Compose, Docker or MySQL settings redirect commands away from PROJECT.
  const inherited = [
    'COMPOSE_FILE',
    'COMPOSE_PROJECT_NAME',
    'COMPOSE_PROFILES',
    'COMPOSE_ENV_FILES',
    'COMPOSE_PATH_SEPARATOR',
    'MYSQL_TEST_URL',
    'MYSQL_URL',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
  ];
  for (const name of inherited) delete env[name];
  return env;
}

async function execute(args, { phase = current, timeout = 120000, cleanup = false, optional = false } = {}) {
  check(cleanup || !aborter.signal.aborted, 'workflow_deadline');
  const limit = Math.min(timeout, (cleanup ? finalEnd : activeEnd) - Date.now());
  check(limit > 0, 'workflow_deadline');
  const ordinal = ++commandIndex;
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
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    const forceKill = () => {
      timedOut = true;
      proc.kill('SIGKILL');
    };
    const timer = setTimeout(forceKill, limit);
    // Cleanup commands keep running after the active deadline, up to finalEnd.
    const abort = () => {
      if (!cleanup) forceKill();
    };
    aborter.signal.addEventListener('abort', abort, { once: true });
    const collect = (which, chunk) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        forceKill();
        return;
      }
      if (which === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    proc.stdout.on('data', (chunk) => collect('stdout', chunk));
    proc.stderr.on('data', (chunk) => collect('stderr', chunk));
    const finish = async (code, spawnError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      aborter.signal.removeEventListener('abort', abort);
      if (child === proc) child = undefined;
      try {
        // Docker output may include synthetic tokens; keep it only under ignored owned logs.
        await writeFile(
          join(state.directory, 'logs', `${String(ordinal).padStart(3, '0')}.json`),
          JSON.stringify({ args, code, timedOut, stdout, stderr }),
          { flag: 'wx', mode: 0o600 },
        );
        if (spawnError || timedOut || (code !== 0 && !optional)) {
          const message = timedOut ? 'command_or_workflow_deadline' : 'docker_command_failed';
          reject(Object.assign(new Error(message), { fixtureFailure: true }));
        } else {
          accept({ code, stdout, stderr });
        }
      } catch (error) {
        reject(error);
      }
    };
    proc.once('error', () => finish(null, true));
    proc.once('exit', (code) => finish(code, false));
  });
}

function composeArgs(args) {
  return [
    'compose',
    '--env-file', join(state.directory, 'empty.env'),
    '--project-directory', ROOT,
    '-p', PROJECT,
    '-f', COMPOSE,
    ...args,
  ];
}

const compose = (args, options) => execute(composeArgs(args), options);

// Compose service name of an inspected container.
const serviceName = (row) => row.Config.Labels['com.docker.compose.service'];

const exitStatus = (row) => ({ service: serviceName(row), code: row.State.ExitCode, oom: row.State.OOMKilled });

async function inspectContainerIds(services = ALL) {
  const result = await compose(['ps', '-a', '-q', ...services]);
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}

async function verifyOwnedContainers() {
  const ids = await inspectContainerIds();
  check(ids.length === ALL.length, 'owned_container_count');
  const data = JSON.parse((await execute(['inspect', ...ids])).stdout);
  for (const row of data) {
    const labels = row.Config.Labels;
    check(
      labels['com.docker.compose.project'] === PROJECT && ALL.includes(labels['com.docker.compose.service']),
      'foreign_container',
    );
    const service = labels['com.docker.compose.service'];
    if (APPS.includes(service)) {
      const component = service === 'proxy2' ? 'proxy' : service;
      const prefix = current === 'candidate' ? state.candidate : state.baseline;
      check(row.Config.Image === `${prefix.prefix}-${component}:${prefix.tag}`, 'wrong_runtime_image_reference');
      check(row.Image === report.images[row.Config.Image].id, 'image_changed_since_preflight');
      check(
        !row.HostConfig.PortBindings || Object.keys(row.HostConfig.PortBindings).length === 0,
        'app_port_published',
      );
      // Apps may only mount this project's volumes and the read-only fixture/cert directories.
      check(row.Mounts.every((mount) => (mount.Type === 'volume'
        ? mount.Name.startsWith(`${PROJECT}_`)
        : (mount.Destination === '/qualification' || mount.Destination === '/certs') && mount.RW === false)),
      'app_source_or_foreign_mount');
    }
  }
  return data;
}

// The loopback MySQL bridge closes connections idle for 120 s, and slow runtime checks can exceed
// that. Reconnect the SELECT-only observer before each use instead of failing on a closed socket.
async function ensureObserver() {
  try {
    await db.ping();
  } catch {
    await db?.end().catch(() => {});
    db = await smoke.connectDatabase('observer');
  }
}

async function pauseDrain() {
  await ensureObserver();
  const pool = await smoke.pool('proxy', true);
  if (Number(pool.settings.paused) !== 1) await smoke.settings({ paused: 1 });
  await smoke.poll(
    'qualification_drain',
    () => smoke.databaseState(db),
    (row) => Number(row.holds) === 0 && Number(row.catalog_holds) === 0,
    15000,
  );
  smoke.invariants(await smoke.databaseState(db));
}

async function query(sql, values = []) {
  return (await db.query({ sql, timeout: 7000 }, values))[0];
}

async function logicalSnapshot() {
  await ensureObserver();
  // Observer is SELECT-only. Consistent read brackets all mutable logical data.
  await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  try {
    const settings = await query(
      'SELECT id,version,idle_target,max_accounts,lease_seconds,paused,next_ordinal,account_domain,'
      + 'config_fingerprint FROM user_pool_settings ORDER BY id',
    );
    const accounts = await query(
      'SELECT identity,sso_user,gh_login,SHA2(copilot_oauth_token,256) AS token_hash,copilot_oauth_status,'
      + 'copilot_oauth_attempt_id,copilot_oauth_updated_at,created_at,updated_at FROM proxy_accounts ORDER BY identity',
    );
    const members = await query(
      'SELECT identity,ordinal,state,stage,attempt_id,oauth_attempt_id,sso_created_at,task_id,attempts,retry_at,'
      + 'last_error,updated_at,cooldown_until,verified_at,generation,reauth_count,reauth_window_at'
      + ' FROM user_pool_accounts ORDER BY identity',
    );
    const leases = await query(
      'SELECT caller_id,member_identity,lease_id,phase,assigned_at,last_success_at,expires_at'
      + ' FROM user_pool_leases ORDER BY caller_id',
    );
    const stats = await query(
      'SELECT id,identity,caller_id,lease_id,requested_at,path,model,success FROM proxy_request_stats ORDER BY id',
    );
    const columns = await query(
      'SELECT TABLE_NAME,COLUMN_NAME,ORDINAL_POSITION,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,COLLATION_NAME,EXTRA'
      + ' FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION',
    );
    const indexes = await query(
      'SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,COLLATION,SUB_PART'
      + ' FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()'
      + ' ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX',
    );
    const constraints = await query(
      'SELECT TABLE_NAME,CONSTRAINT_NAME,CONSTRAINT_TYPE,ENFORCED FROM information_schema.TABLE_CONSTRAINTS'
      + ' WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,CONSTRAINT_NAME',
    );
    const checks = await query(
      'SELECT CONSTRAINT_NAME,CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS'
      + ' WHERE CONSTRAINT_SCHEMA=DATABASE() ORDER BY CONSTRAINT_NAME',
    );
    const foreignKeys = await query(
      'SELECT TABLE_NAME,CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME'
      + ' FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE()'
      + ' ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION',
    );
    await query('COMMIT');
    check(settings.length === 1 && Number(settings[0].paused) === 1, 'snapshot_not_paused');
    check(
      accounts.length === 3 && accounts.every((row) => row.token_hash && row.copilot_oauth_status === 'valid'),
      'snapshot_credentials_incomplete',
    );
    check(
      leases.length === 2 && leases.every((row) => Number(row.expires_at) > Date.now() + 60000),
      'snapshot_lease_expiry_budget',
    );
    const mocks = await smoke.mock();
    return {
      settingsHash: sha(settings),
      credentialsHash: sha(accounts),
      membersHash: sha(members),
      leasesHash: sha(leases),
      schemaHash: sha({ columns, indexes, constraints, checks, foreignKeys }),
      statsHash: sha(stats),
      stats,
      leases,
      ownerHash: (await smoke.databaseState(db)).owner_hash,
      counters: mocks.counters,
      // Counts and hashes only: this part is written to the report.
      public: {
        accounts: accounts.length,
        members: members.length,
        leases: leases.length,
        stats: stats.length,
        settingsHash: sha(settings),
        credentialsHash: sha(accounts),
        membersHash: sha(members),
        leasesHash: sha(leases),
        schemaHash: sha({ columns, indexes, constraints, checks, foreignKeys }),
        statsHash: sha(stats),
      },
    };
  } catch (error) {
    await query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function compareSnapshot(before, after) {
  const differences = ['settingsHash', 'credentialsHash', 'membersHash', 'leasesHash', 'schemaHash', 'statsHash']
    .filter((key) => before[key] !== after[key]);
  if (differences.length) {
    event('logical_snapshot_difference', {
      pass: false,
      fields: differences,
      before: before.public,
      after: after.public,
    });
  }
  check(differences.length === 0, 'restart_logical_snapshot_changed');
  for (const key of ['scimCreates', 'taskPosts', 'callbacksSucceeded', 'callbacksFailed']) {
    check(before.counters[key] === after.counters[key], 'restart_reprovisioned');
  }
}

async function consoleSession(cookie) {
  const me = await smoke.request('console', '/api/console/me', { headers: { Cookie: cookie } });
  smoke.status(me, 200, 'console_session_preserved');
  check(me.data.username === 'mysql-fixture-admin', 'console_admin_changed');
  smoke.status(
    await smoke.request('console', '/api/console/proxy/user-pool/summary', { headers: { Cookie: cookie } }),
    200,
    'console_session_pool_bridge',
  );
}

async function runtime() {
  const data = {};
  for (const service of APPS) {
    const output = await compose(
      ['exec', '-T', service, 'node', '/qualification/qualification-verify-runtime.mjs', service, current],
      { timeout: 90000 },
    );
    // The verifier prints one JSON result line; ignore any other output.
    const record = output.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .find((row) => row?.service === service);
    check(record?.pass === true, 'runtime_result_missing');
    data[service] = record;
  }
  return data;
}

// Upgrades may add SSO tables or columns (and append migration records); every value that
// existed before must still be there, unchanged.
const APPEND_ONLY_TABLES = new Set(['schema_migrations']);

function persistence(before, after) {
  check(
    before.console.adminFileSha256 === after.console.adminFileSha256,
    'console_persistent_adminFileSha256_changed',
  );
  for (const field of ['certSha256', 'userCount']) {
    check(before.sso[field] === after.sso[field], `sso_persistent_${field}_changed`);
  }
  for (const [table, previous] of Object.entries(before.sso.logicalTables)) {
    const current = after.sso.logicalTables[table];
    check(
      current && previous.columns.every((column) => current.columns.includes(column)),
      `sso_table_or_column_removed_${table}`,
    );
    const project = (rows) => rows.map((row) => JSON.stringify(previous.columns.map((column) => row[column]))).sort();
    const beforeRows = project(previous.rows);
    const afterRows = project(current.rows);
    const preserved = APPEND_ONLY_TABLES.has(table)
      ? beforeRows.every((row) => afterRows.includes(row))
      : JSON.stringify(beforeRows) === JSON.stringify(afterRows);
    check(preserved, `sso_persistent_rows_changed_${table}`);
  }
}

// Stops the candidate applications and requires every one to exit 0 without being OOM-killed.
async function stopApplicationsCleanly() {
  await compose(['stop', '-t', '35', ...APPS], { timeout: 60000 });
  const ids = (await compose(['ps', '-a', '-q', ...APPS])).stdout.trim().split(/\s+/);
  const exits = JSON.parse((await execute(['inspect', ...ids])).stdout).map(exitStatus);
  check(exits.every((row) => !row.oom && row.code === 0), 'candidate_unclean_shutdown');
  event('candidate_application_stop', { pass: true, exits });
}

/**
 * Starts the candidate Proxy the way old Kubernetes/Rancher templates did (command override, so
 * node is PID 1 without Tini) in an offline, throwaway SQLite container, then stops it and
 * requires a clean exit. The container is labelled for this project and left stopped.
 */
async function legacyCommandCheck() {
  const image = `${state.candidate.prefix}-proxy:${state.candidate.tag}`;
  const name = `${PROJECT}-legacy-command`;
  await execute([
    'run', '-d',
    '--name', name,
    '--label', `ghcp.qualification=${PROJECT}`,
    '--network', 'none',
    '--entrypoint', 'node',
    '-e', 'DB_PATH=/tmp/proxy.sqlite',
    '-e', 'INTERNAL_API_TOKEN=legacy-fixture-only',
    '-e', 'PROXY_ERROR_DIAGNOSTICS_ENABLED=false',
    image, 'src/proxy/dist/index.js',
  ], { phase: 'candidate', timeout: 30000 });
  const listening = await pollUntilListening(
    async () => (await execute(['logs', name], { phase: 'candidate', timeout: 10000 })).stdout,
    20000,
  );
  check(/\[proxy\] listening/.test(listening), 'legacy_command_not_listening');
  await execute(['stop', '-t', '35', name], { phase: 'candidate', timeout: 45000 });
  const [container] = JSON.parse((await execute(['inspect', name], { phase: 'candidate' })).stdout);
  check(container.State.ExitCode === 0 && !container.State.OOMKilled, 'legacy_command_unclean_shutdown');
  event('candidate_legacy_command_starts_and_stops_cleanly', { pass: true, exitCode: container.State.ExitCode });
}

// Polls container logs for the Proxy listening line (the smoke fixture is not loaded yet).
async function pollUntilListening(read, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await read();
    if (/\[proxy\] listening/.test(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last;
}

async function protocol(snapshot, label) {
  const caller = snapshot.leases.find((row) => row.caller_id === `sha256:${smoke.hash('mysql-smoke-1')}`);
  check(caller, 'preserved_active_caller_missing');
  let n = 0;
  // JSON and SSE on each protocol, alternating between both Proxy replicas.
  for (const path of ['/v1/messages', '/chat/completions', '/responses']) {
    for (const stream of [false, true]) {
      const id = `qualification-${label}-${n++}`;
      const options = smoke.inferOptions(caller.caller_id, path, `POOL_TEST:${JSON.stringify({ id })}`, stream);
      smoke.successful(await smoke.request(n % 2 ? 'proxy' : 'proxy2', path, options), path, stream);
      const rows = (await smoke.mock()).inference.filter((row) => row.marker === id);
      check(
        rows.length === 1 && rows[0].identity === caller.member_identity && rows[0].outcome === 'complete',
        'upgraded_protocol_lease_binding',
      );
    }
  }
  await pauseDrain();
  const rows = await query('SELECT id,identity,caller_id,lease_id,path,success FROM proxy_request_stats');
  const priorIds = new Set(snapshot.stats.map((row) => row.id));
  const appended = rows.filter((row) => !priorIds.has(row.id));
  check(
    appended.length === 6 && appended.every((row) => row.identity === caller.member_identity
      && row.caller_id === caller.caller_id
      && row.lease_id === caller.lease_id
      && Number(row.success) === 1),
    'new_stats_missing_or_unbound',
  );
  for (const path of ['/v1/messages', '/chat/completions', '/responses']) {
    check(appended.filter((row) => row.path === path).length === 2, 'new_stats_protocol_shape');
  }
  const leases = (await smoke.pool()).leases;
  check(
    leases.find((row) => row.callerKeyHash === caller.caller_id)?.leaseId === caller.lease_id,
    'post_protocol_lease_replaced',
  );
  event(`${label}_protocol_json_sse_new_stats`, { pass: true, requests: 6 });
}

async function transition(next, snapshot, cookie, previousRuntime) {
  await pauseDrain();
  const before = await verifyOwnedContainers();
  // Infrastructure containers must be the very same containers after the application swap.
  const stableIds = Object.fromEntries(before
    .filter((row) => ['mysql', 'mock', 'bridge'].includes(serviceName(row)))
    .map((row) => [serviceName(row), row.Id]));
  // Only applications are stopped/recreated. Never down, rm, prune or -v.
  await compose(['stop', '-t', '12', ...APPS], { timeout: 25000 });
  const stopped = await compose(['ps', '-a', '-q', ...APPS]);
  const statuses = JSON.parse((await execute(['inspect', ...stopped.stdout.trim().split(/\s+/)])).stdout);
  const exits = statuses.map(exitStatus);
  // Graceful shutdown: every candidate service drains and exits 0 (143 would mean killed by SIGTERM).
  if (current === 'candidate') {
    check(exits.every((row) => !row.oom && row.code === 0), 'candidate_unclean_shutdown');
  }
  event(`${current}_application_stop`, {
    pass: true,
    exits,
    baselineNpmShutdownIsObservationOnly: current !== 'candidate',
  });
  current = next;
  // Baseline images start through npm and are noticeably slower; allow for that on rollback.
  await compose(['up', '-d', '--no-build', '--pull', 'never', '--no-deps', ...APPS], { timeout: 90000 });
  await smoke.poll('upgraded_health', async () => {
    try {
      await smoke.health();
      return true;
    } catch {
      return false;
    }
  }, (value) => value, 60000);
  const after = await verifyOwnedContainers();
  for (const [service, id] of Object.entries(stableIds)) {
    check(after.find((row) => serviceName(row) === service)?.Id === id, 'infrastructure_recreated');
  }
  const afterSnapshot = await logicalSnapshot();
  compareSnapshot(snapshot, afterSnapshot);
  // A new scheduler owner must take over from the stopped one and keep renewing its lease.
  const firstOwner = await smoke.poll(
    'replacement_scheduler_owner',
    () => smoke.databaseState(db),
    (row) => row.owner_hash
      && row.owner_hash !== snapshot.ownerHash
      && Number(row.owner_until) > Number(row.now_ms),
    45000,
  );
  const renewedOwner = await smoke.poll(
    'replacement_scheduler_renewal',
    () => smoke.databaseState(db),
    (row) => row.owner_hash === firstOwner.owner_hash && Number(row.owner_until) > Number(firstOwner.owner_until),
    15000,
  );
  smoke.invariants(renewedOwner);
  check(
    renewedOwner.owner_hash === firstOwner.owner_hash
      && Number(renewedOwner.owner_until) > Number(firstOwner.owner_until),
    'replacement_scheduler_not_renewing',
  );
  event(`${next}_single_scheduler_owner_renewal`, { pass: true });
  await consoleSession(cookie);
  const checks = await runtime();
  persistence(previousRuntime, checks);
  report.runtime[next] = checks;
  event(`${next}_preserved_logical_state_session_certs`, { pass: true, snapshot: afterSnapshot.public });
  await protocol(afterSnapshot, next);
  return checks;
}

async function main() {
  check(process.argv.length === 3, 'state_path_required');
  check(process.env.RELEASE_QUALIFICATION_CONFIRM === PROJECT, 'explicit_project_confirmation_required');
  const freshCandidate = process.env.RELEASE_QUALIFICATION_MODE === 'candidate-fresh';
  check(!process.env.RELEASE_QUALIFICATION_MODE || freshCandidate, 'invalid_qualification_mode');
  if (freshCandidate) current = 'candidate';
  report.mode = freshCandidate ? 'candidate-fresh' : 'baseline-upgrade-rollback';
  state = await loadState(resolve(process.argv[2]));
  await writeFile(join(state.directory, 'started.lock'), `${new Date().toISOString()}\n`, { flag: 'wx', mode: 0o600 });

  // Preflight: the project must be new, and the resolved Compose config must stay isolated.
  const old = await compose(['ps', '-a', '-q']);
  check(!old.stdout.trim(), 'qualification_project_already_exists');
  const volumes = await execute(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`]);
  check(!volumes.stdout.trim(), 'qualification_project_volumes_already_exist');
  const config = JSON.parse((await compose(['config', '--format', 'json'])).stdout);
  check(config.name === PROJECT, 'compose_project_mismatch');
  check(
    Object.keys(config.services).length === ALL.length && ALL.every((name) => config.services[name]),
    'unexpected_compose_services',
  );
  for (const service of APPS) {
    const item = config.services[service];
    check(!item.command && !item.entrypoint && !item.working_dir && !item.build, 'shipped_cmd_overridden');
    check(
      Object.hasOwn(item.networks, 'isolated') && Object.keys(item.networks).length === 1 && !item.ports,
      'app_network_escape',
    );
  }
  check(config.networks.isolated.internal === true, 'network_not_internal');
  check(
    config.services.bridge.ports.length === 5
      && config.services.bridge.ports.every((port) => port.host_ip === '127.0.0.1'),
    'bridge_not_loopback_only',
  );
  check(
    Object.values(config.volumes).every((volume) => volume.name.startsWith(`${PROJECT}_`) && !volume.external),
    'foreign_volume',
  );

  // Images must already be present locally (never pulled) and the candidate must keep the shipped defaults.
  report.images = {};
  for (const target of [state.baseline, state.candidate]) {
    for (const component of ['proxy', 'console', 'sso', 'login']) {
      const ref = `${target.prefix}-${component}:${target.tag}`;
      const [image] = JSON.parse((await execute(['image', 'inspect', ref], { timeout: 12000 })).stdout);
      check(image.Os === 'linux' && image.Architecture === 'amd64', 'wrong_image_platform');
      report.images[ref] = {
        id: image.Id,
        os: image.Os,
        architecture: image.Architecture,
        workingDir: image.Config.WorkingDir,
        cmd: image.Config.Cmd,
        entrypoint: image.Config.Entrypoint,
      };
      if (target === state.candidate) {
        check(image.Config.WorkingDir === `/app/src/${component}`, 'candidate_workdir');
        check(
          JSON.stringify(image.Config.Cmd)
            === JSON.stringify(['node', component === 'console' ? 'dist/server/index.js' : 'dist/index.js']),
          'candidate_default_cmd',
        );
        check(
          JSON.stringify(image.Config.Entrypoint) === JSON.stringify(['/usr/bin/tini', '-g', '--']),
          'candidate_default_tini',
        );
      }
    }
  }
  await execute(['image', 'inspect', state.mysqlImage], { timeout: 10000 });
  await execute([
    'image',
    'inspect',
    'node:22-bookworm-slim@sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562',
  ], { timeout: 10000 });
  event('scope_images_defaults_preflight', { pass: true });

  owned = true;
  await legacyCommandCheck();
  // A fresh MySQL volume can take minutes to initialise when Docker Desktop disk I/O is slow.
  await compose(['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '300'], { timeout: 320000 });
  await verifyOwnedContainers();
  smoke = await import(pathToFileURL(join(state.directory, 'fixtures/mysql-smoke.mjs')).href);
  await smoke.health();
  // Run the unmodified single-slug smoke flow (only project/ports adapted).
  const smokeChild = spawn(
    process.execPath,
    [join(state.directory, 'fixtures/mysql-smoke.mjs'), 'run', join(state.directory, 'smoke-snapshot.json')],
    { cwd: ROOT, env: environment(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child = smokeChild;
  await new Promise((accept, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => smokeChild.kill('SIGKILL'), Math.min(180000, activeEnd - Date.now()));
    const abort = () => smokeChild.kill('SIGKILL');
    aborter.signal.addEventListener('abort', abort, { once: true });
    smokeChild.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    smokeChild.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    smokeChild.once('error', () => {
      clearTimeout(timer);
      reject(Object.assign(Error('smoke_process_unavailable'), { fixtureFailure: true }));
    });
    smokeChild.once('exit', async (code) => {
      clearTimeout(timer);
      aborter.signal.removeEventListener('abort', abort);
      if (child === smokeChild) child = undefined;
      await writeFile(
        join(state.directory, 'logs/mysql-smoke.json'),
        JSON.stringify({ code, stdout, stderr }),
        { flag: 'wx', mode: 0o600 },
      );
      for (const line of stdout.split(/\r?\n/).filter((line) => line.startsWith('PASS '))) {
        event(line.slice(5), { pass: true });
      }
      if (code === 0) accept();
      else reject(Object.assign(Error('baseline_mysql_smoke_failed'), { fixtureFailure: true }));
    });
  });
  db = await smoke.connectDatabase('observer');
  await pauseDrain();
  const session = smoke.status(
    await smoke.request('console', '/api/console/login', {
      method: 'POST',
      body: { username: 'mysql-fixture-admin', password: 'mysql-fixture-console-only' },
    }),
    200,
    'qualification_console_login',
  );
  const cookie = session.headers.getSetCookie().map((line) => line.split(';', 1)[0]).join('; ');
  check(cookie.length > 0, 'session_cookie_missing');
  await consoleSession(cookie);

  if (freshCandidate) {
    report.runtime = { candidate: await runtime() };
    const snapshot = await logicalSnapshot();
    event('candidate_fresh_supply_runtime_snapshot', { pass: true, snapshot: snapshot.public });
    await protocol(snapshot, 'candidate-fresh');
    await stopApplicationsCleanly();
    report.pass = true;
    event('candidate_fresh_pool_qualification_complete', { pass: true, dropInCompatibilityGatePassed: true });
    return;
  }

  // Baseline -> candidate upgrade, then rollback to the baseline images on the same data.
  report.runtime = { baseline: await runtime() };
  const baseline = await logicalSnapshot();
  event('baseline_quiescent_logical_snapshot', { pass: true, snapshot: baseline.public });
  const candidateRuntime = await transition('candidate', baseline, cookie, report.runtime.baseline);
  report.findings.push({
    kind: 'deprecated_template_command_override',
    dropInCompatible: true,
    detail: 'Old templates override the Proxy command; the image shim keeps it working,'
      + ' but the override bypasses Tini.',
    recommendation: 'Remove the command override and use the shipped entrypoint and CMD.',
  });
  await pauseDrain();
  const beforeRollback = await logicalSnapshot();
  event('candidate_pre_rollback_quiescent_logical_snapshot', { pass: true, snapshot: beforeRollback.public });
  await transition('rollback', beforeRollback, cookie, candidateRuntime);
  await pauseDrain();
  report.pass = true;
  event('baseline_candidate_rollback_complete', { pass: true, dropInCompatibilityGatePassed: true });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    aborter.abort();
    child?.kill('SIGKILL');
  });
}

// Multi-enterprise modes (design §9.4) live in qualification-multi-run.mjs; `--plan` prints their step plan
// without touching Docker.
const MULTI_MODE = MULTI_MODES.includes(process.env.RELEASE_QUALIFICATION_MODE)
  ? process.env.RELEASE_QUALIFICATION_MODE
  : undefined;
if (MULTI_MODE || process.argv[2] === '--plan') {
  clearTimeout(activeTimer);
  globalThis.fetch = fetchOriginal;
  const multi = await import('./qualification-multi-run.mjs');
  if (process.argv[2] === '--plan') {
    if (MULTI_MODE) {
      console.log(multi.planText(MULTI_MODE));
    } else {
      console.error(`--plan needs RELEASE_QUALIFICATION_MODE=${MULTI_MODES.join('|')}`);
      process.exitCode = 2;
    }
  } else {
    process.exitCode = await multi.runMultiQualification(MULTI_MODE, process.argv.slice(2));
  }
} else {
  await runSingleQualification();
}

async function runSingleQualification() {
  try {
    await main();
  } catch (error) {
    if (state) {
      await writeFile(join(state.directory, 'failure-detail.json'), JSON.stringify({
        name: error?.name,
        code: error?.code,
        message: error?.message,
        stack: error?.stack,
        sqlState: error?.sqlState,
      }), { flag: 'wx', mode: 0o600 });
    }
    // Only snake_case check names reach the report; anything else may carry environment detail.
    report.failure = (error?.fixtureFailure || error?.fixtureCheck) && /^[a-z0-9_]+$/.test(error.message)
      ? error.message
      : 'fixture_prerequisite_or_assertion_failure';
    event('qualification_failure', { pass: false, reason: report.failure });
    process.exitCode = 1;
  } finally {
    clearTimeout(activeTimer);
    child?.kill('SIGKILL');
    if (db) await db.end().catch(() => {});
    if (owned) {
      // Logs are best effort: a slow or failed log read must never skip stopping the services.
      await compose(['logs', '--no-color', '--tail', '100', ...ALL], { timeout: 20000, cleanup: true, optional: true })
        .catch(() => event('cleanup_logs_unavailable', { pass: true }));
      try {
        // Failure cleanup never tears down volumes or anything outside this project.
        await compose(['stop', '-t', '8', ...ALL], { timeout: 120000, cleanup: true });
        report.cleanup = 'all_owned_services_stopped_volumes_retained';
      } catch {
        report.cleanup = 'owned_stop_incomplete_manual_review_required';
        report.pass = false;
        process.exitCode = 1;
      }
    }
    globalThis.fetch = fetchOriginal;
    report.elapsedMs = Date.now() - started;
    report.finishedAt = new Date().toISOString();
    if (state) {
      await writeFile(
        join(state.directory, 'qualification-report.json'),
        JSON.stringify(report, null, 2),
        { flag: 'wx', mode: 0o600 },
      );
    }
    console.log(JSON.stringify({
      result: 'release_qualification',
      pass: report.pass,
      elapsedMs: report.elapsedMs,
      report: state ? join(state.directory, 'qualification-report.json') : null,
      dropInCompatibilityGatePassed: report.pass,
      cleanup: report.cleanup ?? 'no_owned_resources_started',
    }));
  }
}
