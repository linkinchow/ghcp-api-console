// Dedicated opt-in runner. Does not modify or call the frozen tests launcher.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { baseline, gate, osKeys } from './replicas-safety.ts';

gate(process.env); // Refuse before even invoking git, Node children or networking.
assert.equal(process.argv.length, 2, 'No runner arguments accepted');
const cwd = fileURLToPath(new URL('../../', import.meta.url));
const clean = Object.fromEntries(osKeys.filter(name => process.env[name]).map(name => [name, process.env[name]]));
const git = args => execFileSync('git', args, { cwd, env: clean, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
assert.equal(git(['rev-parse', 'HEAD']), baseline, 'REFUSED: run only the exact frozen v5 commit');
assert.equal(git(['status', '--porcelain', '--untracked-files=all', '--', 'src']), '', 'REFUSED: product source must be unchanged');
const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1',
  'tests/user-pool-process/replicas-mysql.test.ts'], { cwd, stdio: 'inherit', env: { ...clean,
  MYSQL_POOL_REPLICAS_TEST: '1', MYSQL_POOL_TEST_DISPOSABLE: '1', MYSQL_TEST_URL: process.env.MYSQL_TEST_URL,
  TSX_TSCONFIG_PATH: fileURLToPath(new URL('./replicas-tsconfig.json', import.meta.url)),
} });
const ceiling = setTimeout(() => { child.kill('SIGKILL'); }, 410000);
child.once('error', () => { clearTimeout(ceiling); process.exitCode = 1; });
child.once('exit', code => { clearTimeout(ceiling); process.exitCode = code === 0 ? 0 : 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { child.kill(signal); });
