// Offline contracts only: no listeners, SSH, Docker, IMDS, SQL or other network.
// Run alongside the parent fixture's mysql-smoke.mjs after integrating the files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { FORWARDS, checkOptIn, verifyLoader, main } from './azure-load-bridge.mjs';

const PROJECT = 'ghcp-user-pool-mysql-test';
const marker = 'purpose=ghcp-user-pool-isolated-test\n';
const interfaces = { eth0: [{ address: '10.89.0.5', internal: false }] };
const metadata = () => ({ compute: { name: 'vm-ghcp-test-load', osType: 'Linux', resourceGroupName: 'rg-ghcp-user-pool' },
  network: { interface: [{ ipv4: { ipAddress: [{ privateIpAddress: '10.89.0.5' }] } }] } });

test('bridge mapping is frozen, loopback-only, fixed private destinations and same ports', () => {
  assert.deepEqual(FORWARDS, [18100, 18101, 18102, 18103, 18104, 18105, 18106, 18107, 33184]
    .map(port => ({ listenHost: '127.0.0.1', port, targetHost: '10.89.0.4', targetPort: port })));
  assert.throws(() => { FORWARDS[0].targetHost = '192.0.2.1'; }, TypeError);
  assert.throws(() => FORWARDS.push({ port: 1 }), TypeError);
});

test('bridge requires exact flag and opt-in, Linux, and rejects every override', () => {
  const env = { POOL_AZURE_SPLIT_FIXTURE: '1' }, args = ['--confirm-isolated-azure-fixture'];
  checkOptIn(args, env, 'linux');
  for (const invalid of [[], [...args, '--host=192.0.2.1'], [...args, '--port=1234'], [...args, args[0]], ['--help']]) {
    assert.throws(() => checkOptIn(invalid, env, 'linux'), /explicit_isolated_azure_confirmation/);
  }
  for (const value of [undefined, '', 'true', PROJECT]) {
    assert.throws(() => checkOptIn(args, { POOL_AZURE_SPLIT_FIXTURE: value }, 'linux'), /confirmation/);
  }
  assert.throws(() => checkOptIn(args, env, 'win32'), /linux_required/);
});

test('bridge pins the VM, resource group, purpose, metadata private IP and actual NIC', () => {
  verifyLoader(metadata(), marker, interfaces);
  const upper = metadata(); upper.compute.resourceGroupName = 'RG-GHCP-USER-POOL';
  verifyLoader(upper, marker, interfaces);
  for (const [key, value] of [['name', 'vm-ghcp-test-services'], ['resourceGroupName', 'unrelated-rg'], ['osType', 'Windows']]) {
    const wrong = metadata(); wrong.compute[key] = value;
    assert.throws(() => verifyLoader(wrong, marker, interfaces), /wrong_azure_loader_identity/);
  }
  for (const wrong of ['', 'purpose=other\n', `purpose=other\n${marker}`, `${marker}${marker}`]) {
    assert.throws(() => verifyLoader(metadata(), wrong, interfaces), /wrong_azure_fixture_marker/);
  }
  const wrong = metadata(); wrong.network.interface[0].ipv4.ipAddress[0].privateIpAddress = '10.89.0.4';
  assert.throws(() => verifyLoader(wrong, marker, interfaces), /wrong_azure_loader_private_ip/);
  assert.throws(() => verifyLoader(metadata(), marker, {}), /interface_missing/);
  assert.throws(() => verifyLoader(metadata(), marker, { lo: [{ address: '10.89.0.5', internal: true }] }), /interface_missing/);
  assert.throws(() => verifyLoader({}, marker, interfaces), /wrong_azure_loader_identity/);
});

test('refusal is sanitized and happens before metadata or listeners', async () => {
  const previous = process.env.POOL_AZURE_SPLIT_FIXTURE, originalError = console.error;
  const output = [];
  console.error = value => output.push(value);
  try {
    delete process.env.POOL_AZURE_SPLIT_FIXTURE;
    assert.equal(await main(['--confirm-isolated-azure-fixture']), 1);
    process.env.POOL_AZURE_SPLIT_FIXTURE = '1';
    assert.equal(await main([]), 1);
    assert.equal(await main(['--confirm-isolated-azure-fixture', '--target=192.0.2.1']), 1);
    assert.deepEqual(output, Array(3).fill('FAIL isolated_azure_load_bridge'));
  } finally {
    console.error = originalError;
    if (previous === undefined) delete process.env.POOL_AZURE_SPLIT_FIXTURE;
    else process.env.POOL_AZURE_SPLIT_FIXTURE = previous;
  }
});

