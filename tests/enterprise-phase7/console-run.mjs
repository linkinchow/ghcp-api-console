// Main-only launcher. Requires existing, owned, healthy fixture containers and a
// locally built production Login image containing Playwright + Chromium.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flags, HARD_LIMIT_MS, insist, safeError, trustedPath, validateFixture } from './console-support.mjs';
import { assertOwnedContainer, loadState } from '../enterprise-phase5/safety.mjs';

function dockerRead(args) {
  const run = spawnSync('docker', args, { encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  insist(!run.error && run.status === 0, 'docker_inspection_failed');
  try { return JSON.parse(run.stdout); } catch { throw new Error('phase7_console_docker_inspection_shape'); }
}
export function qualifyDocker(state, containers, network, image) {
  const labels = value => value?.['com.docker.compose.project'] === state.project && value?.['io.ghcp.phase5.run-id'] === state.runId && value?.['io.ghcp.phase5.synthetic'] === 'true';
  insist(network.Internal === true && labels(network.Labels) && network.Name === `${state.project}_isolated`, 'owned_internal_network');
  const required = ['proxy-lb', 'sso', 'login', 'console', 'provider', 'proxy-1', 'proxy-2', 'proxy-3'];
  for (const service of required) {
    const own = state.ownership?.containers?.[service];
    insist(own && /^[a-f0-9]{64}$/.test(own.id) && own.name === `${state.project}-${service}-1`, 'recorded_service_identity');
    const row = containers.find(c => c.Id === own.id);
    insist(row && row.Name === `/${own.name}` && row.Config?.Labels?.['com.docker.compose.service'] === service, 'exact_owned_service_identity');
    insist(labels(row.Config.Labels) && row.State?.Running === true && (!row.State.Health || row.State.Health.Status === 'healthy'), 'owned_running_services');
    insist(Object.keys(row.NetworkSettings?.Networks ?? {}).length === 1 && row.NetworkSettings.Networks[network.Name]?.NetworkID === network.Id, 'service_network_isolation');
  }
  insist(state.images?.login === `ghcp-phase5-login:${state.runId}` && image.RepoTags?.includes(state.images.login) && /^sha256:[a-f0-9]{64}$/.test(image.Id), 'production_login_image');
  return { network: network.Id, image: image.Id };
}
export async function launch({ stateFile, output }) {
  insist(process.platform === 'linux' && process.env.PHASE5_SYNTHETIC_ONLY === '1' && process.env.PHASE7_CONSOLE_WRITES === '1', 'main_linux_explicit_write_guard');
  trustedPath(stateFile, '/opt/ghcp-test');
  insist((lstatSync(stateFile).mode & 0o077) === 0, 'private_state_permissions');
  // Merge the append-only ownership ledgers; immutable state.json alone has no
  // application container IDs. Never adopt a container by labels or name only.
  const state = loadState(stateFile);
  insist(stateFile === `${state.root}/fixture/state.json`, 'host_state_binding');
  const registryFile = `${state.root}/fixture/registry.json`; trustedPath(registryFile, '/opt/ghcp-test');
  validateFixture(state, JSON.parse(readFileSync(registryFile, 'utf8')));
  insist(state.hostPaths?.fixture === `${state.root}/fixture` && state.hostPaths?.results === `${state.root}/results`, 'host_mount_bindings');
  trustedPath(output, state.hostPaths.results); insist(dirname(output) === state.hostPaths.results && basename(output).endsWith('.json') && !existsSync(output), 'fresh_host_output');
  const scripts = dirname(fileURLToPath(import.meta.url)); insist(realpathSync(scripts) === scripts && realpathSync(state.hostPaths.fixture) === state.hostPaths.fixture && realpathSync(state.hostPaths.results) === state.hostPaths.results, 'real_mount_roots');
  // Inspect only immutable IDs already recorded by the phase 5 controller.
  const services = ['proxy-lb', 'sso', 'login', 'console', 'provider', 'proxy-1', 'proxy-2', 'proxy-3'];
  const ids = services.map(service => { const own = state.ownership.containers[service]; insist(own && /^[a-f0-9]{64}$/.test(own.id), 'recorded_service_identity'); return own.id; });
  const containers = dockerRead(['inspect', ...ids]);
  for (const service of services) assertOwnedContainer(state, containers.find(c => c.Id === state.ownership.containers[service].id), service);
  const network = dockerRead(['network', 'inspect', `${state.project}_isolated`])[0];
  const image = dockerRead(['image', 'inspect', state.images.login])[0];
  const qualified = qualifyDocker(state, containers, network, image);
  const containerName = `${state.project}-console-phase7-${basename(output, '.json')}`;
  insist(/^[a-z0-9][a-z0-9_.-]{0,120}$/.test(containerName), 'container_name');
  // Put scripts below /app so ESM resolves the production image's existing
  // /app/node_modules/playwright. No install, image pull, socket, host network,
  // privileged mode, project changes or fixture-mounted credentials in argv.
  const args = ['run', '--rm', '--pull', 'never', '--name', containerName,
    '--label', `io.ghcp.phase7.run-id=${state.runId}`, '--label', 'io.ghcp.phase7.group=C',
    '--network', qualified.network, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--shm-size', '256m',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m',
    '--mount', `type=bind,src=${scripts},dst=/app/tests/enterprise-phase7,readonly`,
    '--mount', `type=bind,src=${state.hostPaths.fixture},dst=/fixture,readonly`,
    '--mount', `type=bind,src=${state.hostPaths.results},dst=/results`,
    '-e', 'PHASE5_SYNTHETIC_ONLY=1', '-e', 'PHASE7_CONSOLE_WRITES=1', '--entrypoint', 'node', qualified.image,
    '/app/tests/enterprise-phase7/console-browser.mjs', '--state', '/fixture/state.json', '--output', `/results/${basename(output)}`];
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let overflow = false, bytes = 0;
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes <= 65536) process.stdout.write(chunk); else overflow = true; });
  // Never echo arbitrary Docker stderr (it can include mount or config data).
  child.stderr.resume();
  const timer = setTimeout(() => {
    // Stop only this invocation's named container after verifying its label.
    try { const row = dockerRead(['inspect', containerName])[0]; if (row.Config?.Labels?.['io.ghcp.phase7.run-id'] === state.runId && row.Config?.Labels?.['io.ghcp.phase7.group'] === 'C') spawnSync('docker', ['stop', '--time', '1', containerName], { stdio: 'ignore', timeout: 5000 }); } catch { /* runner may already have exited */ }
    child.kill();
  }, HARD_LIMIT_MS + 5000);
  try {
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
    insist(code === 0 && !overflow, 'container_runner_failed');
    insist(existsSync(output), 'report_not_written');
    const report = JSON.parse(readFileSync(output, 'utf8')); insist(report.status === 'PASS' && report.runId === state.runId, 'report_failed');
  } finally { clearTimeout(timer); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) launch(flags(process.argv.slice(2))).catch(error => { process.stderr.write(JSON.stringify({ status: 'FAIL', error: safeError(error) }) + '\n'); process.exitCode = 1; });
