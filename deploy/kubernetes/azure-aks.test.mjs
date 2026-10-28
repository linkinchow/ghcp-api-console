// Static checks of the AKS overlay (overlays/azure-aks) and components (azure-aks, azure-proxy-ilb): render with
// `kubectl kustomize` and assert that the Azure wiring keeps every invariant of the base and that each pod gets every
// Secret it references from its own SecretProviderClass. Never contacts a cluster (KUBECONFIG points at a missing file).
// Run: node --test deploy/kubernetes/azure-aks.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const env = { ...process.env, KUBECONFIG: path.join(os.tmpdir(), `ghcp-no-kubeconfig-${randomUUID()}`) };

const DIGESTS = {
  proxy: 'sha256:14ed9384f57a95c5cb4c1a5bd34d10d722d89d4e8ba9b3b49fcd6e32e41ad5f3',
  sso: 'sha256:93e5be2c5fd8a9166cd67897c52466b833b9bbb12e2eede9dbe7700204b31214',
  login: 'sha256:96408b4fc3b0d0cd76083cc4bb8a1dcaf91ffa56152a8f7603caa1cc1a968338',
  console: 'sha256:6526394ff321ab15a4222423013689eb4959dc465dbec6262aa0a84ae267cc90',
};
const SERVICES = Object.keys(DIGESTS);
// Azure Database for MySQL root CAs (Microsoft Learn, TLS how-to, 2026-07-17), SHA-256 cross-checked against two trust stores.
const MYSQL_CA_FINGERPRINTS = {
  'DigiCert Global Root G2': 'CB:3C:CB:B7:60:31:E5:E0:13:8F:8D:D3:9A:23:F9:DE:47:FF:C3:5E:43:C1:14:4C:EA:27:D4:6A:5A:B1:CB:5F',
  'Microsoft RSA Root Certificate Authority 2017': 'C7:41:F7:0F:4B:2A:8D:88:BF:2E:71:C1:41:22:EF:53:EF:10:EB:A0:CF:A5:E6:4C:FA:20:F4:18:85:30:73:E0',
};

