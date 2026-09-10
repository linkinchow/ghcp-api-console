import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const run = JSON.parse(readFileSync(fileURLToPath(new URL('./local-run.json', import.meta.url)), 'utf8'));
const args = process.argv.slice(2);
const child = spawn('docker', ['compose', '--env-file', run.envFile, '-p', process.env.POOL_SMOKE_PROJECT ?? run.project, '-f', run.compose,
  ...(process.env.POOL_SMOKE_OVERRIDE ? ['-f', process.env.POOL_SMOKE_OVERRIDE] : []), ...args], { stdio: 'inherit', shell: false });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
