// Isolated check: a global READY_IDLE_TARGET larger than the default enterprise cap (POOL_MAX_ACCOUNTS) is accepted
// by a multi-enterprise Proxy image at startup and through PATCH /api/user-pool/settings, on SQLite and MySQL.
// Caps are per enterprise; POOL_MAX_ACCOUNTS only seeds the `default` enterprise's first cap.
//
// Optional control: RELEASE_QUALIFICATION_CONTROL_TAG (an older multi tag, e.g. multi-41ecffc-amd64-r1) must refuse
// the same environment at startup with "Idle target exceeds pool account cap", which shows the check is meaningful.
//
// Safety: only containers, one internal network and one volume named `<project>-*` / `<project>_*` are created;
// Proxy containers have no network (SQLite) or only the internal network (MySQL); no ports are published; synthetic
// credentials only; no image builds or pulls. Resources are removed only when every assertion passed; on failure
// they are stopped and kept for inspection. The report goes to stdout as JSON (no secrets: all values synthetic).
//
// Inputs: RELEASE_QUALIFICATION_PROJECT (ghcp-release-qualification-<suffix>), RELEASE_QUALIFICATION_CANDIDATE_TAG,
// RELEASE_QUALIFICATION_MYSQL_IMAGE (cached mysql:8.4), RELEASE_QUALIFICATION_ISOLATED_SUBNET (unused 10.x.y.0/24),
// optional RELEASE_QUALIFICATION_CONTROL_TAG.
import { spawnSync } from 'node:child_process';

const CONTEXT = 'desktop-linux';
const PROJECT = process.env.RELEASE_QUALIFICATION_PROJECT ?? '';
const CANDIDATE = process.env.RELEASE_QUALIFICATION_CANDIDATE_TAG ?? '';
const CONTROL = process.env.RELEASE_QUALIFICATION_CONTROL_TAG ?? '';
const MYSQL_IMAGE = process.env.RELEASE_QUALIFICATION_MYSQL_IMAGE ?? '';
const SUBNET = process.env.RELEASE_QUALIFICATION_ISOLATED_SUBNET ?? '';
const TOKEN = 'idlecap-fixture-internal-only';
const DEFAULT_CAP = 2;
const START_TARGET = 5;
const PATCH_TARGET = 50;

if (!/^ghcp-release-qualification-[a-z0-9-]+$/.test(PROJECT)) throw new Error('RELEASE_QUALIFICATION_PROJECT');
if (!/^multi-[0-9a-f]{7}-amd64-r\d+$/.test(CANDIDATE)) throw new Error('RELEASE_QUALIFICATION_CANDIDATE_TAG');
if (CONTROL && !/^multi-[0-9a-f]{7}-amd64-r\d+$/.test(CONTROL)) throw new Error('RELEASE_QUALIFICATION_CONTROL_TAG');
if (!MYSQL_IMAGE) throw new Error('RELEASE_QUALIFICATION_MYSQL_IMAGE');
if (!/^10\.\d{1,3}\.\d{1,3}\.0\/24$/.test(SUBNET)) throw new Error('RELEASE_QUALIFICATION_ISOLATED_SUBNET');

const NETWORK = `${PROJECT}_isolated`;
const VOLUME = `${PROJECT}_proxy-sqlite`;
const NAMES = { mysql: `${PROJECT}-mysql`, sqlite: `${PROJECT}-proxy-sqlite`, mysqlProxy: `${PROJECT}-proxy-mysql`,
  control: `${PROJECT}-control` };
const LABEL = `ghcp.qualification=${PROJECT}`;
const report = { project: PROJECT, candidate: CANDIDATE, control: CONTROL || null, assertions: [], evidence: {} };
const created = { containers: [], network: false, volume: false };