function run(command, args, input) {
  const result = spawnSync(command, args, { encoding: 'utf8', env, input, timeout: 60000, shell: false, maxBuffer: 64 << 20 });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

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

function render(target) {
  const yaml = run('kubectl', ['kustomize', target]);
  const json = run('kubectl', ['annotate', '--local', '-f', '-', '-o', 'json', 'ghcp.test/rendered=1'], yaml);
  return { yaml, objects: parseJsonStream(json) };
}

/** A temporary kustomization next to the overlays (kustomize only accepts relative paths). */
function renderComposed(lines) {
  const dir = mkdtempSync(path.join(directory, 'overlays', '.azure-test-'));
  try {
    writeFileSync(path.join(dir, 'kustomization.yaml'), ['apiVersion: kustomize.config.k8s.io/v1beta1', 'kind: Kustomization', ...lines, ''].join('\n'));
    return render(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cache = new Map();
function rendered(name) {
  if (!cache.has(name)) {
    const value = {
      'azure-aks': () => render(path.join(directory, 'overlays', 'azure-aks')),
      'azure-aks-ghe': () => renderComposed(['namespace: ghcp', 'resources:', '  - ../ghe-com', 'components:', '  - ../../components/azure-aks']),
      'azure-aks-all': () => renderComposed(['namespace: ghcp', 'resources:', '  - ../github-com', 'components:',
        '  - ../../components/azure-aks', '  - ../../components/network-policy', '  - ../../components/mysql-dba-schema',
        '  - ../../components/azure-proxy-ilb']),
    }[name]();
    cache.set(name, value);
  }
  return cache.get(name);
}
const ALL = ['azure-aks', 'azure-aks-ghe', 'azure-aks-all'];

const byKind = (objects, kind) => objects.filter((o) => o.kind === kind);
const named = (objects, kind, name) => objects.find((o) => o.kind === kind && o.metadata.name === name);
const podSpec = (objects, service) => named(objects, 'Deployment', `ghcp-${service}`).spec.template.spec;

test('the AKS overlay renders for github.com, GHE.com and with every component', () => {
  for (const name of ALL) {
    const { objects } = rendered(name);
    assert.deepEqual(byKind(objects, 'Deployment').map((d) => d.metadata.name).sort(), SERVICES.map((s) => `ghcp-${s}`).sort());
    for (const object of objects) {
      if (object.kind === 'StorageClass') assert.equal(object.metadata.namespace, undefined, 'StorageClass is cluster-scoped');
      else assert.equal(object.metadata.namespace, 'ghcp', `${name}: ${object.kind}/${object.metadata.name} namespace`);
    }
    assert.equal(byKind(objects, 'Secret').length, 0, `${name}: no Secret objects (they come from Key Vault)`);
    assert.equal(byKind(objects, 'SecretProviderClass').length, 4);
  }
  const ghe = rendered('azure-aks-ghe').objects;
  assert.match(named(ghe, 'ConfigMap', 'ghcp-enterprise').data.GITHUB_BASE_URL, /\.ghe\.com$/);
  assert.equal(named(rendered('azure-aks').objects, 'ConfigMap', 'ghcp-enterprise').data.GITHUB_BASE_URL, '');
});

test('images come from ACR with the r3 digests unchanged, in init and main containers', () => {
  for (const name of ALL) {
    const { objects } = rendered(name);
    for (const service of SERVICES) {
      const spec = podSpec(objects, service);
      for (const container of [...spec.initContainers, ...spec.containers]) {
        assert.equal(container.image, `REPLACE_ACR_LOGIN_SERVER/ghcp/ghcp-${service}@${DIGESTS[service]}`, `${name}/${service}/${container.name}`);
      }
    }
  }
  const base = readFileSync(path.join(directory, 'base/kustomization.yaml'), 'utf8');
  for (const digest of Object.values(DIGESTS)) assert.ok(base.includes(digest), `base pins ${digest}`);
});

test('every Secret a pod references is synced by the SecretProviderClass that pod mounts', () => {
  for (const name of ALL) {
    const { objects } = rendered(name);
    for (const service of SERVICES) {
      const spec = podSpec(objects, service);
      assert.equal(spec.serviceAccountName, 'ghcp-workload');
      assert.equal(spec.automountServiceAccountToken, false, 'pods still get no service account token');
      const csi = spec.volumes.filter((v) => v.csi);
      assert.equal(csi.length, 1, `${service}: one CSI volume`);
      assert.equal(csi[0].csi.driver, 'secrets-store.csi.k8s.io');
      assert.equal(csi[0].csi.readOnly, true);
      const main = spec.containers.find((c) => c.name === service);
      assert.ok(main.volumeMounts.some((m) => m.name === csi[0].name && m.readOnly), `${service}: the CSI volume is mounted (kubelet only mounts used volumes)`);
      const spc = named(objects, 'SecretProviderClass', csi[0].csi.volumeAttributes.secretProviderClass);
      assert.ok(spc, `${service}: SecretProviderClass exists`);
      const aliases = new Set(spc.spec.parameters.objects.match(/objectAlias: (\S+)/g).map((l) => l.split(': ')[1]));
      const produced = new Set();
      for (const secret of spc.spec.secretObjects) {
        for (const item of secret.data) {
          assert.ok(aliases.has(item.objectName), `${spc.metadata.name}: ${item.objectName} is mounted`);
          produced.add(`${secret.secretName}/${item.key}`);
        }
      }
      const needed = new Set();
      for (const container of [...spec.initContainers, ...spec.containers]) {
        for (const entry of container.env ?? []) {
          if (entry.valueFrom?.secretKeyRef) needed.add(`${entry.valueFrom.secretKeyRef.name}/${entry.valueFrom.secretKeyRef.key}`);
        }
      }
      for (const volume of spec.volumes) {
        if (volume.secret) for (const item of volume.secret.items) needed.add(`${volume.secret.secretName}/${item.key}`);
      }
      for (const ref of needed) assert.ok(produced.has(ref), `${name}/${service}: ${ref} is synced by ${spc.metadata.name}`);
      // The first pod to start creates ghcp-internal; every class must therefore carry both keys.
      assert.ok(produced.has('ghcp-internal/INTERNAL_API_TOKEN') && produced.has('ghcp-internal/SESSION_SECRET'), `${spc.metadata.name}: complete ghcp-internal`);
    }
    for (const spc of byKind(objects, 'SecretProviderClass')) {
      assert.equal(spc.spec.provider, 'azure');
      assert.equal(spc.spec.parameters.usePodIdentity, 'false');
      assert.equal(spc.spec.parameters.clientID, 'REPLACE_WORKLOAD_CLIENT_ID', 'workload identity, not the add-on identity');
      assert.ok(!('useVMManagedIdentity' in spc.spec.parameters));
    }
  }
  const sa = named(rendered('azure-aks').objects, 'ServiceAccount', 'ghcp-workload');
  assert.equal(sa.metadata.annotations['azure.workload.identity/client-id'], 'REPLACE_WORKLOAD_CLIENT_ID');
  assert.equal(sa.automountServiceAccountToken, false);
  for (const service of SERVICES) {
    assert.ok(!('azure.workload.identity/use' in (named(rendered('azure-aks').objects, 'Deployment', `ghcp-${service}`).spec.template.metadata.labels)),
      'no workload identity webhook injection: the app process gets no Azure credential');
  }
});

test('base invariants survive the Azure component', () => {
  for (const name of ALL) {
    const { objects } = rendered(name);
    for (const service of SERVICES) {
      const spec = podSpec(objects, service);
      assert.equal(spec.securityContext.runAsUser, 1000);
      assert.equal(spec.terminationGracePeriodSeconds, 45);
      assert.deepEqual(spec.initContainers.map((c) => c.name), ['require-approved-config']);
      for (const container of [...spec.initContainers, ...spec.containers]) {
        assert.equal(container.securityContext.readOnlyRootFilesystem, true);
        assert.equal(container.command === undefined || container.name === 'require-approved-config', true);
      }
    }
    const proxy = named(objects, 'Deployment', 'ghcp-proxy');
    assert.ok(proxy.spec.replicas >= 2);
    assert.deepEqual(proxy.spec.strategy, { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } });
    for (const service of ['sso', 'login', 'console']) {
      const deployment = named(objects, 'Deployment', `ghcp-${service}`);
      assert.equal(deployment.spec.replicas, 1);
      assert.deepEqual(deployment.spec.strategy, { type: 'Recreate' });
    }
    const config = named(objects, 'ConfigMap', 'ghcp-proxy-config').data;
    assert.equal(config.MYSQL_SSL_MODE, 'verify-ca');
    assert.equal(config.MYSQL_SSL_CA_PATH, '/run/mysql-ca/ca.pem');
    assert.equal(config.MYSQL_AUTO_MIGRATE, name === 'azure-aks-all' ? 'false' : 'true');
    assert.equal(named(objects, 'ConfigMap', 'ghcp-common').data.GHCP_CONFIG_APPROVED, 'BLOCKED');
    assert.equal(named(objects, 'Service', 'ghcp-proxy').spec.type, 'ClusterIP');
  }
});

test('persistent volumes use the Azure Disk class; zone behaviour and data retention are explicit', () => {
  for (const name of ALL) {
    const { objects } = rendered(name);
    const claims = byKind(objects, 'PersistentVolumeClaim');
    assert.deepEqual(claims.map((c) => c.metadata.name).sort(), ['ghcp-console-data', 'ghcp-login-data', 'ghcp-login-logs', 'ghcp-sso-data']);
    for (const claim of claims) {
      assert.equal(claim.spec.storageClassName, 'ghcp-azure-disk');
      assert.deepEqual(claim.spec.accessModes, ['ReadWriteOnce']);
    }
    const storageClass = named(objects, 'StorageClass', 'ghcp-azure-disk');
    assert.equal(storageClass.provisioner, 'disk.csi.azure.com');
    assert.equal(storageClass.reclaimPolicy, 'Retain');
    assert.equal(storageClass.volumeBindingMode, 'WaitForFirstConsumer');
    assert.equal(storageClass.allowVolumeExpansion, true);
    assert.match(storageClass.parameters.skuName, /^(Premium|StandardSSD)_(ZRS|LRS)$/);
  }
});

test('the MySQL CA bundle holds exactly the two Azure roots, verified by fingerprint', () => {
  const { objects } = rendered('azure-aks');
  const bundle = named(objects, 'ConfigMap', 'ghcp-mysql-ca').data['ca.pem'];
  const pems = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  assert.equal(pems.length, 2);
  const found = {};
  for (const pem of pems) {
    const certificate = new X509Certificate(pem);
    assert.equal(certificate.subject, certificate.issuer, 'self-signed root');
    assert.ok(certificate.ca);
    const cn = /CN=(.+)/.exec(certificate.subject)[1].trim();
    found[cn] = certificate.fingerprint256;
  }
  assert.deepEqual(found, MYSQL_CA_FINGERPRINTS);
  const proxy = podSpec(objects, 'proxy');
  assert.equal(proxy.volumes.find((v) => v.name === 'mysql-ca').configMap.name, 'ghcp-mysql-ca');
});

test('internal load balancers: SSO and Console private only, fixed IPs, source ranges; Proxy only with its component', () => {
  for (const name of ALL) {
    const { objects } = rendered(name);
    const balancers = byKind(objects, 'Service').filter((s) => s.spec.type === 'LoadBalancer');
    const expected = name === 'azure-aks-all' ? ['ghcp-console-ilb', 'ghcp-proxy-ilb', 'ghcp-sso-ilb'] : ['ghcp-console-ilb', 'ghcp-sso-ilb'];
    assert.deepEqual(balancers.map((s) => s.metadata.name).sort(), expected);
    for (const service of balancers) {
      const annotations = service.metadata.annotations;
      assert.equal(annotations['service.beta.kubernetes.io/azure-load-balancer-internal'], 'true', `${service.metadata.name} is internal`);
      assert.match(annotations['service.beta.kubernetes.io/azure-load-balancer-ipv4'], /^REPLACE_/);
      assert.match(annotations['service.beta.kubernetes.io/azure-load-balancer-internal-subnet'], /^REPLACE_/);
      assert.equal(service.spec.externalTrafficPolicy, 'Local');
      assert.ok(service.spec.loadBalancerSourceRanges.length > 0, 'source ranges are mandatory');
      // Non-streaming inference is silent for up to 600 s; the Azure default (4 minutes) resets it.
      if (service.metadata.name === 'ghcp-proxy-ilb') {
        assert.equal(annotations['service.beta.kubernetes.io/azure-load-balancer-tcp-idle-timeout'], '15');
      }
    }
  }
  assert.ok(!byKind(rendered('azure-aks').objects, 'Ingress').length, 'no Ingress: App Gateway (deploy/azure) is the only public entry');
});

test('components stay declared as Kustomize components and the overlay reuses the base', () => {
  for (const component of ['azure-aks', 'azure-proxy-ilb']) {
    const text = readFileSync(path.join(directory, 'components', component, 'kustomization.yaml'), 'utf8');
    assert.match(text, /^kind: Component$/m);
  }
  const overlay = readFileSync(path.join(directory, 'overlays', 'azure-aks', 'kustomization.yaml'), 'utf8');
  assert.match(overlay, /^\s+- \.\.\/github-com$/m);
  assert.match(overlay, /^\s+- \.\.\/\.\.\/components\/azure-aks$/m);
  assert.doesNotMatch(overlay, /\.\.\/\.\.\/base/, 'the overlay goes through github-com, it does not fork the base');
  assert.ok(readFileSync(path.join(root, 'deploy/kubernetes/README.md'), 'utf8').includes('azure-aks'), 'README mentions the AKS overlay');
});

// ---------------------------------------------------------------------------
// Multi-enterprise: a registry with default (github.com, from the environment) + one github.com + one GHE.com enterprise,
// rendered by deploy/azure/scripts/render-overlay.mjs.
// ---------------------------------------------------------------------------
const READERS = { 'sso.signingCert': 'sso', 'sso.signingKey': 'sso', 'sso.sessionSecret': 'sso', 'sso.scimToken': 'sso',
  'sso.seatPat': 'sso', 'sso.defaultUserPassword': 'sso', 'modelsAdmin.copilotToken': 'proxy' };
const KEY_VAULT_SUFFIX = { 'sso.signingCert': 'saml-idp-cert', 'sso.signingKey': 'saml-idp-key', 'sso.sessionSecret': 'session-secret',
  'sso.scimToken': 'scim-token', 'sso.seatPat': 'copilot-seat-pat', 'sso.defaultUserPassword': 'sso-default-user-password',
  'modelsAdmin.copilotToken': 'models-admin-copilot-token' };

function secretRefs(registry) {
  const refs = [];
  for (const enterprise of registry.enterprises) {
    for (const [section, values] of Object.entries(enterprise)) {
      if (typeof values !== 'object' || values === null) continue;
      for (const [key, value] of Object.entries(values)) {
        if (value && typeof value === 'object' && 'file' in value) refs.push({ id: enterprise.id, field: `${section}.${key}`, path: value.file });
      }
    }
  }
  return refs;
}

let multiEnterpriseRender;
async function renderMultiEnterprise() {
  if (multiEnterpriseRender) return multiEnterpriseRender;
  const { renderOverlay, writeOverlay } = await import('../azure/scripts/render-overlay.mjs');
  const registry = JSON.parse(readFileSync(path.join(root, 'deploy/azure/enterprise-registry.azure.example.json'), 'utf8'));
  const outDir = path.join(root, 'deploy/azure/.generated', `.test-${randomUUID()}`);
  const result = renderOverlay({
    AZURE_ENV_NAME: 'unittest', GHCP_GITHUB_HOSTING: 'github.com', GHCP_NAMESPACE: 'ghcp',
    AZURE_CONTAINER_REGISTRY_ENDPOINT: 'acrunittest000000.azurecr.io', AZURE_KEY_VAULT_NAME: 'kvunittest000000',
    AZURE_TENANT_ID: '00000000-0000-0000-0000-000000000000', GHCP_WORKLOAD_CLIENT_ID: '00000000-0000-0000-0000-000000000001',
    GHCP_PROXY_REPLICAS: '2', GHCP_DISK_SKU: 'Premium_ZRS', GHCP_ILB_SUBNET_NAME: 'snet-ghcp-ilb', GHCP_SSO_ILB_IP: '10.40.4.68',
    GHCP_CONSOLE_ILB_IP: '10.40.4.69', VNET_ADDRESS_PREFIXES: '10.40.0.0/16', AKS_SUBNET_PREFIX: '10.40.0.0/22',
    PE_SUBNET_PREFIX: '10.40.4.0/26', APPGW_SUBNET_PREFIX: '10.40.5.0/24', POD_CIDR: '10.244.0.0/16',
    MYSQL_FQDN: 'mysql-unittest.mysql.database.azure.com', MYSQL_ADMIN_LOGIN: 'ghcpadmin', GHCP_NETWORK_POLICY_ENGINE: 'cilium',
    GHCP_ENTERPRISE_SLUG: 'contoso', GHCP_ENTERPRISE_SHORTCODE: 'ctso', GHCP_POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.contoso.example.com',
    GHCP_POOL_WARMUP_MODEL: 'example-model',
  }, outDir, { registry });
  assert.deepEqual(result.errors, []);
  try {
    writeOverlay(result, outDir);
    multiEnterpriseRender = { registry, result, ...render(path.join(outDir, 'app')) };
    return multiEnterpriseRender;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

test('multi-enterprise: every registry secret file is mounted from Key Vault into the pod that reads it, and no other pod', async () => {
  const { registry, objects, result } = await renderMultiEnterprise();
  assert.deepEqual(registry.enterprises.map((e) => e.id), ['tailspin', 'fabrikam-ghe']);
  assert.ok(registry.enterprises.some((e) => e.github.baseUrl.endsWith('.ghe.com')));
  assert.ok(registry.enterprises.some((e) => e.github.baseUrl === 'https://github.com'));
  const refs = secretRefs(registry);
  assert.equal(refs.length, 13, '6 SSO secrets per enterprise + one Models admin token');
  const spcs = new Map(byKind(objects, 'SecretProviderClass').map((s) => [s.metadata.name, s]));
  // What each pod can see: { mount directory, file name, Key Vault object }.
  const view = {};
  for (const service of SERVICES) {
    const spec = podSpec(objects, service);
    const main = spec.containers.find((c) => c.name === service);
    view[service] = [];
    for (const volume of spec.volumes.filter((v) => v.csi)) {
      const mount = main.volumeMounts.find((m) => m.name === volume.name);
      assert.ok(mount?.readOnly, `${service}: ${volume.name} mounted read-only`);
      const spc = spcs.get(volume.csi.volumeAttributes.secretProviderClass);
      assert.ok(spc, `${service}: ${volume.csi.volumeAttributes.secretProviderClass} exists`);
      assert.equal(spc.spec.parameters.clientID, '00000000-0000-0000-0000-000000000001');
      assert.equal(spc.spec.parameters.keyvaultName, 'kvunittest000000');
      for (const block of spc.spec.parameters.objects.split('- |').slice(1)) {
        const objectName = /objectName: (\S+)/.exec(block)[1];
        const file = /objectAlias: (\S+)/.exec(block)?.[1] ?? objectName;
        view[service].push({ dir: mount.mountPath, file, objectName });
      }
    }
  }
  for (const ref of refs) {
    const reader = READERS[ref.field];
    assert.ok(reader, `${ref.field} has a known reader`);
    const expected = { dir: path.posix.dirname(ref.path), file: path.posix.basename(ref.path), objectName: `ghcp-ent-${ref.id}-${KEY_VAULT_SUFFIX[ref.field]}` };
    assert.equal(expected.dir, `/run/secrets/${ref.id}`);
    for (const service of SERVICES) {
      const hits = view[service].filter((v) => v.objectName === expected.objectName || (v.dir === expected.dir && v.file === expected.file));
      if (service === reader) assert.deepEqual(hits, [expected], `${ref.id}.${ref.field} reaches ${service}`);
      else assert.deepEqual(hits, [], `${ref.id}.${ref.field} must not reach ${service}`);
    }
  }
  // Pods get nothing beyond what the registry references (plus their own default-enterprise class).
  const enterpriseFiles = (service) => view[service].filter((v) => v.dir.startsWith('/run/secrets/'));
  assert.equal(enterpriseFiles('sso').length, 12);
  assert.equal(enterpriseFiles('proxy').length, 1);
  assert.equal(enterpriseFiles('login').length, 0, 'Login reads no secret');
  assert.equal(enterpriseFiles('console').length, 0);
  assert.equal(result.enterpriseSecrets.length, 13);
  // The default enterprise keeps its original classes and Key Vault names.
  for (const service of SERVICES) {
    assert.ok(podSpec(objects, service).volumes.some((v) => v.csi?.volumeAttributes.secretProviderClass === `ghcp-${service}-kv`));
  }
  assert.ok(view.sso.some((v) => v.objectName === 'ghcp-scim-token' && v.dir === '/mnt/secrets-store'), 'default keeps ghcp-scim-token');
});

test('multi-enterprise: the registry ConfigMap is mounted into Proxy, SSO and Login with ENTERPRISE_REGISTRY_FILE', async () => {
  const { registry, objects } = await renderMultiEnterprise();
  const maps = byKind(objects, 'ConfigMap').filter((c) => c.metadata.name.startsWith('ghcp-enterprise-registry-'));
  assert.equal(maps.length, 1, 'generated with a content hash: a registry change rolls the three Deployments');
  assert.deepEqual(JSON.parse(maps[0].data['enterprise-registry.json']), registry);
  assert.doesNotMatch(JSON.stringify(maps[0].data), /BEGIN|"env"/, 'file references only, no values');
  for (const service of ['proxy', 'sso', 'login']) {
    const spec = podSpec(objects, service);
    const main = spec.containers.find((c) => c.name === service);
    const values = Object.fromEntries((main.envFrom ?? []).flatMap((s) => Object.entries(named(objects, 'ConfigMap', s.configMapRef.name)?.data ?? {})));
    assert.equal(values.ENTERPRISE_REGISTRY_FILE, '/etc/ghcp-registry/enterprise-registry.json', `${service}: ENTERPRISE_REGISTRY_FILE`);
    const volume = spec.volumes.find((v) => v.configMap?.name === maps[0].metadata.name);
    assert.ok(volume, `${service}: registry volume`);
    assert.deepEqual(volume.configMap.items, [{ key: 'enterprise-registry.json', path: 'enterprise-registry.json' }]);
    const mount = main.volumeMounts.find((m) => m.name === volume.name);
    assert.deepEqual([mount.mountPath, mount.readOnly], ['/etc/ghcp-registry', true]);
  }
  const consoleSpec = podSpec(objects, 'console');
  assert.ok(!consoleSpec.volumes.some((v) => v.configMap?.name?.startsWith('ghcp-enterprise-registry')), 'Console does not load the registry');
  assert.equal(byKind(objects, 'Secret').length, 0);
});
