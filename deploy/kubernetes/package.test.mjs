// Static checks of deploy/kubernetes: render every overlay (alone and with every component) with
// `kubectl kustomize` and assert the deployment invariants. Needs kubectl (bundled kustomize); never contacts a
// cluster (KUBECONFIG points at a file that does not exist). Run: node --test deploy/kubernetes/package.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const env = { ...process.env, KUBECONFIG: path.join(os.tmpdir(), `ghcp-no-kubeconfig-${randomUUID()}`) };

const DIGESTS = {
  proxy: 'docker.io/linkinchow/ghcp-proxy@sha256:00453e3b81a3fea67ef05d4fce1e3def680dac96ae9ca288a85d1a77c74997b6',
  sso: 'docker.io/linkinchow/ghcp-sso@sha256:5b112760945fa5444d5720d48ddae5a4da9fa42ead08a8fa5715356395dcefe7',
  login: 'docker.io/linkinchow/ghcp-login@sha256:6a7e48f79a86a04a5343ad0e6c4ac9f294ddd87c772f36927f9bbb148ffe1d2e',
  console: 'docker.io/linkinchow/ghcp-console@sha256:a1605e6304597387e3e193223b01823d89b7a007d7e7bb5d8e44e236b97d3e2c',
};
const COMPONENTS = ['ingress-sso', 'ingress-console', 'mysql-dba-schema', 'network-policy'];
const OVERLAYS = ['github-com', 'ghe-com'];
const SENSITIVE = ['API_KEY', 'MYSQL_URL', 'INTERNAL_API_TOKEN', 'SESSION_SECRET', 'SCIM_TOKEN',
  'GITHUB_COPILOT_SEAT_PAT', 'SSO_DEFAULT_USER_PASSWORD', 'MODELS_ADMIN_COPILOT_TOKEN'];
const SECRET_NAMES = ['ghcp-internal', 'ghcp-proxy', 'ghcp-sso', 'ghcp-sso-saml'];

function run(command, args, input) {
  const result = spawnSync(command, args, { encoding: 'utf8', env, input, timeout: 60000, shell: false, maxBuffer: 64 << 20 });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/** Splits concatenated JSON documents (kubectl prints one per object). */
function parseJsonStream(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && --depth === 0) objects.push(JSON.parse(text.slice(start, i + 1)));
  }
  return objects;
}

/** kustomize → YAML text and parsed objects (YAML → JSON by kubectl itself, offline). */
function render(target) {
  const yaml = run('kubectl', ['kustomize', target]);
  const json = run('kubectl', ['annotate', '--local', '-f', '-', '-o', 'json', 'ghcp.test/rendered=1'], yaml);
  return { yaml, objects: parseJsonStream(json) };
}

/**
 * An overlay with the given components, through a temporary kustomization next to the overlays (kustomize only
 * accepts relative paths); the directory is removed afterwards.
 */