// Capture promisify(execFile) at module import, then immediately restore the
// built-in. The fake fails closed unless a test explicitly supplies a response.
let execute = () => { throw new Error('unexpected_external_process'); };
const originalExecFile = childProcess.execFile;
const fakeExecFile = () => { throw new Error('unexpected_callback_process'); };
fakeExecFile[promisify.custom] = (...args) => Promise.resolve().then(() => execute(...args));
let control;
try {
  childProcess.execFile = fakeExecFile; syncBuiltinESMExports();
  ({ control } = await import('./stability-control.mjs'));
} finally { childProcess.execFile = originalExecFile; syncBuiltinESMExports(); }

async function withMode(value, work) {
  const previous = process.env.POOL_AZURE_SPLIT_FIXTURE;
  if (value === undefined) delete process.env.POOL_AZURE_SPLIT_FIXTURE;
  else process.env.POOL_AZURE_SPLIT_FIXTURE = value;
  try { await work(); }
  finally {
    execute = () => { throw new Error('unexpected_external_process'); };
    if (previous === undefined) delete process.env.POOL_AZURE_SPLIT_FIXTURE;
    else process.env.POOL_AZURE_SPLIT_FIXTURE = previous;
  }
}

test('split control sends one allowlisted action via pinned noninteractive SSH only', async () => withMode('1', async () => {
  for (const action of ['stop-proxy', 'start-proxy', 'pause-mysql', 'unpause-mysql', 'snapshot']) {
    const expected = { fixture: true, project: PROJECT, ...(action === 'snapshot'
      ? { containers: [], mysql: null } : { action, running: false, paused: false }) };
    let calls = 0;
    execute = (command, args, options) => {
      calls++;
      assert.equal(command, 'ssh');
      assert.deepEqual(args.slice(0, 7), ['-F', '/dev/null', '-T', '-p', '22', '-i', '/home/pooltest/.ssh/ghcp-fixture-control']);
      assert.deepEqual(args.slice(-2), ['pooltest@10.89.0.4', action]);
      for (const flag of ['-oStrictHostKeyChecking=yes', '-oUserKnownHostsFile=/home/pooltest/.ssh/ghcp-known-hosts',
        '-oGlobalKnownHostsFile=/dev/null', '-oUpdateHostKeys=no', '-oVerifyHostKeyDNS=no', '-oBatchMode=yes',
        '-oIdentityAgent=none', '-oIdentitiesOnly=yes', '-oClearAllForwardings=yes', '-oForwardAgent=no',
        '-oForwardX11=no', '-oProxyCommand=none', '-oControlMaster=no', '-oControlPath=none',
        '-oPasswordAuthentication=no', '-oKbdInteractiveAuthentication=no']) assert.ok(args.includes(flag), flag);
      assert.equal(options.shell, undefined);
      assert.ok(options.timeout < 45000); // inside the unchanged soak controller deadline
      return { stdout: `\n${JSON.stringify(expected)}\n`, stderr: '' };
    };
    assert.deepEqual(await control(action), expected);
    assert.equal(calls, 1);
  }
}));

test('invalid actions never spawn and SSH failure/invalid response never falls back to Docker', async () => withMode('1', async () => {
  let calls = 0;
  execute = () => { calls++; throw new Error('synthetic_ssh_failure'); };
  for (const action of ['snapshot; id', '--help', 'destroy', 'stop-proxy extra', undefined]) {
    await assert.rejects(control(action), /invalid_control_action/);
  }
  assert.equal(calls, 0);
  await assert.rejects(control('snapshot'), /synthetic_ssh_failure/);
  assert.equal(calls, 1);
  for (const data of [null, { fixture: true, project: 'unrelated' }, { fixture: true, project: PROJECT, action: 'pause-mysql', running: false, paused: true }]) {
    execute = command => { assert.equal(command, 'ssh'); return { stdout: JSON.stringify(data) }; };
    await assert.rejects(control('stop-proxy'), /wrong_remote_control_fixture|invalid_remote_control_result/);
  }
  execute = command => { assert.equal(command, 'ssh'); return { stdout: 'untrusted banner\n{}' }; };
  await assert.rejects(control('snapshot'), SyntaxError);
}));

test('absent/non-exact split opt-in preserves local labeled-container control', async () => {
  for (const mode of [undefined, '0', 'true']) await withMode(mode, async () => {
    const calls = [];
    execute = (command, args) => {
      assert.equal(command, 'docker'); calls.push(args);
      return { stdout: JSON.stringify([{ Config: { Labels: { 'com.docker.compose.project': PROJECT,
        'com.docker.compose.service': 'proxy' } }, State: { Running: false, Paused: false } }]) };
    };
    assert.deepEqual(await control('stop-proxy'), { fixture: true, project: PROJECT, action: 'stop-proxy', running: false, paused: false });
    assert.deepEqual(calls, Array(2).fill(['inspect', `${PROJECT}-proxy-1`]));
    execute = () => ({ stdout: JSON.stringify([{ Config: { Labels: { 'com.docker.compose.project': 'unrelated',
      'com.docker.compose.service': 'proxy' } } }]) });
    await assert.rejects(control('stop-proxy'), /wrong_container_scope/);
  });
});
