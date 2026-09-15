// Start servers through preview_start. Fixed disposable project; no deployment env discovery.
import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const folder = dirname(fileURLToPath(import.meta.url));
const project = 'ghcp-user-pool-mysql-test';
const args = process.argv.slice(2), action = args.shift();
const options = {};
for (const arg of args) {
  const match = /^--(state|set|profile|rehearsal)=(.+)$/.exec(arg);
  if (!match || options[match[1]]) throw new Error('Invalid stability argument');
  options[match[1]] = match[2];
}
const operations = { up: ['up', '--no-build', '--pull', 'never', '--force-recreate'],
  start: ['up', '--no-build', '--pull', 'never'], 'stop-bridge': ['stop', 'bridge'], config: ['config', '--quiet'] };
if (!operations[action] || !options.state || !/^stability-[a-z0-9-]{1,20}$/.test(options.set ?? '')
  || !['base', 'gateway'].includes(options.profile ?? 'base')) throw new Error('Invalid stability scope');
const state = JSON.parse(await readFile(options.state, 'utf8'));
const temp = await realpath(tmpdir()), directory = await realpath(state.directory);
if (state.project !== project || state.version !== 1 || dirname(directory) !== temp
  || !directory.slice(temp.length + 1).startsWith(project + '-') || resolve(options.state) !== join(directory, 'run.json')
  || resolve(state.compose) !== join(folder, 'compose.mysql.yaml')) throw new Error('Wrong fixture state');
const env = { ...process.env, POOL_MYSQL_TEST_DIR: directory, POOL_MYSQL_VOLUME_SET: options.set, COMPOSE_DISABLE_ENV_FILE: '1' };
for (const key of ['COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES', 'COMPOSE_ENV_FILES']) delete env[key];
const command = ['compose', '--env-file', join(directory, 'empty.env'), '--project-directory', folder, '-p', project,
  '-f', join(folder, 'compose.mysql.yaml'), '-f', join(folder, 'compose.stability.yaml')];
if (options.profile === 'gateway') command.push('--profile', 'gateway');
if (options.rehearsal) {
  const path = await realpath(options.rehearsal), parent = dirname(path);
  if (dirname(parent) !== temp || !parent.slice(temp.length + 1).startsWith('ghcp-mysql-rehearsal-')
    || path !== join(parent, 'compose.rehearsal.yaml')) throw new Error('Invalid rehearsal override');
  const rehearsal = JSON.parse(await readFile(join(parent, 'state.json'), 'utf8'));
  if (rehearsal.project !== project || !/^ghcp_pool_test_rehearsal_[a-f0-9]{32}$/.test(rehearsal.database)) throw new Error('Invalid rehearsal identity');
  command.push('-f', path);
}
command.push(...operations[action]);
const child = spawn('docker', command, { cwd: folder, env, shell: false, stdio: 'inherit' });
child.on('error', () => { process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
