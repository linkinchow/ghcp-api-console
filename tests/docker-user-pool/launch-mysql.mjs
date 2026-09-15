// Launch ONLY through the app's preview_start/launch.json, not a shell server.
// No local-run.json, .env, tenant credentials, or existing certificate is read.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = 'ghcp-user-pool-mysql-test';
const folder = dirname(fileURLToPath(import.meta.url));
const compose = join(folder, 'compose.mysql.yaml');
const args = process.argv.slice(2);
if (process.env.POOL_MYSQL_VOLUME_SET && !/^[a-z0-9-]{1,32}$/.test(process.env.POOL_MYSQL_VOLUME_SET)) throw new Error('invalid_fixture_volume_set');
const action = args.shift() ?? 'up';
const allowed = ['prepare', 'up', 'recreate', 'build', 'stop-owner', 'start-owner', 'restart-replicas', 'down', 'destroy'];
if (!allowed.includes(action) || args.length > 1 || args[0] && !args[0].startsWith('--state=')) throw new Error('Use an allowed action and optional --state=/absolute/run.json');
let child;
function execute(command, commandArgs, env, quiet = false) {
  return new Promise((resolvePromise, reject) => {
    child = spawn(command, commandArgs, { cwd: folder, env, shell: false, stdio: quiet ? 'ignore' : 'inherit' });
    child.once('error', () => reject(new Error('fixture_command_unavailable')));
    child.once('exit', (code, signal) => code === 0 ? resolvePromise() : reject(new Error(signal ? 'fixture_command_interrupted' : 'fixture_command_failed')));
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child?.kill(signal));
async function createState() {
  const directory = await mkdtemp(join(tmpdir(), 'ghcp-user-pool-mysql-test-'));
  const certs = join(directory, 'certs');
  await mkdir(certs, { mode: 0o700 });
  // Each openssl invocation writes exclusively into a new mkdtemp directory.
  // spawn shell:false avoids Git Bash /CN path rewriting on Windows.
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '2',
    '-subj', '/CN=mysql-fixture.example.test', '-keyout', join(certs, 'idp-key.pem'), '-out', join(certs, 'idp-cert.pem')], process.env, true);
  await writeFile(join(directory, 'empty.env'), '# Deliberately empty; never use a deployment env file.\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'mysql-init.sql'), `USE ghcp_pool_mysql_test;
CREATE TABLE fixture_identity (id TINYINT PRIMARY KEY, project VARCHAR(80) NOT NULL);
INSERT INTO fixture_identity VALUES (1, '${PROJECT}');
CREATE USER 'pool_observer'@'%' IDENTIFIED BY 'mysql-fixture-observer-only';
GRANT SELECT ON ghcp_pool_mysql_test.* TO 'pool_observer'@'%';
CREATE USER 'pool_load'@'%' IDENTIFIED BY 'mysql-fixture-load-only';
GRANT SELECT, INSERT, UPDATE ON ghcp_pool_mysql_test.* TO 'pool_load'@'%';
`, { flag: 'wx', mode: 0o644 });
  const state = { version: 1, project: PROJECT, directory, compose, createdAt: new Date().toISOString() };
  const path = join(directory, 'run.json');
  await writeFile(path, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(`MYSQL_FIXTURE_STATE ${path}`);
  return state;
}
async function loadState(path) {
  const state = JSON.parse(await readFile(path, 'utf8'));
  const temp = await realpath(tmpdir());
  const directory = await realpath(state.directory);
  if (state.version !== 1 || state.project !== PROJECT || resolve(state.compose) !== resolve(compose)
    || dirname(directory) !== temp || !directory.slice(temp.length + 1).startsWith('ghcp-user-pool-mysql-test-')
    || resolve(path) !== join(directory, 'run.json')) throw new Error('invalid_fixture_state');
  return { ...state, directory };
}
try {
  const path = args[0]?.slice('--state='.length);
  if (!path && !['prepare', 'up', 'build'].includes(action)) throw new Error('state_required_for_existing_project');
  const state = path ? await loadState(path) : await createState();
  if (action !== 'prepare') {
    // Only the directory is interpolated. Clear Compose's implicit configuration
    // inputs; --env-file prevents automatic discovery of a checkout .env.
    const env = { ...process.env, POOL_MYSQL_TEST_DIR: state.directory, COMPOSE_DISABLE_ENV_FILE: '1' };
    for (const key of ['COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES', 'COMPOSE_ENV_FILES']) delete env[key];
    const base = ['compose', '--env-file', join(state.directory, 'empty.env'), '--project-directory', folder, '-p', PROJECT, '-f', compose];
    const operations = {
      up: ['up', '--no-build', '--pull', 'never'],
      recreate: ['up', '--no-build', '--pull', 'never', '--force-recreate'],
      build: ['build', 'proxy', 'sso', 'login', 'console'],
      'stop-owner': ['stop', '-t', '10', 'proxy'],
      'start-owner': ['start', 'proxy'],
      'restart-replicas': ['restart', '-t', '10', 'proxy', 'proxy2'],
      down: ['down'],
      destroy: ['down', '--volumes'],
    };
    await execute('docker', [...base, ...operations[action]], env);
  }
} catch {
  // Docker/openssl errors may contain environment details: do not print them.
  console.error('FAIL mysql_fixture_launcher (check prerequisites, action and state path)');
  process.exitCode = 1;
}
