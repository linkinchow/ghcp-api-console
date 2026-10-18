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

test('all four builds use the release Dockerfile targets and archive stdin, without run/push args', () => {
  const options = parseArgs(valid);
  assert.deepEqual(SERVICES, ['sso', 'login', 'proxy', 'console']);
  for (const service of SERVICES) {
    const spec = buildSpec(options, service);
    assert.equal(spec.dockerfile, 'deploy/images/Dockerfile.release');
    assert.equal(spec.args[spec.args.indexOf('--target') + 1], service);
    assert.equal(spec.args.includes('--build-arg'), false);
    assert.equal(spec.tag, `customer-ghcp-${service}:${commit}`);
    assert.equal(spec.args[0], 'build');
    assert.equal(spec.args.at(-1), '-');
    assert.ok(spec.args.includes(`org.opencontainers.image.revision=${commit}`));
    assert.equal(spec.args.some((arg) => ['--push', 'run', 'up', '--secret'].includes(arg)), false);
  }
  assert.throws(() => buildSpec(options, 'mock-github'));
});

test('an optional npm registry is passed as a build arg and must be https without credentials', () => {
  const registry = 'https://registry.example.test/npm/';
  const spec = buildSpec(parseArgs([...valid, '--npm-registry', registry]), 'proxy');
  assert.equal(spec.args[spec.args.indexOf('--build-arg') + 1], `NPM_REGISTRY=${registry}`);
  for (const invalid of ['http://registry.example.test/', 'https://user:secret@registry.example.test/', 'registry.example.test']) {
    assert.throws(() => parseArgs([...valid, '--npm-registry', invalid]), /npm-registry/);
  }
});

test('--release-line multi adds the RELEASE_LINE build arg; single is the Dockerfile default', () => {
  const multi = buildSpec(parseArgs([...valid, '--release-line', 'multi']), 'proxy');
  assert.equal(multi.args[multi.args.indexOf('--build-arg') + 1], 'RELEASE_LINE=multi');
  const single = buildSpec(parseArgs([...valid, '--release-line', 'single']), 'proxy');
  assert.equal(single.args.includes('--build-arg'), false);
  for (const invalid of ['latest', 'MULTI', '']) {
    assert.throws(() => parseArgs([...valid, '--release-line', invalid]), /release-line/);
  }
});

test('first multi-enterprise upgrade: Proxy Deployments recreate, keep grace period, expose new variables', () => {
  for (const template of ['rancher.template.yaml', 'kubernetes.template.yaml']) {
    const yaml = readFileSync(path.join(directory, template), 'utf8');
    assert.match(yaml, /strategy:\r?\n\s+type: Recreate\r?\n/);
    assert.doesNotMatch(yaml, /rollingUpdate:/);
    assert.match(yaml, /terminationGracePeriodSeconds: 45/);
    assert.match(yaml, /MYSQL_MIGRATION_LOCK_WAIT_SECONDS: "30"/);
    assert.match(yaml, /# ENTERPRISE_REGISTRY_FILE: \/config\/enterprise-registry\.json/);
    assert.match(yaml, /# DIRECT_MODE_ENTERPRISE_ID: default/);
  }
});

test('refuses existing evidence directories and paths inside checkout', () => {
  assert.throws(() => requireExternalNewOutput(directory, root), /already exist/);
  assert.throws(() => requireExternalNewOutput(path.join(root, `not-created-${randomUUID()}`), root), /outside/);
  assert.equal(requireExternalNewOutput(output, root), output);
});

test('actual default plan records source hashes and creates no output or Docker dependency', () => {
  // The plan reads build inputs from Git, so use a commit that contains the release Dockerfile.
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', shell: false }).stdout.trim();
  const args = valid.map((arg) => arg === commit ? head : arg);
  const result = spawnSync(process.execPath, [path.join(directory, 'build-images.mjs'), ...args], { encoding: 'utf8', timeout: 15000, shell: false });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.status, 'plan-only');
  assert.equal(plan.deploymentApproved, false);
  assert.equal(plan.commit, head);
  assert.equal(plan.images.length, 4);
  assert.equal(existsSync(output), false);
  const git = spawnSync('git', ['show', `${head}:package-lock.json`], { cwd: root, encoding: 'buffer', shell: false });
  assert.equal(git.status, 0);
  assert.equal(plan.inputs.find((input) => input.path === 'package-lock.json').sha256, createHash('sha256').update(git.stdout).digest('hex'));
  const dockerfiles = plan.inputs.filter((input) => input.baseImageReferences);
  assert.equal(dockerfiles.length, 1);
  assert.match(dockerfiles[0].baseImageReferences.join(), /^node:22-bookworm-slim@sha256:[a-f0-9]{64}$/);
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
  // The image entrypoint (Tini + node) must not be replaced: overrides bypass signal forwarding.
  for (const template of ['rancher.template.yaml', 'kubernetes.template.yaml']) {
    const text = readFileSync(path.join(directory, template), 'utf8');
    const proxyContainer = text.slice(text.indexOf('- name: proxy'), text.indexOf('ports:', text.indexOf('- name: proxy')));
    assert.doesNotMatch(proxyContainer, /^\s+(command|args):/m);
  }
  const server = readFileSync(path.join(root, 'src/proxy/src/server.ts'), 'utf8');
  const health = server.slice(server.indexOf("app.get('/healthz'"), server.indexOf("app.get('/readyz'"));
  assert.doesNotMatch(health, /pingStorage|assertUserPoolOwner/);
  const runtime = readFileSync(path.join(root, 'src/proxy/src/userPool/runtime.ts'), 'utf8');
  assert.match(runtime, /getStorage\(\) instanceof SqliteStorage && !worker\.isActive\(\)/);
  const proxyPackage = JSON.parse(readFileSync(path.join(root, 'src/proxy/package.json'), 'utf8'));
  assert.equal(proxyPackage.scripts['start:prod'], 'node dist/index.js');
});