function docker(args, { allowFail = false, timeout = 120_000 } = {}) {
  const result = spawnSync('docker', ['--context', CONTEXT, ...args], { encoding: 'utf8', timeout });
  if (!allowFail && result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${(result.stderr || result.stdout || '').slice(0, 500)}`);
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function check(condition, name, detail) {
  const pass = Boolean(condition);
  report.assertions.push({ name, pass, ...(detail === undefined ? {} : { detail }) });
  console.error(JSON.stringify({ assertion: name, pass }));
  if (!pass) throw Object.assign(new Error(name), { assertion: true });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Runs one HTTP request inside the Proxy container (no published ports). */
function request(container, method, path, body) {
  const script = `const b=process.argv[3];fetch('http://127.0.0.1:3000'+process.argv[2],{method:process.argv[1],`
    + `headers:{'content-type':'application/json','x-internal-token':'${TOKEN}'},body:b||undefined})`
    + `.then(async r=>{const t=await r.text();let j;try{j=JSON.parse(t)}catch{j=t}`
    + `console.log(JSON.stringify({status:r.status,body:j}))}).catch(e=>{console.log(JSON.stringify({status:0,error:String(e)}))})`;
  const args = ['exec', container, 'node', '-e', script, method, path];
  if (body !== undefined) args.push(JSON.stringify(body));
  const out = docker(args, { allowFail: true });
  try { return JSON.parse(out.stdout.trim().split('\n').at(-1)); } catch { return { status: 0, error: out.stderr }; }
}

function running(container) {
  return docker(['inspect', container, '--format', '{{.State.Running}}'], { allowFail: true }).stdout.trim() === 'true';
}

async function waitHealthy(container, seconds = 90) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (!running(container)) return { running: false };
    const health = request(container, 'GET', '/healthz');
    if (health.status === 200) return { running: true, health: health.body };
    await sleep(1000);
  }
  return { running: running(container), timeout: true };
}

function poolEnv(storage, dbPath = '/data/proxy.sqlite') {
  const env = {
    PORT: '3000', LOG_LEVEL: 'warn', INTERNAL_API_TOKEN: TOKEN, API_KEY: 'idlecap-fixture-api-only',
    ACCOUNT_ROUTING_MODE: 'caller-lease', POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.idlecap.example.test',
    POOL_WARMUP_MODEL: 'claude-opus-5-2', READY_IDLE_TARGET: String(START_TARGET),
    POOL_MAX_ACCOUNTS: String(DEFAULT_CAP), CALLER_LEASE_TTL_SECONDS: '600', PROVISIONAL_LEASE_TTL_SECONDS: '60',
    SSO_BASE_URL: 'http://sso.invalid:7001', LOGIN_BASE_URL: 'http://login.invalid:7003',
    COPILOT_API_BASE_URL: 'http://copilot.invalid:8002', ENTERPRISE_SHORTCODE: 'test',
    PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false', PROXY_ERROR_DIAGNOSTICS_REDACT: 'true',
  };
  if (storage === 'sqlite') Object.assign(env, { STORAGE_DRIVER: 'sqlite', DB_PATH: dbPath });
  else {
    Object.assign(env, { STORAGE_DRIVER: 'mysql', MYSQL_SSL_MODE: 'disabled', MYSQL_CONNECTION_LIMIT: '5',
      MYSQL_URL: `mysql://root:idlecap-fixture-root-only@${NAMES.mysql}:3306/ghcp_idlecap` });
  }
  return Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
}

function runProxy(name, tag, storage, network) {
  const mounts = storage === 'sqlite' ? ['-v', `${VOLUME}:/data`] : [];
  docker(['run', '-d', '--name', name, '--label', LABEL, '--network', network, ...mounts, ...poolEnv(storage),
    `ghcp-release-proxy:${tag}`]);
  created.containers.push(name);
}

/** Startup, settings API and persistence assertions against one running candidate Proxy. */
async function assertCandidate(container, storage) {
  const started = await waitHealthy(container);
  check(started.running && started.health?.releaseLine === 'multi',
    `${storage}_startup_accepts_idle_target_above_default_cap`,
    { READY_IDLE_TARGET: START_TARGET, POOL_MAX_ACCOUNTS: DEFAULT_CAP, healthz: started.health ?? null });

  const settings = request(container, 'GET', '/api/user-pool/settings');
  check(settings.status === 200 && settings.body.idle_target === START_TARGET,
    `${storage}_settings_report_env_idle_target`, { status: settings.status, idle_target: settings.body?.idle_target });

  const enterprises = request(container, 'GET', '/api/enterprises');
  const defaultPool = enterprises.body?.items?.find((item) => item.id === 'default')?.pool;
  check(enterprises.status === 200 && defaultPool?.maxAccounts === DEFAULT_CAP,
    `${storage}_default_enterprise_cap_seeded_from_pool_max_accounts`,
    { status: enterprises.status, maxAccounts: defaultPool?.maxAccounts, inventory: defaultPool?.inventory });

  const patched = request(container, 'PATCH', '/api/user-pool/settings',
    { expectedVersion: settings.body.version, changes: { idle_target: PATCH_TARGET } });
  check(patched.status === 200 && patched.body.idle_target === PATCH_TARGET
    && patched.body.version === settings.body.version + 1,
  `${storage}_settings_api_accepts_idle_target_above_default_cap`,
  { status: patched.status, idle_target: patched.body?.idle_target, version: patched.body?.version });

  const reread = request(container, 'GET', '/api/user-pool/settings');
  check(reread.status === 200 && reread.body.idle_target === PATCH_TARGET, `${storage}_settings_reread_after_patch`,
    { idle_target: reread.body?.idle_target });

  const capKey = request(container, 'PATCH', '/api/user-pool/settings',
    { expectedVersion: reread.body.version, changes: { max_accounts: 100 } });
  check(capKey.status === 409 && capKey.body?.error?.code === 'use_enterprise_cap',
    `${storage}_settings_max_accounts_still_409_use_enterprise_cap`, { status: capKey.status, body: capKey.body });

  const overCapacity = request(container, 'PATCH', '/api/user-pool/settings',
    { expectedVersion: reread.body.version, changes: { idle_target: 10_001 } });
  check(overCapacity.status === 400, `${storage}_settings_idle_target_above_name_capacity_still_400`,
    { status: overCapacity.status });

  const after = request(container, 'GET', '/api/enterprises');
  const pool = after.body?.items?.find((item) => item.id === 'default')?.pool;
  check(pool?.maxAccounts === DEFAULT_CAP && pool.inventory <= DEFAULT_CAP,
    `${storage}_default_cap_unchanged_after_settings_patch`, { maxAccounts: pool?.maxAccounts, inventory: pool?.inventory });

  docker(['restart', '-t', '35', container], { timeout: 180_000 });
  const restarted = await waitHealthy(container);
  const persisted = request(container, 'GET', '/api/user-pool/settings');
  check(restarted.running && restarted.health && persisted.body?.idle_target === PATCH_TARGET,
    `${storage}_restart_with_same_env_keeps_patched_idle_target`,
    { running: restarted.running, idle_target: persisted.body?.idle_target });
}

