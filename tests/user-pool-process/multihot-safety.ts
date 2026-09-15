import assert from 'node:assert/strict';
import { baseline, gate as replicasGate } from './replicas-safety.js';

export { baseline };
export const count = 5;
export const hotCount = 3;
export const burst = 4;
export const lockMs = 6500;
export const responseMs = 6500; // Existing 5s SQL budget + 1.5s fixture scheduling allowance.
export const productionPaths = ['src', 'package.json', 'package-lock.json', 'tsconfig.base.json'];
export function gate(env: NodeJS.ProcessEnv): URL {
  assert.equal(env.MYSQL_POOL_MULTIHOT_TEST, '1', 'REFUSED: MYSQL_POOL_MULTIHOT_TEST=1 required');
  return replicasGate(env);
}
export function enabled(env: NodeJS.ProcessEnv): boolean {
  if (env.MYSQL_POOL_MULTIHOT_TEST === undefined) return false;
  gate(env); return true;
}
export function deadline(env: NodeJS.ProcessEnv): number {
  assert.equal(env.MULTIHOT_RUNNER, '1', 'REFUSED: use multihot-run.mjs');
  const at = Number(env.MULTIHOT_DEADLINE_AT);
  assert.ok(Number.isSafeInteger(at) && at > Date.now() && at <= Date.now() + 110000,
    'REFUSED: bounded runner deadline required');
  return at;
}
export function productionMatch(git: (args: string[]) => string): void {
  git(['merge-base', '--is-ancestor', baseline, 'HEAD']);
  assert.equal(git(['diff', '--name-only', baseline, 'HEAD', '--', ...productionPaths]), '',
    'REFUSED: production differs from frozen v5');
  assert.equal(git(['status', '--porcelain', '--untracked-files=all', '--', ...productionPaths]), '',
    'REFUSED: production working tree must be unchanged');
}
