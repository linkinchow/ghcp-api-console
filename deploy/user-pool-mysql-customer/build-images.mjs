#!/usr/bin/env node
// Built-ins only. Default is a read-only plan; --execute-build explicitly creates local artifacts.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICES = Object.freeze(['sso', 'login', 'proxy', 'console']);
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '../..');
const HELP = `Build customer-owned images from one exact, locally available Git commit.

node deploy/user-pool-mysql-customer/build-images.mjs \\
  --commit <40-lowercase-hex-SHA> --output <new-absolute-directory-outside-checkout> \\
  --image-prefix <local-name-prefix> --platform <linux/amd64|linux/arm64> [--execute-build]

Without --execute-build: validate source and print a build plan; no Docker or writes.
With --execute-build: archive only the exact commit, build four existing Dockerfiles,
record local image IDs and build inputs. No fetch, checkout, push, container startup,
application environment loading, database access, migration or host installation.
Docker builds use the existing npm ci / Login browser install inside their images.
`;

export function parseArgs(args) {
  const result = { execute: false };
  const keys = new Map([
    ['--commit', 'commit'], ['--output', 'output'],
    ['--image-prefix', 'prefix'], ['--platform', 'platform'],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--execute-build') {
      if (result.execute) throw new Error('Duplicate --execute-build');
      result.execute = true;
    } else if (keys.has(arg)) {
      const key = keys.get(arg);
      if (result[key] !== undefined) throw new Error(`Duplicate ${arg}`);
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      result[key] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!/^[a-f0-9]{40}$/.test(result.commit ?? '')) throw new Error('Supply a full lowercase 40-character Git commit SHA');
  if (!path.isAbsolute(result.output ?? '')) throw new Error('--output must be an absolute path');
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(result.prefix ?? '')) throw new Error('--image-prefix must be a local name, without registry, tag or shell syntax');
  if (!['linux/amd64', 'linux/arm64'].includes(result.platform)) throw new Error('Explicit linux/amd64 or linux/arm64 platform required; platform support must be verified by the customer');
  return result;
}

export function buildSpec(options, service) {
  if (!SERVICES.includes(service)) throw new Error('Unsupported service');
  const tag = `${options.prefix}-${service}:${options.commit}`;
  return {
    service,
    dockerfile: `src/${service}/Dockerfile`,
    tag,
    args: [
      'build', '--platform', options.platform,
      '--file', `src/${service}/Dockerfile`, '--tag', tag,
      '--label', `org.opencontainers.image.revision=${options.commit}`,
      '--iidfile', path.join(options.output, `${service}.iid`), '-',
    ],
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true, shell: false,
    maxBuffer: 16 * 1024 * 1024, ...options,
  });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (exit ${result.status ?? 'unavailable'}); stop and inspect the local output before retrying`);
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

export function requireExternalNewOutput(output, root) {
  if (existsSync(output)) throw new Error('Output must not already exist; never overwrite previous evidence');
  const parent = realpathSync(path.dirname(output));
  const resolved = path.join(parent, path.basename(output));
  const relative = path.relative(realpathSync(root), resolved);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Output must be outside the source checkout');
  }
  return resolved;
}

export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') { console.log(HELP); return; }
  const options = parseArgs(args);
  options.output = requireExternalNewOutput(options.output, repoRoot);
  const resolvedCommit = run('git', ['rev-parse', '--verify', `${options.commit}^{commit}`]);
  if (resolvedCommit !== options.commit) throw new Error('Commit resolution must match the supplied exact SHA');
  // Read all build inputs from Git, not from potentially modified checkout files.
  const files = ['package.json', 'package-lock.json', 'tsconfig.base.json', '.dockerignore', ...SERVICES.map((s) => `src/${s}/Dockerfile`)];
  const inputDetails = files.map((file) => {
    const result = spawnSync('git', ['show', `${options.commit}:${file}`], { cwd: repoRoot, encoding: 'buffer', shell: false, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`Cannot read source input ${file}`);
    return { path: file, sha256: sha256(result.stdout), ...(file.endsWith('Dockerfile') ? { baseImageReferences: [...result.stdout.toString('utf8').matchAll(/^FROM\s+(.+)$/gm)].map((match) => match[1].trim()) } : {}) };
  });
  const specs = SERVICES.map((service) => buildSpec(options, service));
  if (!options.execute) {
    console.log(JSON.stringify({ status: 'plan-only', commit: options.commit, platform: options.platform, output: options.output, inputs: inputDetails, images: specs.map(({ service, dockerfile, tag }) => ({ service, dockerfile, tag })), deploymentApproved: false }, null, 2));
    return;
  }
  // This is the only build branch. No Docker calls occur during a default plan.
  const dockerVersion = run('docker', ['version', '--format', '{{.Client.Version}} / {{.Server.Version}}']);
  mkdirSync(options.output, { recursive: false, mode: 0o700 });
  const archivePath = path.join(options.output, 'source.tar');
  const archiveFd = openSync(archivePath, 'wx', 0o600);
  try { run('git', ['archive', '--format=tar', options.commit], { stdio: ['ignore', archiveFd, 'inherit'] }); }
  finally { closeSync(archiveFd); }
  const manifestPath = path.join(options.output, 'build-manifest.json');
  const manifest = {
    schemaVersion: 1,
    status: 'building',
    startedAt: new Date().toISOString(),
    commit: options.commit,
    sourceArchiveSha256: sha256(readFileSync(archivePath)),
    buildScriptSha256: sha256(readFileSync(scriptPath)),
    platform: options.platform,
    dockerVersion,
    nodeVersion: process.version,
    inputs: inputDetails,
    reproducibility: 'Exact source commit and lockfile; existing Dockerfiles use mutable base tags and Login browser/OS packages. Byte-identical builds are not claimed. Resolved base digests are not captured by this script.',
    customerRegistryManifestDigest: null,
    deploymentApproved: false,
    images: [],
  };
  const save = () => writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  save();
  try {
    for (const spec of specs) {
      const inputFd = openSync(archivePath, 'r');
      try { run('docker', spec.args, { stdio: [inputFd, 'inherit', 'inherit'] }); }
      finally { closeSync(inputFd); }
      const imageId = readFileSync(path.join(options.output, `${spec.service}.iid`), 'utf8').trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Docker returned an invalid local image ID');
      const inspected = JSON.parse(run('docker', ['image', 'inspect', imageId, '--format', '{{json .}}']));
      if (inspected.Id !== imageId || inspected.Config?.Labels?.['org.opencontainers.image.revision'] !== options.commit) throw new Error('Image identity/revision verification failed');
      const expectedPlatform = options.platform.split('/');
      if (inspected.Os !== expectedPlatform[0] || inspected.Architecture !== expectedPlatform[1]) throw new Error('Built platform differs from requested platform');
      manifest.images.push({ service: spec.service, dockerfile: spec.dockerfile, localTag: spec.tag, localImageId: imageId, os: inspected.Os, architecture: inspected.Architecture, customerRegistryReference: null, customerRegistryManifestDigest: null, rancherRuntimeImageId: null });
      save();
    }
    manifest.status = 'built-locally-not-deployed';
    manifest.finishedAt = new Date().toISOString();
    save();
    console.log(`Recorded four local image IDs in ${manifestPath}. No images were pushed and no services were started.`);
  } catch (error) {
    manifest.status = 'failed-partial-build';
    manifest.finishedAt = new Date().toISOString();
    save();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try { main(); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Build failed'); process.exitCode = 1; }
}
