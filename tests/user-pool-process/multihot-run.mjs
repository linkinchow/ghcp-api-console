// One bounded extension only; the exact-HEAD replicas runner is intentionally not called.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gate, productionMatch } from './multihot-safety.ts';
import { osKeys } from './replicas-safety.ts';

const started = Date.now();
gate(process.env); // Before git, children, listeners or DB access.
assert.equal(process.argv.length, 2, 'REFUSED: no runner arguments');
const cwd = fileURLToPath(new URL('../../', import.meta.url));
const clean = Object.fromEntries(osKeys.filter(name => process.env[name]).map(name => [name, process.env[name]]));
productionMatch(args => execFileSync('git', args, { cwd, env: clean, encoding: 'utf8', timeout: 4000,
  stdio: ['ignore', 'pipe', 'pipe'] }).trim());
assert.ok(Date.now() - started < 15000, 'REFUSED: baseline verification exceeded startup budget');
// Run node:test directly (TAP still emitted), avoiding an extra test-runner process.
const child = spawn(process.execPath, ['--import', 'tsx', 'tests/user-pool-process/multihot-mysql.test.ts'], {
  cwd, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...clean,
    MYSQL_POOL_MULTIHOT_TEST: '1', MYSQL_POOL_REPLICAS_TEST: '1', MYSQL_POOL_TEST_DISPOSABLE: '1',
    MYSQL_TEST_URL: process.env.MYSQL_TEST_URL, MULTIHOT_RUNNER: '1', MULTIHOT_DEADLINE_AT: String(started + 110000),
    TSX_TSCONFIG_PATH: fileURLToPath(new URL('./multihot-tsconfig.json', import.meta.url)),
  },
});
const owned = new Set();
child.on('message', message => {
  if (!message || !Number.isSafeInteger(message.pid) || message.pid <= 0 || message.pid === process.pid) return;
  if (message.type === 'multihot-child-started') owned.add(message.pid);
  if (message.type === 'multihot-child-exited') owned.delete(message.pid);
});
function killOwned() {
  for (const pid of owned) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ } }
  child.kill('SIGKILL');
}
const ceiling = setTimeout(() => { process.exitCode = 1; killOwned(); }, Math.max(1, started + 119000 - Date.now()));
child.once('error', () => { clearTimeout(ceiling); killOwned(); process.exitCode = 1; });
child.once('exit', code => {
  clearTimeout(ceiling);
  const orphaned = owned.size !== 0;
  if (orphaned) killOwned();
  process.exitCode = code === 0 && !orphaned ? 0 : 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { process.exitCode = 1; killOwned(); });