function renderWith(overlay, components) {
  const dir = mkdtempSync(path.join(directory, 'overlays', '.render-test-'));
  try {
    writeFileSync(path.join(dir, 'kustomization.yaml'), [
      'apiVersion: kustomize.config.k8s.io/v1beta1',
      'kind: Kustomization',
      'namespace: ghcp',
      'resources:',
      `  - ../${overlay}`,
      'components:',
      ...components.map((name) => `  - ../../components/${name}`),
      '',
    ].join('\n'));
    return render(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const renders = new Map();
function rendered(name) {
  if (!renders.has(name)) {
    const [overlay, all] = name.split('+');
    renders.set(name, all ? renderWith(overlay, COMPONENTS) : render(path.join(directory, 'overlays', overlay)));
  }
  return renders.get(name);
}
const ALL = [...OVERLAYS, ...OVERLAYS.map((overlay) => `${overlay}+all`)];

const byKind = (objects, kind) => objects.filter((object) => object.kind === kind);
const named = (objects, kind, name) => objects.find((object) => object.kind === kind && object.metadata.name === name);
const configMap = (objects, name) => named(objects, 'ConfigMap', name)?.data ?? {};
const deployment = (objects, service) => named(objects, 'Deployment', `ghcp-${service}`);
const podSpec = (objects, service) => deployment(objects, service).spec.template.spec;
const main = (objects, service) => podSpec(objects, service).containers.find((c) => c.name === service);

function envOf(objects, container) {
  const values = {};
  for (const source of container.envFrom ?? []) Object.assign(values, configMap(objects, source.configMapRef.name));
  for (const entry of container.env ?? []) if ('value' in entry) values[entry.name] = entry.value;
  return values;
}

function shutdownReleaseGraceSeconds() {
  const source = readFileSync(path.join(root, 'src/packages/shared/src/shutdown.ts'), 'utf8');
  const match = /const RELEASE_GRACE_MS = ([\d_]+);/.exec(source);
  assert.ok(match, 'RELEASE_GRACE_MS not found in shutdown.ts');
  return Number(match[1].replaceAll('_', '')) / 1000;
}

test('every overlay renders alone and with every component', () => {
  for (const name of ALL) {
    const { objects } = rendered(name);
    assert.deepEqual(byKind(objects, 'Deployment').map((d) => d.metadata.name).sort(),
      ['ghcp-console', 'ghcp-login', 'ghcp-proxy', 'ghcp-sso'], name);
    assert.ok(objects.every((object) => object.metadata.namespace === 'ghcp'), `${name}: namespace`);
  }
  const all = rendered('github-com+all').objects;
  assert.equal(byKind(all, 'Ingress').length, 2);
  assert.equal(byKind(all, 'NetworkPolicy').length, 6);
});

test('images are the published r2 digests, identical in init and main containers', () => {
  for (const name of ALL) {
    const { objects } = rendered(name);
    for (const service of Object.keys(DIGESTS)) {
      const spec = podSpec(objects, service);
      for (const container of [...spec.initContainers, ...spec.containers]) {
        assert.equal(container.image, DIGESTS[service], `${name}/${service}/${container.name}`);
        assert.equal(container.imagePullPolicy, 'IfNotPresent');
      }
    }
  }
  const base = readFileSync(path.join(directory, 'base/kustomization.yaml'), 'utf8');
  const releaseDoc = readFileSync(path.join(root, 'docs/multi-enterprise-release-validation.md'), 'utf8');
  for (const reference of Object.values(DIGESTS)) {
    assert.ok(releaseDoc.includes(reference), `release record lists ${reference}`);
    assert.ok(base.includes(reference.split('@')[1]));
  }
});

test('grace period covers preStop + SHUTDOWN_TIMEOUT_MS + release grace, with margin', () => {
  const release = shutdownReleaseGraceSeconds();
  for (const name of ALL) {
    const { objects } = rendered(name);
    for (const service of Object.keys(DIGESTS)) {
      const container = main(objects, service);
      const preStop = container.lifecycle?.preStop?.exec?.command?.join(' ') ?? '';
      const sleepMs = Number(/setTimeout\(\(\) => \{\}, (\d+)\)/.exec(preStop)?.[1]);
      assert.ok(sleepMs > 0, `${service}: preStop sleep`);
      const shutdownMs = Number(envOf(objects, container).SHUTDOWN_TIMEOUT_MS);
      assert.ok(shutdownMs > 0, `${service}: SHUTDOWN_TIMEOUT_MS`);
      const grace = podSpec(objects, service).terminationGracePeriodSeconds;
      assert.ok(grace >= sleepMs / 1000 + shutdownMs / 1000 + release + 5,
        `${service}: grace ${grace} < ${sleepMs / 1000} + ${shutdownMs / 1000} + ${release} + 5`);
      // The image runs Tini as PID 1; overriding the command bypasses signal forwarding.
      assert.equal(container.command, undefined, `${service}: command override`);
      assert.equal(container.args, undefined, `${service}: args override`);
    }
  }
});

test('no secret values: Secrets are referenced by name only and secret.example holds placeholders', () => {
  for (const name of ALL) {
    const { objects, yaml } = rendered(name);
    assert.equal(byKind(objects, 'Secret').length, 0, `${name}: no Secret objects`);
    for (const map of byKind(objects, 'ConfigMap')) {
      for (const key of SENSITIVE) assert.ok(!(key in (map.data ?? {})), `${name}: ${key} in ConfigMap ${map.metadata.name}`);
    }
    for (const deploymentObject of byKind(objects, 'Deployment')) {
      const spec = deploymentObject.spec.template.spec;
      for (const container of [...spec.initContainers, ...spec.containers]) {
        for (const entry of container.env ?? []) {
          if (SENSITIVE.includes(entry.name)) {
            assert.ok(entry.valueFrom?.secretKeyRef, `${name}: ${entry.name} must come from a Secret`);
          }
          if (entry.valueFrom?.secretKeyRef) assert.ok(SECRET_NAMES.includes(entry.valueFrom.secretKeyRef.name));
        }
      }
      for (const volume of spec.volumes ?? []) if (volume.secret) assert.ok(SECRET_NAMES.includes(volume.secret.secretName));
    }
    assert.doesNotMatch(yaml, /BEGIN [A-Z ]*PRIVATE KEY|mysql:\/\/[^R\s]/, `${name}: inline credential`);
  }
  const example = readFileSync(path.join(directory, 'secret.example.yaml'), 'utf8');
  const docs = parseJsonStream(run('kubectl', ['annotate', '--local', '-f', '-', '-o', 'json', 'ghcp.test/x=1'], example));
  assert.deepEqual(docs.filter((d) => d.kind === 'Secret').map((d) => d.metadata.name).sort(), [...SECRET_NAMES].sort());
  for (const doc of docs) {
    for (const value of Object.values(doc.stringData ?? doc.data ?? {})) assert.match(value, /REPLACE_/);
  }
  for (const file of walk(directory).filter((p) => p.endsWith('kustomization.yaml'))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /^[^#\n]*secret\.example/m, `${file} must not include secret.example.yaml`);
  }
});

test('Proxy: 2+ replicas, caller-lease on MySQL, rolling update without unavailability, PDB, probes', () => {
  for (const name of ALL) {
    const { objects } = rendered(name);
    const proxy = deployment(objects, 'proxy');
    assert.ok(proxy.spec.replicas >= 2);
    assert.deepEqual(proxy.spec.strategy, { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } });
    const values = envOf(objects, main(objects, 'proxy'));
    assert.equal(values.ACCOUNT_ROUTING_MODE, 'caller-lease');
    assert.equal(values.STORAGE_DRIVER, 'mysql');
    assert.equal(values.MYSQL_SSL_MODE, 'verify-ca');
    assert.equal(values.READY_IDLE_TARGET, '0');
    assert.equal(values.PROXY_ERROR_DIAGNOSTICS_ENABLED, 'false');
    assert.equal(values.MYSQL_AUTO_MIGRATE, name.endsWith('+all') ? 'false' : 'true');
    const pdb = named(objects, 'PodDisruptionBudget', 'ghcp-proxy');
    assert.equal(pdb.spec.minAvailable, 1);
    assert.deepEqual(pdb.spec.selector.matchLabels, proxy.spec.selector.matchLabels);
    const container = main(objects, 'proxy');
    assert.equal(container.readinessProbe.httpGet.path, '/readyz');
    assert.equal(container.livenessProbe.httpGet.path, '/healthz');
    assert.equal(container.startupProbe.httpGet.path, '/healthz');
    assert.equal(named(objects, 'Service', 'ghcp-proxy').spec.type, 'ClusterIP');
  }
});

test('SQLite services: one replica, Recreate, data on a ReadWriteOnce PVC, /healthz probes', () => {
  const dataClaims = { sso: ['ghcp-sso-data'], login: ['ghcp-login-data', 'ghcp-login-logs'], console: ['ghcp-console-data'] };
  for (const name of ALL) {
    const { objects } = rendered(name);
    for (const [service, claims] of Object.entries(dataClaims)) {
      const object = deployment(objects, service);
      assert.equal(object.spec.replicas, 1, `${service} replicas`);
      assert.deepEqual(object.spec.strategy, { type: 'Recreate' }, `${service} strategy`);
      const mounted = object.spec.template.spec.volumes.filter((v) => v.persistentVolumeClaim)
        .map((v) => v.persistentVolumeClaim.claimName).sort();
      assert.deepEqual(mounted, [...claims].sort());
      const container = main(objects, service);
      const data = object.spec.template.spec.volumes.find((v) => v.persistentVolumeClaim?.claimName === claims[0]);
      assert.equal(container.volumeMounts.find((m) => m.name === data.name).mountPath, '/data');
      for (const claim of claims) assert.deepEqual(named(objects, 'PersistentVolumeClaim', claim).spec.accessModes, ['ReadWriteOnce']);
      for (const probe of ['startupProbe', 'readinessProbe', 'livenessProbe']) assert.equal(container[probe].httpGet.path, '/healthz');
    }
    const login = podSpec(objects, 'login');
    const shm = login.volumes.find((v) => v.name === 'dshm');
    assert.equal(shm.emptyDir.medium, 'Memory');
    assert.equal(main(objects, 'login').volumeMounts.find((m) => m.name === 'dshm').mountPath, '/dev/shm');
  }
});

test('security context: non-root, read-only root filesystem, no capabilities, no service account token', () => {
  for (const name of ALL) {
    const { objects } = rendered(name);
    for (const service of Object.keys(DIGESTS)) {
      const spec = podSpec(objects, service);
      assert.equal(spec.automountServiceAccountToken, false);
      assert.equal(spec.securityContext.runAsNonRoot, true);
      assert.equal(spec.securityContext.runAsUser, 1000);
      assert.equal(spec.securityContext.seccompProfile.type, 'RuntimeDefault');
      for (const container of [...spec.initContainers, ...spec.containers]) {
        assert.equal(container.securityContext.readOnlyRootFilesystem, true, `${service}/${container.name}`);
        assert.equal(container.securityContext.allowPrivilegeEscalation, false);
        assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
        assert.ok(container.resources.requests && container.resources.limits, `${service}/${container.name} resources`);
      }
      assert.ok(main(objects, service).volumeMounts.some((m) => m.mountPath === '/tmp'), `${service} writable /tmp`);
    }
  }
});

test('github.com and GHE.com overlays set the enterprise variables the guide requires', () => {
  const dotcom = configMap(rendered('github-com').objects, 'ghcp-enterprise');
  assert.equal(dotcom.GITHUB_BASE_URL, '');
  assert.equal(dotcom.ENTERPRISE_SHORTCODE, 'REPLACE_ENTERPRISE_SHORTCODE');
  const dotcomSso = configMap(rendered('github-com').objects, 'ghcp-sso-config');
  assert.match(dotcomSso.SCIM_BASE_URL, /^https:\/\/api\.github\.com\/scim\/v2\/enterprises\//);
  const ghe = configMap(rendered('ghe-com').objects, 'ghcp-enterprise');
  assert.match(ghe.GITHUB_BASE_URL, /^https:\/\/REPLACE_GHE_SUBDOMAIN\.ghe\.com$/);
  assert.ok(!('ENTERPRISE_SHORTCODE' in ghe), 'no ENTERPRISE_SHORTCODE on GHE.com');
  const gheSso = configMap(rendered('ghe-com').objects, 'ghcp-sso-config');
  assert.match(gheSso.SP_ACS_URL, /^https:\/\/REPLACE_GHE_SUBDOMAIN\.ghe\.com\/enterprises\/[^/]+\/saml\/consume$/);
  for (const name of ALL) {
    const { objects } = rendered(name);
    // One source for the SSO origin: SSO BASE_URL and Login SSO_URL derive from SSO_PUBLIC_BASE_URL.
    const ssoEnv = main(objects, 'sso').env.find((e) => e.name === 'BASE_URL');
    const loginEnv = main(objects, 'login').env.find((e) => e.name === 'SSO_URL');
    assert.equal(ssoEnv.value, '$(SSO_PUBLIC_BASE_URL)');
    assert.equal(loginEnv.value, '$(SSO_PUBLIC_BASE_URL)/login');
    for (const service of ['sso', 'login']) {
      assert.ok(main(objects, service).envFrom.some((s) => s.configMapRef.name === 'ghcp-enterprise'));
    }
    assert.ok(!('ENTERPRISE_REGISTRY_FILE' in envOf(objects, main(objects, 'proxy'))), 'single enterprise: no registry');
  }
});

test('optional components: Ingress, DBA schema, network policies', () => {
  const { objects } = rendered('ghe-com+all');
  assert.equal(configMap(objects, 'ghcp-enterprise').SSO_PUBLIC_BASE_URL, 'https://REPLACE_SSO_HOST');
  assert.equal(configMap(objects, 'ghcp-console-config').CONSOLE_PUBLIC_BASE_URL, 'https://REPLACE_CONSOLE_HOST');
  const sso = named(objects, 'Ingress', 'ghcp-sso');
  assert.deepEqual(sso.spec.rules[0].http.paths.map((p) => [p.path, p.pathType]), [['/', 'Prefix']]);
  assert.equal(sso.spec.rules[0].http.paths[0].backend.service.name, 'ghcp-sso');
  assert.equal(named(objects, 'Ingress', 'ghcp-console').spec.rules[0].http.paths[0].backend.service.name, 'ghcp-console');
  assert.ok(!named(objects, 'Ingress', 'ghcp-proxy'), 'Proxy is never exposed through Ingress');

  const policies = byKind(objects, 'NetworkPolicy');
  const deny = named(objects, 'NetworkPolicy', 'ghcp-default-deny');
  assert.deepEqual(deny.spec.podSelector.matchLabels, { 'app.kubernetes.io/part-of': 'ghcp' });
  assert.deepEqual(deny.spec.policyTypes, ['Ingress', 'Egress']);
  for (const service of Object.keys(DIGESTS)) {
    assert.equal(deployment(objects, service).spec.template.metadata.labels['app.kubernetes.io/part-of'], 'ghcp');
  }
  const proxy = named(objects, 'NetworkPolicy', 'ghcp-proxy');
  assert.deepEqual(proxy.spec.ingress.map((rule) => rule.ports.map((p) => p.port)), [[3000]]);
  const sources = proxy.spec.ingress[0].from;
  assert.equal(sources.length, 2);
  assert.equal(sources[0].namespaceSelector.matchLabels['kubernetes.io/metadata.name'], 'REPLACE_LITELLM_NAMESPACE');
  assert.deepEqual(sources[1].podSelector.matchExpressions[0].values, ['ghcp-sso', 'ghcp-login', 'ghcp-console']);
  assert.ok(proxy.spec.egress.some((rule) => rule.ports.some((p) => p.port === 3306) && rule.to[0].ipBlock));
  for (const policy of policies) {
    for (const rule of policy.spec.egress ?? []) {
      for (const peer of rule.to ?? []) {
        if (peer.ipBlock?.cidr === '0.0.0.0/0') {
          assert.deepEqual(rule.ports.map((p) => p.port), [443], `${policy.metadata.name}: internet only on 443`);
          assert.ok(peer.ipBlock.except.includes('169.254.0.0/16'), 'cloud metadata excluded');
        }
      }
    }
  }
  assert.ok(!policies.some((p) => p.metadata.name === 'ghcp-console' && p.spec.egress.some((r) => r.to.some((t) => t.ipBlock))),
    'Console has no internet egress');
});

test('start gate: refuses placeholders and an unapproved configuration, passes an approved one', () => {
  const { objects } = rendered('github-com');
  const gate = podSpec(objects, 'proxy').initContainers.find((c) => c.name === 'require-approved-config');
  assert.deepEqual(gate.command.slice(0, 2), ['node', '-e']);
  for (const service of Object.keys(DIGESTS)) {
    const spec = podSpec(objects, service);
    assert.deepEqual(spec.initContainers.map((c) => c.name), ['require-approved-config']);
    assert.deepEqual(spec.initContainers[0].command, gate.command, `${service}: same gate`);
  }
  assert.equal(configMap(objects, 'ghcp-common').GHCP_CONFIG_APPROVED, 'BLOCKED');
  const runGate = (extra) => spawnSync(process.execPath, ['-e', gate.command[2]], {
    encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...extra } });
  const placeholder = runGate({ GHCP_CONFIG_APPROVED: 'true', ENTERPRISE_SLUG: 'REPLACE_ENTERPRISE_SLUG' });
  assert.equal(placeholder.status, 1);
  assert.match(placeholder.stderr, /placeholders not replaced: ENTERPRISE_SLUG/);
  const blocked = runGate({ GHCP_CONFIG_APPROVED: 'BLOCKED', ENTERPRISE_SLUG: 'contoso' });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /GHCP_CONFIG_APPROVED is not "true"/);
  const approved = runGate({ GHCP_CONFIG_APPROVED: 'true', ENTERPRISE_SLUG: 'contoso' });
  assert.equal(approved.status, 0, approved.stderr);
});

test('ConfigMap keys are variables the services actually read', () => {
  const sources = walk(path.join(root, 'src')).filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts')
    && !p.includes(`${path.sep}node_modules${path.sep}`)).map((p) => readFileSync(p, 'utf8')).join('\n');
  // Not read by the services: the start gate, the SSO origin used by $(...) expansion, and Chromium's HOME.
  const notProduct = new Set(['GHCP_CONFIG_APPROVED', 'SSO_PUBLIC_BASE_URL', 'HOME']);
  const { objects } = rendered('github-com+all');
  for (const map of byKind(objects, 'ConfigMap')) {
    for (const key of Object.keys(map.data ?? {})) {
      if (notProduct.has(key)) continue;
      assert.ok(sources.includes(key), `${map.metadata.name}.${key} is not read by any service`);
    }
  }
});

test('test overlays render with local images and keep the customer invariants', () => {
  for (const overlay of ['kind-ghe', 'kind-dba']) {
    const { objects } = render(path.join(root, 'tests/kubernetes/overlays', overlay));
    for (const service of Object.keys(DIGESTS)) {
      for (const container of podSpec(objects, service).containers) {
        assert.equal(container.image, `ghcp-release-${service}:multi-3d6db1a-amd64-r3`);
      }
      assert.equal(podSpec(objects, service).terminationGracePeriodSeconds, 45);
    }
    assert.equal(byKind(objects, 'Secret').length, 0);
  }
});

test('the new deployment guide points to deploy/kubernetes', () => {
  const guide = readFileSync(path.join(root, 'docs/multi-enterprise-new-deployment-guide.md'), 'utf8');
  const section = guide.slice(guide.indexOf('### 5.2'), guide.indexOf('## 6.'));
  assert.match(section, /deploy\/kubernetes\//);
  assert.doesNotMatch(section, /SSO、Login、Console 没有仓库模板/);
});

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist') return [];
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
