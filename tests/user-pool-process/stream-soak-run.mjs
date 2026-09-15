// Opt-in runner: validate budget before even git; compare production to immutable
// 356 source, not HEAD, so an additive test overlay on the frozen VM is allowed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseline, osKeys } from './replicas-safety.ts';
import { cleanupSeconds, gate, options } from './stream-soak-safety.ts';

const config = options(process.argv.slice(2));
gate(process.env);
const cwd = fileURLToPath(new URL('../../', import.meta.url));
const clean = Object.fromEntries(osKeys.filter(name => process.env[name]).map(name => [name, process.env[name]]));
const engineEnv = { MYSQL_POOL_STREAM_SOAK_TEST: '1', MYSQL_POOL_TEST_DISPOSABLE: '1', MYSQL_TEST_URL: process.env.MYSQL_TEST_URL };
for (const name of Object.keys(process.env)) if (!osKeys.includes(name)) delete process.env[name];
Object.assign(process.env, engineEnv);
const git = args => execFileSync('git', args, { cwd, env: clean, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
assert.equal(git(['rev-parse', `${baseline}:src`]), git(['rev-parse', 'HEAD:src']), 'REFUSED: HEAD product differs from frozen356');
assert.equal(git(['diff', '--name-only', baseline, '--', 'src']), '', 'REFUSED: changed product source');
assert.equal(git(['status', '--porcelain', '--untracked-files=all', '--', 'src']), '', 'REFUSED: product source dirty');
const directory = fileURLToPath(new URL('./', import.meta.url));
const hashes = {};
for (const name of (await readdir(directory)).filter(name => /^(stream-soak-|replicas-)/.test(name) || name === 'README.stream-soak.md').sort()) {
  hashes[name] = createHash('sha256').update(await readFile(resolve(directory, name))).digest('hex');
}
const provenance = { head: git(['rev-parse', 'HEAD']), baseline, productTree: git(['rev-parse', `${baseline}:src`]), hashes };
const reportPath = config.report ? resolve(cwd, config.report) : undefined;
if (reportPath) {
  // Explicit user-supplied output only; parent directory must already exist.
  const fs = await import('node:fs/promises');
  assert.ok((await fs.stat(dirname(reportPath))).isDirectory());
  const handle = await fs.open(reportPath, 'wx'); await handle.close();
}
const abort = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => abort.abort());
// Last-resort process-wide ceiling. Children also self-exit on IPC disconnect.
// External managed runner must independently bound the process group to the same
// duration+cleanup budget and collect the last checkpoint if this watchdog fires.
const watchdog = setTimeout(() => process.exit(1), (config.duration + cleanupSeconds) * 1000);
let writes = Promise.resolve();
let checkpoints = 0;
try {
  const { runSoak } = await import('./stream-soak-harness.ts');
  await runSoak(config, async report => {
    const output = JSON.stringify({ ...report, provenance });
    assert.ok(Buffer.byteLength(output) <= 2 * 1024 * 1024, 'Bounded report size');
    assert.ok(++checkpoints <= 380, 'Bounded checkpoint count');
    if (reportPath) {
      writes = writes.then(async () => { await writeFile(`${reportPath}.tmp`, output + '\n', { flag: 'w' }); await rename(`${reportPath}.tmp`, reportPath); });
      await writes;
    }
    // Fixed-size summary, no raw child logs, URLs, tokens, SQL or request ledger.
    console.log(JSON.stringify({ type: 'stream-soak-checkpoint', status: report.status, stage: report.stage,
      elapsedSeconds: Number(report.elapsedSeconds.toFixed(3)), database: report.database,
      counts: report.counts, processes: report.processes, peaks: report.peaks, mock: report.mock,
      failure: report.failure, cleanup: report.cleanup }));
  }, abort.signal);
} catch {
  process.exitCode = 1;
  console.error('stream-soak FAILED/REFUSED; inspect bounded report and exact sibling cleanup (no raw credentials/errors printed)');
} finally { clearTimeout(watchdog); await writes; }
