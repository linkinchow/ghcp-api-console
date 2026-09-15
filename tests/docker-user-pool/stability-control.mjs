import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { PROJECT, connectDatabase, check } from './mysql-smoke.mjs';
const exec = promisify(execFile);
const services = ['proxy', 'proxy2', 'mysql', 'mock', 'pool-lb'];
const name = service => `${PROJECT}-${service}-1`;
async function docker(args) { return (await exec('docker', args, { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout.trim(); }
async function remoteControl(action) {
  // The dedicated key on the service VM MUST have a forced command for
  // /usr/local/bin/ghcp-fixture-control and restrict/no-forwarding options.
  // That wrapper accepts ONLY the five actions below via SSH_ORIGINAL_COMMAND,
  // unsets POOL_AZURE_SPLIT_FIXTURE, then runs this local controller. No shell
  // fragment or Docker command ever comes from the caller. Host keys must be
  // provisioned/verified out of band; never accept-new or invoke ssh-keyscan here.
  const { stdout } = await exec('ssh', ['-F', '/dev/null', '-T', '-p', '22',
    '-i', '/home/pooltest/.ssh/ghcp-fixture-control',
    '-oStrictHostKeyChecking=yes', '-oUserKnownHostsFile=/home/pooltest/.ssh/ghcp-known-hosts',
    '-oGlobalKnownHostsFile=/dev/null', '-oUpdateHostKeys=no', '-oVerifyHostKeyDNS=no',
    '-oBatchMode=yes', '-oIdentitiesOnly=yes', '-oIdentityAgent=none',
    '-oPreferredAuthentications=publickey', '-oPasswordAuthentication=no', '-oKbdInteractiveAuthentication=no',
    '-oClearAllForwardings=yes', '-oForwardAgent=no', '-oForwardX11=no', '-oProxyCommand=none',
    '-oControlMaster=no', '-oControlPath=none', '-oConnectTimeout=5', '-oConnectionAttempts=1',
    '-oServerAliveInterval=5', '-oServerAliveCountMax=2', 'pooltest@10.89.0.4', action],
  { timeout: 40000, maxBuffer: 1024 * 1024, windowsHide: true });
  const result = JSON.parse(stdout.trim());
  check(result?.fixture === true && result.project === PROJECT, 'wrong_remote_control_fixture');
  check(action === 'snapshot' ? Array.isArray(result.containers) && Object.hasOwn(result, 'mysql')
    : result.action === action && typeof result.running === 'boolean' && typeof result.paused === 'boolean', 'invalid_remote_control_result');
  return result;
}
async function validate(service) {
  const value = JSON.parse(await docker(['inspect', name(service)]))[0];
  check(value.Config.Labels['com.docker.compose.project'] === PROJECT && value.Config.Labels['com.docker.compose.service'] === service, 'wrong_container_scope');
  return value;
}
function bytes(text) {
  const match = /^([\d.]+)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB)$/.exec(text.trim());
  if (!match) return null;
  const powers = { B: 1, kB: 1000, KB: 1000, KiB: 1024, MB: 1000000, MiB: 1048576, GB: 1000000000, GiB: 1073741824 };
  return Math.round(Number(match[1]) * powers[match[2]]);
}
export async function control(action) {
  check(['stop-proxy', 'start-proxy', 'pause-mysql', 'unpause-mysql', 'snapshot'].includes(action), 'invalid_control_action');
  if (process.env.POOL_AZURE_SPLIT_FIXTURE === '1') return remoteControl(action);
  if (action === 'snapshot') {
    await Promise.all(services.map(validate));
    const lines = await docker(['stats', '--no-stream', '--format', '{{json .}}', ...services.map(name)]);
    const containers = lines.split('\n').filter(Boolean).map(line => {
      const row = JSON.parse(line);
      return { service: services.find(service => name(service) === row.Name), cpuPercent: Number(String(row.CPUPerc).replace('%', '')),
        memoryBytes: bytes(row.MemUsage.split('/')[0]), pids: Number(row.PIDs) || 0 };
    });
    let mysql = null;
    const state = await validate('mysql');
    if (state.State.Running && !state.State.Paused) {
      let db;
      try {
        db = await connectDatabase();
        const [rows] = await db.query({ sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Max_used_connections')", timeout: 5000 });
        mysql = { threadsConnected: Number(rows.find(row => row.Variable_name === 'Threads_connected')?.Value), maxUsedConnections: Number(rows.find(row => row.Variable_name === 'Max_used_connections')?.Value) };
      } catch {} finally { db?.destroy(); }
    }
    return { fixture: true, project: PROJECT, containers, mysql };
  }
  const service = action.endsWith('mysql') ? 'mysql' : 'proxy';
  const before = await validate(service);
  if (action === 'stop-proxy' && before.State.Running) await docker(['stop', '-t', '2', name(service)]);
  if (action === 'start-proxy' && !before.State.Running) await docker(['start', name(service)]);
  if (action === 'pause-mysql' && !before.State.Paused) await docker(['pause', name(service)]);
  if (action === 'unpause-mysql' && before.State.Paused) await docker(['unpause', name(service)]);
  const after = await validate(service);
  return { fixture: true, project: PROJECT, action, running: after.State.Running, paused: after.State.Paused };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { check(process.argv.length === 3, 'invalid_control_arguments'); console.log(JSON.stringify(await control(process.argv[2]))); }
  catch { console.error('FAIL isolated_stability_control'); process.exitCode = 1; }
}
