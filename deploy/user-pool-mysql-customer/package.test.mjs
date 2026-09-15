import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICES, parseArgs, buildSpec, requireExternalNewOutput } from './build-images.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const commit = '5ea75af7ac0000b37758efd751a606ea86010a00';
const output = path.join(os.tmpdir(), `ghcp-customer-build-plan-${randomUUID()}`);
const valid = ['--commit', commit, '--output', output, '--image-prefix', 'customer-ghcp', '--platform', 'linux/amd64'];

test('requires immutable SHA, explicit platform/output, no arbitrary flags', () => {
  assert.equal(parseArgs(valid).execute, false);
  assert.equal(parseArgs([...valid, '--execute-build']).execute, true);
  for (const invalid of [
    [...valid, '--push'], [...valid, '--execute-build', '--execute-build'],
    valid.map((value) => value === commit ? 'main' : value),
    valid.map((value) => value === output ? './out' : value),
    valid.map((value) => value === 'customer-ghcp' ? 'registry.example.test/team' : value),
    valid.map((value) => value === 'linux/amd64' ? 'auto' : value),
  ]) assert.throws(() => parseArgs(invalid));
});

test('all four builds reuse fixed Dockerfiles and archive stdin, without run/push args', () => {
  const options = parseArgs(valid);
  assert.deepEqual(SERVICES, ['sso', 'login', 'proxy', 'console']);
  for (const service of SERVICES) {
    const spec = buildSpec(options, service);
    assert.equal(spec.dockerfile, `src/${service}/Dockerfile`);
    assert.equal(spec.tag, `customer-ghcp-${service}:${commit}`);
    assert.equal(spec.args[0], 'build');
    assert.equal(spec.args.at(-1), '-');
    assert.ok(spec.args.includes(`org.opencontainers.image.revision=${commit}`));
    assert.equal(spec.args.some((arg) => ['--push', 'run', 'up', '--secret'].includes(arg)), false);
  }
  assert.throws(() => buildSpec(options, 'mock-github'));
});

test('refuses existing evidence directories and paths inside checkout', () => {
  assert.throws(() => requireExternalNewOutput(directory, root), /already exist/);
  assert.throws(() => requireExternalNewOutput(path.join(root, `not-created-${randomUUID()}`), root), /outside/);
  assert.equal(requireExternalNewOutput(output, root), output);
});

test('actual default plan records source hashes and creates no output or Docker dependency', () => {
  const result = spawnSync(process.execPath, [path.join(directory, 'build-images.mjs'), ...valid], { encoding: 'utf8', timeout: 15000, shell: false });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.status, 'plan-only');
  assert.equal(plan.deploymentApproved, false);
  assert.equal(plan.commit, commit);
  assert.equal(plan.images.length, 4);
  assert.equal(existsSync(output), false);
  const git = spawnSync('git', ['show', `${commit}:package-lock.json`], { cwd: root, encoding: 'buffer', shell: false });
  assert.equal(git.status, 0);
  assert.equal(plan.inputs.find((input) => input.path === 'package-lock.json').sha256, createHash('sha256').update(git.stdout).digest('hex'));
  assert.equal(plan.inputs.filter((input) => input.baseImageReferences).length, 4);
});

test('invalid missing commit rejects before output creation', () => {
  const args = valid.map((arg) => arg === commit ? 'f'.repeat(40) : arg);
  const result = spawnSync(process.execPath, [path.join(directory, 'build-images.mjs'), ...args], { encoding: 'utf8', timeout: 15000, shell: false });
  assert.equal(result.status, 1);
  assert.equal(existsSync(output), false);
});

test('template preserves explicit startup block and existing health contracts', () => {
  const yaml = readFileSync(path.join(directory, 'rancher.template.yaml'), 'utf8');
  assert.match(yaml, /replicas: 3/);
  assert.match(yaml, /CUSTOMER_PAUSED_DATABASE_APPROVED: BLOCKED/);
  assert.match(yaml, /require-approved-paused-database/);
  assert.match(yaml, /READY_IDLE_TARGET: "0"/);
  assert.doesNotMatch(yaml, /POOL_PAUSED:/);
  assert.match(yaml, /readinessProbe:[\s\S]*?path: \/readyz/);
  assert.match(yaml, /livenessProbe:[\s\S]*?path: \/healthz/);
  assert.match(yaml, /MYSQL_SSL_MODE: verify-ca/);
  assert.match(yaml, /type: ClusterIP/);
  assert.doesNotMatch(yaml, /kind: (Secret|PersistentVolumeClaim|Ingress|StatefulSet)/);
  const server = readFileSync(path.join(root, 'src/proxy/src/server.ts'), 'utf8');
  const health = server.slice(server.indexOf("app.get('/healthz'"), server.indexOf("app.get('/readyz'"));
  assert.doesNotMatch(health, /pingStorage|assertUserPoolOwner/);
  const runtime = readFileSync(path.join(root, 'src/proxy/src/userPool/runtime.ts'), 'utf8');
  assert.match(runtime, /getStorage\(\) instanceof SqliteStorage && !worker\.isActive\(\)/);
  const proxyPackage = JSON.parse(readFileSync(path.join(root, 'src/proxy/package.json'), 'utf8'));
  assert.equal(proxyPackage.scripts['start:prod'], 'node dist/index.js');
});
