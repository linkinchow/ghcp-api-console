import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const child = spawn(process.execPath, [fileURLToPath(new URL('./compose.mjs', import.meta.url)), 'up', '--no-build'], {
  stdio: 'inherit',
  env: { ...process.env, POOL_SMOKE_PROJECT: 'ghcp-user-pool-gateway', POOL_SMOKE_OVERRIDE: fileURLToPath(new URL('./compose.gateway.yaml', import.meta.url)) },
});
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