async function controlRun() {
  const name = NAMES.control;
  docker(['run', '-d', '--name', name, '--label', LABEL, '--network', 'none',
    ...poolEnv('sqlite', '/tmp/control.sqlite'), `ghcp-release-proxy:${CONTROL}`]);
  created.containers.push(name);
  const end = Date.now() + 90_000;
  while (running(name) && Date.now() < end) await sleep(1000);
  const exitCode = Number(docker(['inspect', name, '--format', '{{.State.ExitCode}}']).stdout.trim());
  const logs = docker(['logs', name], { allowFail: true });
  const text = `${logs.stdout}\n${logs.stderr}`;
  check(!running(name) && exitCode !== 0 && /Idle target exceeds pool account cap/.test(text),
    'control_previous_release_refuses_same_env', { exitCode, refused: /Idle target exceeds/.test(text) });
}

async function startMysql() {
  docker(['run', '-d', '--name', NAMES.mysql, '--label', LABEL, '--network', NETWORK,
    '-e', 'MYSQL_ROOT_PASSWORD=idlecap-fixture-root-only', '-e', 'MYSQL_DATABASE=ghcp_idlecap', MYSQL_IMAGE,
    '--character-set-server=utf8mb4', '--collation-server=utf8mb4_0900_ai_ci']);
  created.containers.push(NAMES.mysql);
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    const ping = docker(['exec', NAMES.mysql, 'mysql', '-uroot', '-pidlecap-fixture-root-only', '-h', '127.0.0.1',
      '-e', 'SELECT 1', 'ghcp_idlecap'], { allowFail: true });
    if (ping.status === 0) return;
    await sleep(2000);
  }
  throw new Error('mysql_not_ready');
}

function cleanup(passed) {
  for (const name of created.containers) docker(['stop', '-t', '35', name], { allowFail: true, timeout: 180_000 });
  if (!passed) return;
  for (const name of created.containers) docker(['rm', '-v', name], { allowFail: true });
  if (created.volume) docker(['volume', 'rm', VOLUME], { allowFail: true });
  if (created.network) docker(['network', 'rm', NETWORK], { allowFail: true });
}

async function main() {
  const existing = docker(['ps', '-a', '--filter', `label=${LABEL}`, '--format', '{{.Names}}']).stdout.trim();
  if (existing || docker(['network', 'inspect', NETWORK], { allowFail: true }).status === 0
    || docker(['volume', 'inspect', VOLUME], { allowFail: true }).status === 0) throw new Error('project_not_fresh');
  for (const image of [`ghcp-release-proxy:${CANDIDATE}`, MYSQL_IMAGE, ...(CONTROL ? [`ghcp-release-proxy:${CONTROL}`] : [])]) {
    if (docker(['image', 'inspect', image], { allowFail: true }).status !== 0) throw new Error(`image_missing ${image}`);
  }
  report.evidence.candidateImageId = docker(['image', 'inspect', `ghcp-release-proxy:${CANDIDATE}`, '--format',
    '{{.Id}}']).stdout.trim();
  let passed = false;
  try {
    if (CONTROL) await controlRun();
    docker(['volume', 'create', '--label', LABEL, VOLUME]);
    created.volume = true;
    runProxy(NAMES.sqlite, CANDIDATE, 'sqlite', 'none');
    await assertCandidate(NAMES.sqlite, 'sqlite');
    docker(['network', 'create', '--internal', '--label', LABEL, '--subnet', SUBNET, NETWORK]);
    created.network = true;
    await startMysql();
    runProxy(NAMES.mysqlProxy, CANDIDATE, 'mysql', NETWORK);
    await assertCandidate(NAMES.mysqlProxy, 'mysql');
    passed = true;
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
  } finally {
    report.pass = passed;
    cleanup(passed);
    report.cleanup = passed ? 'removed' : 'stopped_and_kept';
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = passed ? 0 : 1;
  }
}

await main();
