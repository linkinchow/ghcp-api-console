// Preparation only: no Docker, servers, builds or tests. Never loads .env.
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, randomUUID, X509Certificate } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Each qualification uses its own Compose project (and so its own volumes); never reuse one.
export const PROJECT = process.env.RELEASE_QUALIFICATION_PROJECT ?? '';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const COMPOSE = join(ROOT, 'tests/image-release/qualification-compose.json');
export const RUN_PREFIX = 'release-qualification-run-';
const BASELINE = { prefix: 'ghcp-baseline', tag: 'ac354ac-amd64-20261016' };
// A locally cached MySQL 8.4 image: by ID, or by tag with an optional pinned digest.
const MYSQL_IMAGE_REFERENCE = /^(?:sha256:[a-f0-9]{64}|mysql:8\.4(?:\.[0-9]+)?(?:@sha256:[a-f0-9]{64})?)$/;

export const sha = (value) => createHash('sha256')
  .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
  .digest('hex');

export async function loadState(path) {
  const state = JSON.parse(await readFile(path, 'utf8'));
  const root = await realpath(join(ROOT, '.claude'));
  const directory = await realpath(state.directory);
  assert.equal(dirname(directory), root, 'state_not_run_owned');
  assert.ok(directory.slice(root.length + 1).startsWith(RUN_PREFIX), 'state_not_run_owned');
  assert.equal(resolve(path), join(directory, 'run.json'), 'state_path_mismatch');
  assert.equal(state.version, 1);
  assert.equal(state.project, PROJECT);
  assert.equal(resolve(state.compose), COMPOSE);
  assert.match(state.mysqlImage, MYSQL_IMAGE_REFERENCE);
  return { ...state, directory };
}

export async function prepare() {
  assert.equal(process.argv.length, 2, 'prepare_accepts_env_only');
  assert.match(PROJECT, /^ghcp-release-qualification-[a-z0-9-]+$/, 'qualification_project_required');
  const candidateTag = process.env.RELEASE_QUALIFICATION_CANDIDATE_TAG;
  assert.match(candidateTag ?? '', /^single-slug-[a-f0-9]{7}-amd64-r\d+$/, 'candidate_tag_required');
  const certDir = process.env.RELEASE_QUALIFICATION_CERTS_DIR;
  const mysqlImage = process.env.RELEASE_QUALIFICATION_MYSQL_IMAGE;
  assert.ok(certDir, 'synthetic_certs_directory_required');
  assert.match(mysqlImage ?? '', MYSQL_IMAGE_REFERENCE, 'cached_mysql_8_4_reference_required');
  const certificatePaths = ['idp-cert.pem', 'idp-key.pem'].map((name) => join(resolve(certDir), name));
  for (const path of certificatePaths) {
    assert.ok((await lstat(path)).isFile(), 'regular_synthetic_pem_required');
  }
  const cert = await readFile(certificatePaths[0]);
  const key = await readFile(certificatePaths[1]);
  const x509 = new X509Certificate(cert);
  assert.equal(
    x509.publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
    createPublicKey(createPrivateKey(key)).export({ type: 'spki', format: 'der' }).toString('hex'),
    'certificate_key_mismatch',
  );
  assert.ok(Date.parse(x509.validTo) > Date.now() + 600000, 'synthetic_certificate_expired');
  const directory = join(ROOT, '.claude', `${RUN_PREFIX}${randomUUID()}`);
  await mkdir(join(directory, 'fixtures'), { recursive: true, mode: 0o700 });
  await mkdir(join(directory, 'certs'), { mode: 0o700 });
  await mkdir(join(directory, 'logs'), { mode: 0o700 });
  await writeFile(join(directory, 'certs/idp-cert.pem'), cert, { flag: 'wx', mode: 0o644 });
  await writeFile(join(directory, 'certs/idp-key.pem'), key, { flag: 'wx', mode: 0o600 });
  // Rewrite the docker-user-pool fixtures to this project's name and ports so both can coexist.
  const replacements = new Map([
    ['ghcp-user-pool-mysql-test', PROJECT],
    ['18100', '19300'],
    ['18101', '19301'],
    ['18102', '19302'],
    ['18104', '19304'],
    ['33184', '34384'],
  ]);
  const fixtures = {};
  for (const name of ['mysql-smoke.mjs', 'mysql-bridge.mjs', 'mock-services.mjs']) {
    const original = await readFile(join(ROOT, 'tests/docker-user-pool', name), 'utf8');
    let adapted = original;
    if (name !== 'mock-services.mjs') {
      assert.ok(adapted.includes("'ghcp-user-pool-mysql-test'"), 'fixture_project_marker_missing');
      for (const [from, to] of replacements) adapted = adapted.replaceAll(from, to);
      for (const from of replacements.keys()) assert.ok(!adapted.includes(from), 'old_project_or_port_retained');
    }
    await writeFile(join(directory, 'fixtures', name), adapted, { flag: 'wx', mode: 0o644 });
    fixtures[name] = { sourceSha256: sha(original), adaptedSha256: sha(adapted) };
  }
  await copyFile(
    join(ROOT, 'tests/image-release/qualification-verify-runtime.mjs'),
    join(directory, 'fixtures/qualification-verify-runtime.mjs'),
  );
  await writeFile(
    join(directory, 'empty.env'),
    '# Fixture-only; prevents discovery of deployment env files.\n',
    { flag: 'wx' },
  );
  await writeFile(join(directory, 'mysql-init.sql'), `USE ghcp_pool_mysql_test;
CREATE TABLE fixture_identity (id TINYINT PRIMARY KEY, project VARCHAR(80) NOT NULL);
INSERT INTO fixture_identity VALUES (1, '${PROJECT}');
CREATE USER 'pool_observer'@'%' IDENTIFIED BY 'mysql-fixture-observer-only';
GRANT SELECT ON ghcp_pool_mysql_test.* TO 'pool_observer'@'%';
CREATE USER 'pool_load'@'%' IDENTIFIED BY 'mysql-fixture-load-only';
GRANT SELECT, INSERT, UPDATE ON ghcp_pool_mysql_test.* TO 'pool_load'@'%';
`, { flag: 'wx', mode: 0o644 });
  const state = {
    version: 1,
    project: PROJECT,
    directory,
    compose: COMPOSE,
    mysqlImage,
    createdAt: new Date().toISOString(),
    certSha256: sha(cert),
    fixtures,
    baseline: BASELINE,
    candidate: { prefix: 'ghcp-release', tag: candidateTag },
  };
  await writeFile(join(directory, 'run.json'), JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(`RELEASE_QUALIFICATION_STATE ${join(directory, 'run.json')}`);
  return state;
}

// Run only when executed directly; qualification-run.mjs imports this module for its exports.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await prepare();
  } catch {
    console.error('FAIL qualification_prepare_invalid_fixture_prerequisites');
    process.exitCode = 1;
  }
}
