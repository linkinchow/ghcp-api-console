// Static checks of deploy/azure. Offline only: Bicep build / lint / build-params (local compiler, no subscription),
// the overlay renderer + `kubectl kustomize` (KUBECONFIG points at a missing file), the MySQL bootstrap planner, the
// PowerShell hooks' syntax (when pwsh is installed) and repository hygiene. Never deploys, never runs what-if, never
// calls an Azure API. Run: node --test deploy/azure/azure.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cidrToMysqlHost, isCidr, renderOverlay, validatePublicAccess, writeOverlay } from './scripts/render-overlay.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const infra = path.join(directory, 'infra');
const require = createRequire(import.meta.url);
const kubeEnv = { ...process.env, KUBECONFIG: path.join(os.tmpdir(), `ghcp-no-kubeconfig-${randomUUID()}`) };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function exec(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 180000, shell: false, maxBuffer: 64 << 20, ...options });
}

function onPath(command) {
  const probe = exec(process.platform === 'win32' ? 'where' : 'which', [command]);
  return probe.status === 0;
}

// Prefer a standalone bicep, then the binary `az bicep install` keeps in ~/.azure/bin, then `az bicep ...`
// (all three are the local compiler; none of them contacts Azure).
const bundled = path.join(os.homedir(), '.azure', 'bin', process.platform === 'win32' ? 'bicep.exe' : 'bicep');
const bicep = onPath('bicep') ? { command: 'bicep', prefix: [] }
  : existsSync(bundled) ? { command: bundled, prefix: [] }
    : onPath('az') ? { command: 'az', prefix: ['bicep'] } : null;
const az = process.platform === 'win32' && bicep?.command === 'az';

/** `bicep <verb> <file> ...` and `az bicep <verb> --file <file> ...` take the file differently. */
function runBicep([verb, file, ...extra], env = process.env) {
  const args = bicep.command === 'az' ? [...bicep.prefix, verb, '--file', file, ...extra] : [verb, file, ...extra];
  // On Windows `az` is a .cmd shim and needs a shell; arguments here are fixed paths and literals.
  const result = exec(bicep.command, args, { env, shell: az });
  const diagnostics = `${result.stdout}\n${result.stderr}`.split(/\r?\n/)
    .filter((line) => /: (Warning|Error|Info) /.test(line) || /^ERROR/.test(line));
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, diagnostics };
}

function compile(file) {
  const { status, stdout, diagnostics, stderr } = runBicep(['build', file, '--stdout']);
  assert.equal(status, 0, `${file}: ${stderr}`);
  return { template: JSON.parse(stdout), diagnostics };
}

/** Resources of a compiled template whatever the language version (array or symbolic-name object). */
function resources(template) {
  return Array.isArray(template.resources) ? template.resources : Object.values(template.resources ?? {});
}
const ofType = (template, type) => resources(template).filter((r) => r.type === type);

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

function kustomize(dir) {
  const yaml = exec('kubectl', ['kustomize', dir], { env: kubeEnv });
  assert.equal(yaml.status, 0, `kubectl kustomize ${dir}: ${yaml.stderr}`);
  const json = exec('kubectl', ['annotate', '--local', '-f', '-', '-o', 'json', 'ghcp.test/rendered=1'], { env: kubeEnv, input: yaml.stdout });
  assert.equal(json.status, 0, json.stderr);
  return { yaml: yaml.stdout, objects: parseJsonStream(json.stdout) };
}

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (['node_modules', '.generated', '.azure', '.kube'].includes(entry)) return [];
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const named = (objects, kind, name) => objects.find((o) => o.kind === kind && o.metadata.name === name);

// A complete azd environment as Bicep would leave it (synthetic, documentation-range values only).
function azdEnvironment(overrides = {}) {
  return {
    AZURE_ENV_NAME: 'unittest',
    GHCP_GITHUB_HOSTING: 'github.com',
    GHCP_NAMESPACE: 'ghcp',
    AZURE_CONTAINER_REGISTRY_ENDPOINT: 'acrunittest000000.azurecr.io',
    AZURE_KEY_VAULT_NAME: 'kvunittest000000',
    AZURE_TENANT_ID: '00000000-0000-0000-0000-000000000000',
    GHCP_WORKLOAD_CLIENT_ID: '00000000-0000-0000-0000-000000000001',
    GHCP_PROXY_REPLICAS: '3',
    GHCP_DISK_SKU: 'Premium_ZRS',
    GHCP_ILB_SUBNET_NAME: 'snet-ghcp-ilb',
    GHCP_SSO_ILB_IP: '10.40.4.68',
    GHCP_CONSOLE_ILB_IP: '10.40.4.69',
    GHCP_PROXY_ILB_IP: '10.40.4.70',
    VNET_ADDRESS_PREFIXES: '10.40.0.0/16',
    AKS_SUBNET_PREFIX: '10.40.0.0/22',
    PE_SUBNET_PREFIX: '10.40.4.0/26',
    APPGW_SUBNET_PREFIX: '10.40.5.0/24',
    POD_CIDR: '10.244.0.0/16',
    MYSQL_FQDN: 'mysql-unittest.mysql.database.azure.com',
    MYSQL_ADMIN_LOGIN: 'ghcpadmin',
    MYSQL_DATABASE: 'ghcp_proxy',
    GHCP_NETWORK_POLICY_ENGINE: 'cilium',
    GHCP_ENTERPRISE_SLUG: 'contoso',
    GHCP_ENTERPRISE_SHORTCODE: 'ctso',
    GHCP_POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.example.com',
    GHCP_POOL_WARMUP_MODEL: 'example-model',
    ...overrides,
  };
}

function renderInto(envValues) {
  const outDir = path.join(directory, '.generated', `.test-${randomUUID()}`);
  const result = renderOverlay(envValues, outDir);
  return { outDir, result };
}

// ---------------------------------------------------------------------------
// Bicep
// ---------------------------------------------------------------------------
const skipBicep = bicep ? false : 'neither bicep nor az is installed (README section 2)';

test('main.bicep builds without warnings and lints clean (strict bicepconfig.json)', { skip: skipBicep }, () => {
  const { diagnostics } = compile(path.join(infra, 'main.bicep'));
  assert.deepEqual(diagnostics, [], 'build diagnostics');
  for (const file of [path.join(infra, 'main.bicep'), ...readdirSync(path.join(infra, 'modules')).map((f) => path.join(infra, 'modules', f))]) {
    const lint = runBicep(['lint', file]);
    assert.equal(lint.status, 0, `${file}: ${lint.stderr}`);
    assert.deepEqual(lint.diagnostics, [], `${path.basename(file)} lint`);
  }
});

test('main.bicepparam builds with defaults (internal only) and with a public-access sample', { skip: skipBicep }, () => {
  const out = path.join(os.tmpdir(), `ghcp-params-${randomUUID()}.json`);
  try {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GHCP_|AZURE_ENV_NAME|AZURE_LOCATION)/.test(k)));
    let built = runBicep(['build-params', path.join(infra, 'main.bicepparam'), '--outfile', out], clean);
    assert.equal(built.status, 0, built.stderr);
    const defaults = JSON.parse(readFileSync(out, 'utf8')).parameters;
    assert.deepEqual(defaults.publicAccess.value, { sso: false, console: false, litellm: false, allowedSourceCidrs: [] });
    assert.equal(defaults.mysqlAdminPassword.value, '', 'no password in the parameter file');
    assert.deepEqual(defaults.availabilityZones.value, ['1', '2', '3']);

    const sample = {
      sso: true, console: true, litellm: true, allowedSourceCidrs: ['203.0.113.0/24'],
      hostNames: { sso: 'sso.example.com', console: 'console.example.com', litellm: 'llm.example.com' },
      litellmBackend: { address: '10.30.0.10', port: 4000 },
    };
    built = runBicep(['build-params', path.join(infra, 'main.bicepparam'), '--outfile', out],
      { ...clean, GHCP_PUBLIC_ACCESS: JSON.stringify(sample), GHCP_PROXY_REPLICAS: '4' });
    assert.equal(built.status, 0, built.stderr);
    const params = JSON.parse(readFileSync(out, 'utf8')).parameters;
    assert.deepEqual(params.publicAccess.value, sample);
    assert.equal(params.proxyReplicas.value, 4);
  } finally {
    rmSync(out, { force: true });
  }
});

test('main template: switch defaults to internal only, public resources are conditional, no secret outputs', { skip: skipBicep }, () => {
  const { template } = compile(path.join(infra, 'main.bicep'));
  assert.deepEqual(template.parameters.publicAccess.defaultValue, { sso: false, console: false, litellm: false, allowedSourceCidrs: [] });
  assert.equal(template.parameters.mysqlAdminPassword.type, 'securestring');
  const modules = Object.values(template.resources).filter((r) => r.type === 'Microsoft.Resources/deployments');
  const byName = (name) => modules.find((m) => m.name === name);
  for (const name of ['ghcp-app-gateway', 'ghcp-waf-default', 'ghcp-appgw-identity']) assert.equal(byName(name).condition, "[variables('publicEnabled')]", name);
  assert.equal(template.variables.pa, "[parameters('publicAccess')]");
  assert.match(JSON.stringify(template.variables.publicEnabled), /pa'\)\.sso.*pa'\)\.console.*pa'\)\.litellm.*proxyPublic/);
  for (const [name, key] of [['ghcp-waf-sso', 'sso'], ['ghcp-waf-console', 'console'], ['ghcp-waf-litellm', 'litellm']]) {
    assert.equal(byName(name).condition, `[variables('pa').${key}]`, name);
  }
  assert.equal(byName('ghcp-waf-proxy').condition, "[variables('proxyPublic')]");
  assert.equal(template.variables.proxyPublic, "[coalesce(tryGet(variables('pa'), 'proxy'), false())]", 'proxy defaults to off');
  // The Proxy WAF policy always carries the source allow list (no "any source" option) and the inference path allow list.
  const proxyRules = JSON.stringify(byName('ghcp-waf-proxy').properties.parameters.customRules);
  assert.match(proxyRules, /sourceAllowlistRule\(10, union\(reference\('network'\)\.outputs\.vnetAddressPrefixes\.value, coalesce\(tryGet\(variables\('pa'\), 'proxyAllowedSourceCidrs'\)/);
  assert.match(proxyRules, /pathRule\('AllowInferencePathsOnly', 20, variables\('proxyInferencePaths'\), true\(\)\)/);
  assert.match(proxyRules, /pathRule\('BlockManagementPaths', 30, createArray\('\/api', '\/internal'\), false\(\)\)/);
  const functions = JSON.stringify(template.functions);
  assert.match(functions, /AllowListedSourcesOnly.*RemoteAddr.*IPMatch.*"negationConditon":true/);
  assert.match(functions, /RequestUri.*BeginsWith.*UrlDecode.*Lowercase/);
  assert.deepEqual(template.variables.proxyInferencePaths, ['/v1/messages', '/chat/completions', '/responses', '/v1/models']);
  assert.equal(byName('ghcp-aks').condition, "[not(variables('byoAks'))]");
  assert.equal(template.variables.byoAks, "[not(empty(parameters('existingAksClusterName')))]");
  for (const output of Object.keys(template.outputs)) assert.doesNotMatch(output, /PASSWORD|TOKEN|SECRET_VALUE/, output);
  const text = JSON.stringify(template);
  assert.doesNotMatch(text, /Microsoft\.DBforPostgreSQL|Microsoft\.Cache\/redis|redisEnterprise/i, 'no PostgreSQL / Redis');
});

test('modules: MySQL private + TLS + utf8mb4 + trigger setting; Key Vault, ACR, AKS, App GW, WAF settings', { skip: skipBicep }, () => {
  const module = (name) => compile(path.join(infra, 'modules', `${name}.bicep`)).template;

  const mysql = module('mysql');
  const server = ofType(mysql, 'Microsoft.DBforMySQL/flexibleServers')[0];
  assert.equal(server.properties.network.publicNetworkAccess, 'Disabled');
  assert.equal(server.properties.storage.autoGrow, 'Enabled');
  const parameters = mysql.variables.serverParameters;
  const value = (name) => parameters.find((p) => p.name === name)?.value;
  assert.equal(value('require_secure_transport'), 'ON');
  assert.equal(value('character_set_server'), 'utf8mb4');
  assert.equal(value('collation_server'), 'utf8mb4_0900_ai_ci');
  assert.match(value('log_bin_trust_function_creators'), /trustFunctionCreators/);
  assert.equal(ofType(mysql, 'Microsoft.DBforMySQL/flexibleServers/configurations')[0].copy.batchSize, 1, 'parameters one at a time');
  const database = ofType(mysql, 'Microsoft.DBforMySQL/flexibleServers/databases')[0];
  assert.deepEqual([database.properties.charset, database.properties.collation], ['utf8mb4', 'utf8mb4_0900_ai_ci']);
  assert.deepEqual(mysql.parameters.highAvailability.allowedValues, ['Disabled', 'SameZone', 'ZoneRedundant']);
  assert.equal(mysql.parameters.administratorLoginPassword.type, 'securestring');
  assert.match(JSON.stringify(mysql), /"groupId":\{"value":"mysqlServer"\}/);

  const vault = ofType(module('key-vault'), 'Microsoft.KeyVault/vaults')[0];
  assert.equal(vault.properties.enableRbacAuthorization, true);
  assert.equal(vault.properties.networkAcls.defaultAction, 'Deny');
  assert.match(vault.properties.publicNetworkAccess, /Disabled/);

  const registry = ofType(module('acr'), 'Microsoft.ContainerRegistry/registries')[0];
  assert.equal(registry.sku.name, 'Premium');
  assert.equal(registry.properties.adminUserEnabled, false);

  const aks = ofType(module('aks'), 'Microsoft.ContainerService/managedClusters')[0].properties;
  assert.equal(aks.networkProfile.networkPlugin, 'azure');
  assert.equal(aks.networkProfile.networkPluginMode, 'overlay');
  assert.equal(aks.oidcIssuerProfile.enabled, true);
  assert.equal(aks.securityProfile.workloadIdentity.enabled, true);
  assert.equal(aks.addonProfiles.azureKeyvaultSecretsProvider.enabled, true);
  assert.equal(aks.addonProfiles.azureKeyvaultSecretsProvider.config.enableSecretRotation, 'true');
  assert.deepEqual(aks.agentPoolProfiles.map((p) => p.mode), ['System', 'User']);
  assert.deepEqual(aks.agentPoolProfiles[0].nodeTaints, ['CriticalAddonsOnly=true:NoSchedule']);
  assert.equal(aks.aadProfile.enableAzureRBAC, true);

  const gateway = module('app-gateway');
  const agw = ofType(gateway, 'Microsoft.Network/applicationGateways')[0].properties;
  assert.equal(agw.sku.name, 'WAF_v2');
  assert.equal(agw.enableHttp2, false, 'HTTP/2 front-end idle timeout is fixed at 180 s');
  assert.deepEqual(agw.globalConfiguration, { enableRequestBuffering: true, enableResponseBuffering: false });
  assert.equal(agw.sslPolicy, "[variables('tlsPolicy')]");
  assert.deepEqual(gateway.variables.tlsPolicy, { policyType: 'Predefined', policyName: 'AppGwSslPolicy20220101S' });
  // Listener / settings arrays are copy loops in the compiled template.
  const loops = Object.fromEntries((agw.copy ?? []).map((c) => [c.name, JSON.stringify(c.input)]));
  assert.match(loops.httpListeners, /"protocol":"Https"/);
  assert.match(loops.httpListeners, /"requireServerNameIndication":true/);
  assert.match(loops.backendHttpSettingsCollection, /"protocol":"Http".*"pickHostNameFromBackendAddress":false/);
  assert.match(loops.backendHttpSettingsCollection, /requestTimeout/);
  assert.match(JSON.stringify(agw.rewriteRuleSets), /X-User-Identity/);
  assert.match(JSON.stringify(agw.sslProfiles), /mutual-tls.*clientAuthConfiguration/, 'mutual TLS profile for the Proxy listener');
  assert.match(loops.httpListeners, /sslProfiles', parameters\('name'\), 'mutual-tls'/);
  assert.match(JSON.stringify(ofType(gateway, 'Microsoft.Network/publicIPAddresses')[0]), /idleTimeoutInMinutes/);

  const waf = ofType(module('waf-policy'), 'Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies')[0].properties;
  assert.deepEqual(waf.managedRules.managedRuleSets.map((s) => `${s.ruleSetType}/${s.ruleSetVersion}`),
    ['Microsoft_DefaultRuleSet/2.1', 'Microsoft_BotManagerRuleSet/1.1']);
  assert.equal(module('waf-policy').parameters.mode.defaultValue, 'Prevention');

  const network = module('network');
  assert.equal(network.parameters.natIdleTimeoutMinutes.defaultValue, 15);
  assert.match(JSON.stringify(network.variables), /GatewayManager.*65200-65535/);
});

// ---------------------------------------------------------------------------
// Public access validation and the overlay renderer
// ---------------------------------------------------------------------------
test('validatePublicAccess: defaults are valid; hosts, CIDRs, backends and keys are checked', () => {
  assert.deepEqual(validatePublicAccess('').errors, []);
  assert.deepEqual(validatePublicAccess('{"sso":false,"console":false,"litellm":false,"allowedSourceCidrs":[]}').errors, []);
  const good = validatePublicAccess(JSON.stringify({ sso: true, console: true, allowedSourceCidrs: ['203.0.113.0/24'],
    hostNames: { sso: 'sso.example.com', console: 'console.example.com' } }));
  assert.deepEqual(good.errors, []);
  const cases = [
    [{ sso: true, allowedSourceCidrs: [] }, /hostNames\.sso is required/],
    [{ sso: true, hostNames: { sso: 'https://sso.example.com' }, allowedSourceCidrs: [] }, /not a lowercase DNS name/],
    [{ console: true, hostNames: { console: 'c.example.com' }, allowedSourceCidrs: ['0.0.0.0/0'] }, /whole internet/],
    [{ console: true, hostNames: { console: 'c.example.com' }, allowedSourceCidrs: ['203.0.113.1'] }, /not an IPv4 CIDR/],
    [{ litellm: true, hostNames: { litellm: 'l.example.com' }, allowedSourceCidrs: [] }, /litellmBackend\.address is required/],
    [{ sso: true, console: true, hostNames: { sso: 'a.example.com', console: 'a.example.com' }, allowedSourceCidrs: [] }, /different/],
    [{ grpc: true, allowedSourceCidrs: [] }, /unknown key publicAccess\.grpc/],
    [{ sso: 'yes', allowedSourceCidrs: [] }, /must be true or false/],
    [{ proxy: true, hostNames: { proxy: 'p.example.com' }, allowedSourceCidrs: ['203.0.113.0/24'] }, /proxyAllowedSourceCidrs is required/],
    [{ proxy: true, allowedSourceCidrs: [], proxyAllowedSourceCidrs: ['198.51.100.7/32'] }, /hostNames\.proxy is required/],
    [{ proxy: true, hostNames: { proxy: 'p.example.com' }, allowedSourceCidrs: [], proxyAllowedSourceCidrs: ['198.51.100.7/32'],
      proxyClientCaCertificate: 'bm90IGEgY2VydGlmaWNhdGU=' }, /proxyClientCaCertificate must be the base64 of a CA certificate/],
  ];
  for (const [value, pattern] of cases) {
    const { errors } = validatePublicAccess(JSON.stringify(value));
    assert.ok(errors.some((e) => pattern.test(e)), `${JSON.stringify(value)} → ${errors.join('; ')}`);
  }
  // Proxy with a CA (any public CA certificate will do for the format check) still warns about the shared key.
  const caPem = readFileSync(path.join(root, 'deploy/kubernetes/components/azure-aks/mysql-ca/azure-mysql-ca.pem'), 'utf8')
    .match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0];
  const proxy = validatePublicAccess(JSON.stringify({ proxy: true, hostNames: { proxy: 'p.example.com' }, allowedSourceCidrs: [],
    proxyAllowedSourceCidrs: ['198.51.100.7/32', '198.51.100.0/24'], proxyClientCaCertificate: caPem.replace(/-----[A-Z ]+-----|\s/g, '') }));
  assert.deepEqual(proxy.errors, []);
  assert.ok(proxy.warnings.some((w) => /anyone holding the shared API_KEY can claim any caller identity/.test(w)));
  assert.ok(proxy.warnings.some((w) => /198\.51\.100\.0\/24 is wider than \/28/.test(w)));
  assert.ok(!proxy.warnings.some((w) => /without mutual TLS/.test(w)));
  assert.ok(validatePublicAccess(JSON.stringify({ proxy: true, hostNames: { proxy: 'p.example.com' }, allowedSourceCidrs: [],
    proxyAllowedSourceCidrs: ['198.51.100.7/32'] })).warnings.some((w) => /without mutual TLS/.test(w)));
  assert.match(validatePublicAccess(JSON.stringify({ console: true, hostNames: { console: 'c.example.com' }, allowedSourceCidrs: [] })).warnings[0], /only clients inside the VNet/);
  assert.match(validatePublicAccess('{not json').errors[0], /not valid JSON/);
});

test('helpers: CIDR parsing and MySQL host netmask', () => {
  assert.ok(isCidr('10.40.0.0/22'));
  assert.ok(!isCidr('10.40.0.0'));
  assert.ok(!isCidr('10.40.0.300/24'));
  assert.equal(cidrToMysqlHost('10.40.0.0/22'), '10.40.0.0/255.255.252.0');
  assert.equal(cidrToMysqlHost('10.0.0.0/8'), '10.0.0.0/255.0.0.0');
});

const skipKubectl = onPath('kubectl') ? false : 'kubectl is not installed';

test('renderer: internal-only github.com environment renders and fills every Azure placeholder', { skip: skipKubectl }, () => {
  const { outDir, result } = renderInto(azdEnvironment());
  try {
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.pending, []);
    assert.equal(result.approved, false, 'not approved until GHCP_CONFIG_APPROVED=true');
    writeOverlay(result, outDir);
    const { yaml, objects } = kustomize(path.join(outDir, 'app'));
    const leftovers = yaml.split('\n').filter((l) => l.includes('REPLACE_') && !l.includes("includes(''REPLACE_'')")
      && !/REPLACE_(INGRESS|INTERNAL_INGRESS|LITELLM)_/.test(l));
    assert.deepEqual(leftovers, [], 'only the start gate and unused network-policy placeholders may remain');
    assert.equal(named(objects, 'ConfigMap', 'ghcp-common').data.GHCP_CONFIG_APPROVED, 'BLOCKED');
    const enterprise = named(objects, 'ConfigMap', 'ghcp-enterprise').data;
    assert.equal(enterprise.SSO_PUBLIC_BASE_URL, 'http://10.40.4.68:7001', 'internal mode: SSO on its internal load balancer');
    assert.equal(enterprise.ENTERPRISE_SLUG, 'contoso');
    assert.equal(enterprise.ENTERPRISE_SHORTCODE, 'ctso');
    assert.equal(named(objects, 'ConfigMap', 'ghcp-sso-config').data.SP_ACS_URL, 'https://github.com/enterprises/contoso/saml/consume');
    assert.equal(named(objects, 'ConfigMap', 'ghcp-console-config').data.CONSOLE_PUBLIC_BASE_URL, '');
    assert.equal(named(objects, 'Deployment', 'ghcp-proxy').spec.replicas, 3);
    for (const container of named(objects, 'Deployment', 'ghcp-proxy').spec.template.spec.containers) {
      assert.match(container.image, /^acrunittest000000\.azurecr\.io\/ghcp\/ghcp-proxy@sha256:98c4c720/);
    }
    for (const spc of objects.filter((o) => o.kind === 'SecretProviderClass')) {
      assert.equal(spc.spec.parameters.keyvaultName, 'kvunittest000000');
      assert.equal(spc.spec.parameters.clientID, '00000000-0000-0000-0000-000000000001');
    }
    const sso = named(objects, 'Service', 'ghcp-sso-ilb');
    assert.equal(sso.metadata.annotations['service.beta.kubernetes.io/azure-load-balancer-ipv4'], '10.40.4.68');
    assert.ok(sso.spec.loadBalancerSourceRanges.includes('10.244.0.0/16'), 'Login (pod CIDR) reaches SSO through the balancer IP');
    assert.ok(!named(objects, 'Service', 'ghcp-console-ilb').spec.loadBalancerSourceRanges.includes('10.244.0.0/16'));
    assert.equal(named(objects, 'StorageClass', 'ghcp-azure-disk').parameters.skuName, 'Premium_ZRS');
    assert.ok(named(objects, 'NetworkPolicy', 'ghcp-default-deny'), 'Cilium cluster: network policies on by default');
    assert.equal(named(objects, 'NetworkPolicy', 'ghcp-azure-proxy-mysql').spec.egress[0].to[0].ipBlock.cidr, '10.40.4.0/26');
    assert.ok(!named(objects, 'NetworkPolicy', 'ghcp-azure-login-appgw'), 'no App GW in internal mode');
    assert.ok(!named(objects, 'Deployment', 'ghcp-login').spec.template.spec.hostAliases);
    assert.equal(objects.filter((o) => o.kind === 'Secret').length, 0);

    const bootstrap = kustomize(path.join(outDir, 'mysql-bootstrap')).objects;
    const job = named(bootstrap, 'Job', 'ghcp-mysql-bootstrap');
    assert.match(job.spec.template.spec.containers[0].image, /^acrunittest000000\.azurecr\.io\/ghcp\/ghcp-proxy@sha256:98c4c720/);
    assert.equal(job.spec.template.spec.serviceAccountName, 'ghcp-workload');
    assert.deepEqual(job.spec.template.spec.containers[0].args, ['node', '/opt/bootstrap/bootstrap.cjs']);
    assert.equal(named(bootstrap, 'ConfigMap', 'ghcp-mysql-bootstrap-config').data.MYSQL_HOST, 'mysql-unittest.mysql.database.azure.com');
    assert.equal(named(bootstrap, 'SecretProviderClass', 'ghcp-mysql-bootstrap-kv').spec.parameters.keyvaultName, 'kvunittest000000');
    assert.ok(named(bootstrap, 'ConfigMap', 'ghcp-mysql-ca').data['ca.pem'].includes('BEGIN CERTIFICATE'));
    assert.ok(named(bootstrap, 'ConfigMap', 'ghcp-mysql-bootstrap-script').data['bootstrap.cjs'].includes('mysql2/promise'));
    // Re-running postprovision after the app (and its default deny) is deployed needs this egress to MySQL.
    const bootstrapEgress = named(bootstrap, 'NetworkPolicy', 'ghcp-azure-mysql-bootstrap').spec;
    assert.equal(job.spec.template.metadata.labels['app.kubernetes.io/name'], 'ghcp-mysql-bootstrap');
    assert.deepEqual(bootstrapEgress.podSelector.matchLabels, { 'app.kubernetes.io/name': 'ghcp-mysql-bootstrap' });
    assert.deepEqual(bootstrapEgress.egress, [{ to: [{ ipBlock: { cidr: '10.40.4.0/26' } }], ports: [{ protocol: 'TCP', port: 3306 }] }]);
    assert.ok(bootstrap.every((o) => o.kind === 'StorageClass' || o.metadata.namespace === 'ghcp'));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('renderer: public GHE.com environment with Proxy ILB, DBA schema and approval', { skip: skipKubectl }, () => {
  const { outDir, result } = renderInto(azdEnvironment({
    GHCP_GITHUB_HOSTING: 'ghe.com', GHCP_GHE_SUBDOMAIN: 'contoso', GHCP_ENTERPRISE_SHORTCODE: '',
    GHCP_PUBLIC_SSO_HOST: 'sso.example.com', GHCP_PUBLIC_CONSOLE_HOST: 'console.example.com', APPGW_PRIVATE_IP: '10.40.5.10',
    GHCP_PROXY_ILB: 'true', GHCP_PROXY_ILB_ALLOWED_CIDRS: '10.30.0.0/23', GHCP_MYSQL_MODE: 'dba-schema',
    GHCP_LITELLM_NAMESPACE: 'litellm', GHCP_INTERNAL_ALLOWED_CIDRS: '192.0.2.0/24', GHCP_CONFIG_APPROVED: 'true',
    GHCP_PROXY_CONFIG_OVERRIDES: JSON.stringify({ POOL_INFERENCE_TIMEOUT_SECONDS: '600' }),
  }));
  try {
    assert.deepEqual(result.errors, []);
    assert.equal(result.approved, true);
    writeOverlay(result, outDir);
    const { objects } = kustomize(path.join(outDir, 'app'));
    assert.equal(named(objects, 'ConfigMap', 'ghcp-common').data.GHCP_CONFIG_APPROVED, 'true');
    const enterprise = named(objects, 'ConfigMap', 'ghcp-enterprise').data;
    assert.equal(enterprise.GITHUB_BASE_URL, 'https://contoso.ghe.com');
    assert.ok(!('ENTERPRISE_SHORTCODE' in enterprise));
    assert.equal(enterprise.SSO_PUBLIC_BASE_URL, 'https://sso.example.com');
    assert.equal(named(objects, 'ConfigMap', 'ghcp-sso-config').data.SCIM_BASE_URL, 'https://api.contoso.ghe.com/scim/v2/enterprises/contoso');
    assert.equal(named(objects, 'ConfigMap', 'ghcp-console-config').data.CONSOLE_PUBLIC_BASE_URL, 'https://console.example.com');
    const proxyConfig = named(objects, 'ConfigMap', 'ghcp-proxy-config').data;
    assert.equal(proxyConfig.MYSQL_AUTO_MIGRATE, 'false');
    assert.equal(proxyConfig.POOL_INFERENCE_TIMEOUT_SECONDS, '600');
    assert.deepEqual(named(objects, 'Deployment', 'ghcp-login').spec.template.spec.hostAliases,
      [{ ip: '10.40.5.10', hostnames: ['sso.example.com'] }], 'Login reaches the public SSO host through the App GW private front end');
    assert.equal(named(objects, 'NetworkPolicy', 'ghcp-azure-login-appgw').spec.egress[0].to[0].ipBlock.cidr, '10.40.5.10/32');
    assert.deepEqual(named(objects, 'Service', 'ghcp-proxy-ilb').spec.loadBalancerSourceRanges, ['10.30.0.0/23']);
    assert.deepEqual(named(objects, 'Service', 'ghcp-console-ilb').spec.loadBalancerSourceRanges, ['10.40.5.0/24', '192.0.2.0/24']);
    const proxyPolicy = named(objects, 'NetworkPolicy', 'ghcp-proxy');
    assert.equal(proxyPolicy.spec.ingress[0].from[0].namespaceSelector.matchLabels['kubernetes.io/metadata.name'], 'litellm');
    assert.deepEqual(proxyPolicy.spec.ingress[0].from[0].podSelector, { matchLabels: { app: 'litellm' } }, 'LiteLLM AKS template pod label');
    const bootstrap = kustomize(path.join(outDir, 'mysql-bootstrap')).objects;
    assert.equal(named(bootstrap, 'ConfigMap', 'ghcp-mysql-bootstrap-config').data.GHCP_MYSQL_MODE, 'dba-schema');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('renderer: a published Proxy gets its internal load balancer, reachable only from the App GW subnet', { skip: skipKubectl }, () => {
  const { outDir, result } = renderInto(azdEnvironment({ GHCP_PUBLIC_PROXY_HOST: 'proxy.example.com', APPGW_PRIVATE_IP: '10.40.5.10' }));
  try {
    assert.deepEqual(result.errors, []);
    writeOverlay(result, outDir);
    const { objects } = kustomize(path.join(outDir, 'app'));
    const ilb = named(objects, 'Service', 'ghcp-proxy-ilb');
    assert.deepEqual(ilb.spec.loadBalancerSourceRanges, ['10.40.5.0/24']);
    assert.equal(ilb.metadata.annotations['service.beta.kubernetes.io/azure-load-balancer-ipv4'], '10.40.4.70');
    assert.deepEqual(named(objects, 'NetworkPolicy', 'ghcp-azure-proxy-ilb-ingress').spec.ingress[0].from, [{ ipBlock: { cidr: '10.40.5.0/24' } }]);
    assert.equal(result.summary.proxyPublicHost, 'proxy.example.com');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('renderer: a changed rendered value rolls only the services that read it (config-hash annotation)', { skip: skipKubectl }, () => {
  const hashes = (overrides) => {
    const { outDir, result } = renderInto(azdEnvironment(overrides));
    try {
      assert.deepEqual(result.errors, []);
      writeOverlay(result, outDir);
      const { objects } = kustomize(path.join(outDir, 'app'));
      return Object.fromEntries(['proxy', 'sso', 'login', 'console'].map((service) => [service,
        named(objects, 'Deployment', `ghcp-${service}`).spec.template.metadata.annotations['ghcp.azure/config-hash']]));
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  };
  const before = hashes({});
  assert.ok(Object.values(before).every((hash) => /^[0-9a-f]{16}$/.test(hash)));
  assert.deepEqual(hashes({}), before, 'rendering is deterministic');
  // Opening the Console publicly changes CONSOLE_PUBLIC_BASE_URL, which only Console reads.
  const after = hashes({ GHCP_PUBLIC_CONSOLE_HOST: 'console.example.com', APPGW_PRIVATE_IP: '10.40.5.10' });
  assert.notEqual(after.console, before.console);
  assert.deepEqual([after.proxy, after.sso, after.login], [before.proxy, before.sso, before.login]);
});

test('renderer: refuses approval with missing values, secrets in ConfigMaps and open Proxy ranges', () => {
  const missing = renderOverlay(azdEnvironment({ GHCP_ENTERPRISE_SLUG: '', GHCP_CONFIG_APPROVED: 'true' }), path.join(os.tmpdir(), 'unused'));
  assert.ok(missing.errors.some((e) => /GHCP_CONFIG_APPROVED=true but these values are missing: GHCP_ENTERPRISE_SLUG/.test(e)));
  assert.equal(missing.approved, false);
  const secret = renderOverlay(azdEnvironment({ GHCP_PROXY_CONFIG_OVERRIDES: '{"API_KEY":"x"}' }), path.join(os.tmpdir(), 'unused'));
  assert.ok(secret.errors.some((e) => /secrets belong in Key Vault/.test(e)));
  const open = renderOverlay(azdEnvironment({ GHCP_PROXY_ILB: 'true', GHCP_PROXY_ILB_ALLOWED_CIDRS: '0.0.0.0/0' }), path.join(os.tmpdir(), 'unused'));
  assert.ok(open.errors.some((e) => /GHCP_PROXY_ILB_ALLOWED_CIDRS: 0\.0\.0\.0\/0 is not allowed/.test(e)));
  const noInfra = renderOverlay({ AZURE_ENV_NAME: 'x' }, path.join(os.tmpdir(), 'unused'));
  assert.ok(noInfra.errors.some((e) => /AZURE_CONTAINER_REGISTRY_ENDPOINT is not set/.test(e)));
});

// ---------------------------------------------------------------------------
// MySQL bootstrap, hooks, consistency, hygiene
// ---------------------------------------------------------------------------
test('MySQL bootstrap: least privilege per mode, values bound as parameters, inputs validated', () => {
  const syntax = exec(process.execPath, ['--check', path.join(directory, 'k8s/mysql-bootstrap/bootstrap.cjs')]);
  assert.equal(syntax.status, 0, syntax.stderr);
  const { plan, AUTO_MIGRATE_PRIVILEGES, DML_PRIVILEGES } = require('./k8s/mysql-bootstrap/bootstrap.cjs');
  const env = { database: 'ghcp_proxy', proxyUser: 'ghcp_proxy', proxyHost: '10.40.0.0/255.255.252.0', mode: 'auto-migrate', proxyPassword: 'p@ss\'word' };
  const statements = plan(env);
  assert.equal(statements.length, 3);
  for (const [sql] of statements) assert.ok(!sql.includes(env.proxyPassword), 'password never interpolated');
  assert.match(statements[0][0], /REQUIRE SSL/);
  assert.ok(statements[2][0].includes(AUTO_MIGRATE_PRIVILEGES));
  assert.equal(AUTO_MIGRATE_PRIVILEGES, 'SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER',
    'same grants as deploy/kubernetes/README.md section 3.2 (mode A)');
  assert.ok(plan({ ...env, mode: 'dba-schema' })[2][0].includes(`GRANT ${DML_PRIVILEGES} ON`));
  assert.throws(() => plan({ ...env, database: 'x; DROP' }), /MYSQL_DATABASE/);
  assert.throws(() => plan({ ...env, proxyUser: "a'b" }), /MYSQL_PROXY_USER/);
  assert.throws(() => plan({ ...env, mode: 'other' }), /GHCP_MYSQL_MODE/);
  const readme = readFileSync(path.join(root, 'deploy/kubernetes/README.md'), 'utf8');
  assert.ok(readme.includes('GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER'));
});

const skipPwsh = onPath('pwsh') ? false : 'pwsh is not installed';
test('PowerShell hooks parse, and every az call goes through Invoke-Az (which adds --subscription)', { skip: skipPwsh }, () => {
  const hooks = path.join(directory, 'hooks');
  const script = [
    '$failed = 0',
    `foreach ($f in Get-ChildItem -LiteralPath '${hooks.replaceAll("'", "''")}' -Filter *.ps1) {`,
    '  $t = $null; $e = $null',
    '  [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$t, [ref]$e) | Out-Null',
    '  foreach ($x in $e) { $failed++; Write-Output "$($f.Name):$($x.Extent.StartLineNumber): $($x.Message)" }',
    '}',
    'exit $failed',
  ].join('\n');
  const result = exec('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const file of readdirSync(hooks).filter((f) => f.endsWith('.ps1'))) {
    const lines = readFileSync(path.join(hooks, file), 'utf8').split('\n');
    for (const line of lines) {
      if (/^\s*#/.test(line) || /throw '|throw "|Write-(Host|Warning)/.test(line)) continue;
      if (/(^|[\s(&|])az\s+[a-z]/.test(line) && !line.includes("& az @all")) assert.fail(`${file}: direct az call: ${line.trim()}`);
      if (/\bkubectl\s/.test(line) && !/--kubeconfig|Invoke-Kubectl|kubectl kustomize|& kubectl @all/.test(line) && !/'kubectl/.test(line)) {
        assert.fail(`${file}: kubectl without an explicit kubeconfig: ${line.trim()}`);
      }
    }
  }
  assert.match(readFileSync(path.join(hooks, 'common.ps1'), 'utf8'), /\$all = @\(\$Arguments\) \+ @\('--subscription', \(Get-Subscription\)/);
});

test('one source of truth: image digests, Key Vault secret names, Bicep outputs and documented variables', () => {
  const images = JSON.parse(readFileSync(path.join(directory, 'images.json'), 'utf8')).images;
  const base = readFileSync(path.join(root, 'deploy/kubernetes/base/kustomization.yaml'), 'utf8');
  const release = readFileSync(path.join(root, 'docs/multi-enterprise-release-validation.md'), 'utf8');
  const bootstrapKustomization = readFileSync(path.join(directory, 'k8s/mysql-bootstrap/kustomization.yaml'), 'utf8');
  for (const reference of Object.values(images)) {
    assert.ok(release.includes(reference), `release record lists ${reference}`);
    assert.ok(base.includes(reference.split('@')[1]), `base pins ${reference}`);
  }
  assert.ok(bootstrapKustomization.includes(images['ghcp-proxy'].split('@')[1]), 'bootstrap job uses the released Proxy image');

  const spcText = readFileSync(path.join(root, 'deploy/kubernetes/components/azure-aks/secret-provider-classes.yaml'), 'utf8')
    + readFileSync(path.join(directory, 'k8s/mysql-bootstrap/job.yaml'), 'utf8');
  const objectNames = new Set([...spcText.matchAll(/objectName: (ghcp-[a-z0-9-]+|mysql-[a-z0-9-]+)\n\s+objectType/g)].map((m) => m[1]));
  const postprovision = readFileSync(path.join(directory, 'hooks/postprovision.ps1'), 'utf8');
  const main = readFileSync(path.join(infra, 'main.bicep'), 'utf8');
  const readme = readFileSync(path.join(directory, 'README.md'), 'utf8');
  for (const name of objectNames) {
    assert.ok(postprovision.includes(`'${name}'`) || main.includes(`'${name}'`), `${name} is generated or reported by the deployment`);
    assert.ok(readme.includes(name), `README documents Key Vault secret ${name}`);
  }

  const outputs = new Set([...main.matchAll(/^output (\w+) /gm)].map((m) => m[1]));
  const renderer = readFileSync(path.join(directory, 'scripts/render-overlay.mjs'), 'utf8');
  const fromBicep = ['AZURE_CONTAINER_REGISTRY_ENDPOINT', 'AZURE_KEY_VAULT_NAME', 'AZURE_TENANT_ID', 'GHCP_WORKLOAD_CLIENT_ID', 'GHCP_NAMESPACE',
    'GHCP_GITHUB_HOSTING', 'GHCP_PROXY_REPLICAS', 'GHCP_DISK_SKU', 'GHCP_ILB_SUBNET_NAME', 'GHCP_SSO_ILB_IP', 'GHCP_CONSOLE_ILB_IP',
    'GHCP_PROXY_ILB_IP', 'VNET_ADDRESS_PREFIXES', 'PE_SUBNET_PREFIX', 'APPGW_SUBNET_PREFIX', 'AKS_SUBNET_PREFIX', 'POD_CIDR', 'MYSQL_FQDN',
    'MYSQL_ADMIN_LOGIN', 'MYSQL_DATABASE', 'GHCP_NETWORK_POLICY_ENGINE', 'GHCP_PUBLIC_SSO_HOST', 'GHCP_PUBLIC_CONSOLE_HOST', 'APPGW_PRIVATE_IP'];
  for (const name of fromBicep) {
    assert.ok(outputs.has(name), `main.bicep outputs ${name}`);
    assert.ok(renderer.includes(name), `renderer reads ${name}`);
  }
  const hooks = readdirSync(path.join(directory, 'hooks')).map((f) => readFileSync(path.join(directory, 'hooks', f), 'utf8')).join('\n');
  for (const name of ['AZURE_CONTAINER_REGISTRY_NAME', 'AZURE_KEY_VAULT_RESOURCE_ID', 'AZURE_AKS_CLUSTER_NAME', 'AZURE_AKS_RESOURCE_GROUP',
    'NAT_EGRESS_IP', 'GHCP_BYO_NETWORK', 'GHCP_BYO_AKS', 'GHCP_PUBLIC_ACCESS_ENABLED', 'APPGW_PUBLIC_IP']) {
    assert.ok(outputs.has(name), `main.bicep outputs ${name}`);
    assert.ok(hooks.includes(name), `hooks read ${name}`);
  }
  // Every operator-facing variable is documented.
  const params = readFileSync(path.join(infra, 'main.bicepparam'), 'utf8');
  const variables = new Set([...params.matchAll(/readEnvironmentVariable\('(GHCP_[A-Z0-9_]+)'/g)].map((m) => m[1]));
  for (const m of renderer.matchAll(/env\.(GHCP_[A-Z0-9_]+)/g)) if (!outputs.has(m[1])) variables.add(m[1]);
  for (const m of hooks.matchAll(/'(GHCP_[A-Z0-9_]+)'/g)) if (!outputs.has(m[1])) variables.add(m[1]);
  for (const name of variables) assert.ok(readme.includes(name), `README documents ${name}`);
});

test('repository hygiene: no tenant data, local paths, real host names or generated files in deploy/azure', () => {
  const files = [...walk(directory), ...walk(path.join(root, 'deploy/kubernetes/components/azure-aks')),
    ...walk(path.join(root, 'deploy/kubernetes/components/azure-proxy-ilb')), ...walk(path.join(root, 'deploy/kubernetes/overlays/azure-aks')),
    path.join(root, 'deploy/kubernetes/azure-aks.test.mjs')];
  const builtInRoleIds = new Set(['7f951dda-4ed3-4680-a7ca-43fe172d538d', '4633458b-17de-408a-b874-0445c86b69e6',
    'b86a8fe4-44ce-4948-aee5-eccb2c155cd7', '4d97b98b-1d4f-4787-a291-c67834d212e7', 'b0d8363b-8ddd-447d-831f-62ca05bff136',
    'b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b', '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000001']);
  const allowedHosts = /(^|\.)(example\.(com|org)|azure\.(com|net)|azurecr\.io|microsoft\.com|digicert\.com|github\.com|githubcopilot\.com|ghe\.com|docker\.io|windows\.net|aka\.ms|cloudapp\.azure\.com|cluster\.local|k8s\.io|kubernetes\.io|x-k8s\.io|mysql\.com|learn\.microsoft\.com|sigs\.k8s\.io|schema\.management\.azure\.com|azure-api\.net|vault\.azure\.net|vaultcore\.azure\.net)$/;
  for (const file of files) {
    // The PEM bundle is public; the two test files contain the very patterns searched for here.
    if (/\.pem$/.test(file) || /(azure|azure-aks)\.test\.mjs$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    const rel = path.relative(root, file);
    for (const guid of text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) ?? []) {
      assert.ok(builtInRoleIds.has(guid.toLowerCase()), `${rel}: unexpected GUID ${guid} (subscription / tenant / object IDs must not be committed)`);
    }
    assert.doesNotMatch(text, /[A-Za-z]:\\Users\\|\/c\/Users\/|\/home\/[a-z]+\//, `${rel}: local path`);
    assert.doesNotMatch(text, /onmicrosoft\.com|BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20}|github_pat_/, `${rel}: credential or tenant name`);
    for (const ip of text.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? []) {
      const [a, b] = ip.split('.').map(Number);
      const privateOrDoc = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 100 || a === 0 || a === 127
        || ip.startsWith('192.0.2.') || ip.startsWith('198.51.100.') || ip.startsWith('203.0.113.') || ip === '168.63.129.16'
        || ip.startsWith('255.') || /^(\d+\.){3}\d+$/.test(ip) && a === 1 && b <= 3;
      assert.ok(privateOrDoc, `${rel}: public IP ${ip}`);
    }
    for (const host of text.match(/\b(?:[a-z0-9-]+\.)+(?:com|net|io|cn|org)\b/g) ?? []) {
      assert.ok(allowedHosts.test(host) || /^REPLACE_/.test(host), `${rel}: host name ${host}`);
    }
  }
  assert.ok(readFileSync(path.join(directory, '.gitignore'), 'utf8').includes('.generated/'));
  assert.ok(!existsSync(path.join(directory, '.generated')) || readdirSync(path.join(directory, '.generated')).every((d) => d.startsWith('.test-')),
    'generated overlays are never part of the tree');
});

// ---------------------------------------------------------------------------
// Multi-enterprise registry: conventions match the product code; invalid registries fail before deploy.
// ---------------------------------------------------------------------------
const registryModule = () => import('./scripts/enterprise-registry.mjs');
const exampleRegistry = () => JSON.parse(readFileSync(path.join(directory, 'enterprise-registry.azure.example.json'), 'utf8'));
const registryContext = { defaultBaseUrl: 'https://github.com', defaultSlug: 'contoso', defaultAccountDomain: 'pool.contoso.example.com',
  defaultMaxAccounts: 100, ssoPublicBaseUrl: 'http://10.40.4.68:7001' };

test('registry conventions follow the product code: fields, secret fields, readers, ID rule', async () => {
  const { ENTERPRISE_SECRETS, REGISTRY_TEXT_FIELDS, LOGIN_SELECTOR_KEYS, enterpriseSecretName } = await registryModule();
  const shared = path.join(root, 'src/packages/shared/src/enterprise');
  const fieldsSource = readFileSync(path.join(shared, 'registryFields.ts'), 'utf8');
  const kinds = [...fieldsSource.slice(fieldsSource.indexOf('const FIELD_KINDS'), fieldsSource.indexOf(']);', fieldsSource.indexOf('const FIELD_KINDS')))
    .matchAll(/\['([a-zA-Z.]+)', '(\w+)'\]/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(kinds.filter(([, kind]) => kind !== 'secret').map(([field]) => field).sort(), [...REGISTRY_TEXT_FIELDS].sort());
  const ssoSecretKeys = /SSO_SECRET_KEYS = \[([^\]]+)\]/.exec(fieldsSource)[1].match(/'(\w+)'/g).map((k) => `sso.${k.slice(1, -1)}`);
  const secretFields = [...ssoSecretKeys, ...kinds.filter(([, kind]) => kind === 'secret').map(([field]) => field)];
  assert.deepEqual(ENTERPRISE_SECRETS.map((s) => s.field).sort(), secretFields.sort(), 'every secret field of the registry has a convention');
  const selectorKeys = /LOGIN_SELECTOR_KEYS = \[([^\]]+)\]/.exec(fieldsSource)[1].match(/'(\w+)'/g).map((k) => k.slice(1, -1));
  assert.deepEqual([...LOGIN_SELECTOR_KEYS], selectorKeys);
  // Readers: SSO reads sso.* (ssoSecret), Proxy reads modelsAdmin.copilotToken (modelsAdminToken), Login reads none.
  assert.match(readFileSync(path.join(root, 'src/sso/src/enterprises.ts'), 'utf8'), /enterprise\.profile\.sso\[field\];\s+if \(!ref\) return undefined;\s+return readSecret/);
  assert.match(readFileSync(path.join(root, 'src/proxy/src/enterprises.ts'), 'utf8'), /modelsAdmin\?\.copilotToken[\s\S]{0,200}readSecret\(ref/);
  assert.doesNotMatch(readFileSync(path.join(root, 'src/login/src/enterprises.ts'), 'utf8'), /readSecret/);
  for (const secret of ENTERPRISE_SECRETS) assert.equal(secret.service, secret.field.startsWith('sso.') ? 'sso' : 'proxy', secret.field);
  // {file} must be absolute (secrets.ts); IDs follow scope.ts; the longest ID still gives a valid Key Vault name.
  assert.match(readFileSync(path.join(shared, 'secrets.ts'), 'utf8'), /if \(!isAbsolute\(path\)\)/);
  assert.match(readFileSync(path.join(shared, 'scope.ts'), 'utf8'), /ENTERPRISE_ID_PATTERN = \/\^\[a-z\]\[a-z0-9-\]\{0,30\}\[a-z0-9\]\$\//);
  const longest = `a${'b'.repeat(30)}c`;
  for (const secret of ENTERPRISE_SECRETS) assert.match(enterpriseSecretName(longest, secret), /^[A-Za-z0-9-]{1,127}$/);
  // The example follows the shared docs' path convention and passes validation.
  const { validateEnterpriseRegistry } = await registryModule();
  const checked = validateEnterpriseRegistry(exampleRegistry(), registryContext);
  assert.deepEqual(checked.errors, []);
  assert.deepEqual(checked.enterprises.map((e) => [e.id, e.isGheCom, e.secrets.length]), [['tailspin', false, 6], ['fabrikam-ghe', true, 7]]);
});

test('registry validation fails fast on IDs, missing or non-conventional secrets and GHE.com rules', async () => {
  const { validateEnterpriseRegistry } = await registryModule();
  const mutate = (change) => {
    const registry = exampleRegistry();
    change(registry.enterprises[0], registry.enterprises[1], registry);
    return validateEnterpriseRegistry(registry, registryContext).errors;
  };
  const cases = [
    [(a) => { a.id = 'Tailspin'; }, /enterprises\[0\]\.id must match/],
    [(a) => { a.id = `t${'x'.repeat(32)}`; }, /enterprises\[0\]\.id must match/],
    [(a) => { a.id = 'bad_id'; }, /enterprises\[0\]\.id must match/],
    [(a) => { a.id = 'default'; }, /default must not be in the registry/],
    [(a, b) => { b.id = 'tailspin'; }, /duplicate enterprise id/],
    [(a) => { delete a.sso.scimToken; }, /tailspin\.sso\.scimToken is required: \{"file": "\/run\/secrets\/tailspin\/scim-token"\}/],
    [(a) => { delete a.sso.seatPat; }, /tailspin\.sso\.seatPat is required/],
    [(a) => { delete a.sso.signingKey; }, /tailspin\.sso\.signingKey is required/],
    [(a) => { a.sso.scimToken = { env: 'SCIM_TOKEN' }; }, /\{"env": \.\.\.\} is not supported/],
    [(a) => { a.sso.scimToken = { file: '/run/secrets/other/scim-token' }; }, /must reference \/run\/secrets\/tailspin\/scim-token \(Key Vault secret ghcp-ent-tailspin-scim-token\)/],
    [(a) => { a.sso.scimToken = { file: 'scim-token' }; }, /must reference \/run\/secrets\/tailspin\/scim-token/],
    [(a, b) => { b.modelsAdmin.copilotToken = { file: '/run/secrets/fabrikam-ghe/token' }; }, /fabrikam-ghe\.modelsAdmin\.copilotToken must reference/],
    [(a) => { a.sso.unknownSecret = { file: '/run/secrets/tailspin/x' }; }, /tailspin\.sso\.unknownSecret is not a known registry field/],
    [(a) => { delete a.github.shortcode; }, /tailspin\.github\.shortcode is required on github\.com/],
    [(a, b) => { b.github.shortcode = 'fab'; }, /fabrikam-ghe\.github\.shortcode must be empty on GHE\.com/],
    [(a, b) => { delete b.github.slug; }, /fabrikam-ghe\.github\.slug is required \(the enterprise slug; SSO and Login need it\)/],
    [(a, b) => { b.github.apiBaseUrl = 'https://api.other.ghe.com'; }, /fabrikam-ghe\.github\.apiBaseUrl must be under the same fabrikam\.ghe\.com/],
    [(a) => { a.github.baseUrl = 'https://github.example.com'; }, /tailspin\.github\.baseUrl is required/],
    [(a) => { a.pool.accountDomain = 'pool.contoso.example.com'; }, /tailspin\.pool\.accountDomain duplicates default\.pool\.accountDomain/],
    [(a) => { a.github.slug = 'contoso'; }, /tailspin\.github\.slug duplicates default\.github\.slug/],
    [(a) => { delete a.pool.accountDomain; }, /tailspin\.pool\.accountDomain is required/],
    [(a) => { a.login = { ssoLoginUrl: 'http://sso:7001/enterprises/tailspin/login' }; }, /tailspin\.login\.ssoLoginUrl must be http:\/\/10\.40\.4\.68:7001\/enterprises\/tailspin\/login/],
    [(a, b, r) => { r.extra = true; }, /registry\.extra is not a known registry field/],
    [(a, b, r) => { r.enterprises = []; }, /registry\.enterprises must list 1 to 31/],
  ];
  for (const [change, pattern] of cases) {
    const errors = mutate(change);
    assert.ok(errors.some((e) => pattern.test(e)), `${pattern} → ${errors.join('; ')}`);
  }
  // A correct override of ssoLoginUrl and an optional Models token omitted are accepted.
  assert.deepEqual(mutate((a) => { a.login = { ssoLoginUrl: 'http://10.40.4.68:7001/enterprises/tailspin/login' }; }), []);
  assert.deepEqual(mutate((a, b) => { delete b.modelsAdmin; }), []);
});

test('renderer: a broken registry blocks rendering and approval; the CLI lists the Key Vault secrets', { skip: skipKubectl }, () => {
  const registry = exampleRegistry();
  delete registry.enterprises[1].sso.seatPat;
  const broken = renderOverlay(azdEnvironment({ GHCP_CONFIG_APPROVED: 'true' }), path.join(os.tmpdir(), 'unused'), { registry });
  assert.ok(broken.errors.some((e) => /^enterprise registry: fabrikam-ghe\.sso\.seatPat is required/.test(e)));
  assert.equal(broken.approved, false);
  const missingFile = renderOverlay(azdEnvironment({ GHCP_ENTERPRISE_REGISTRY_FILE: path.join(os.tmpdir(), `missing-${randomUUID()}.json`) }), path.join(os.tmpdir(), 'unused'));
  assert.ok(missingFile.errors.some((e) => /GHCP_ENTERPRISE_REGISTRY_FILE could not be read/.test(e)));
  const cli = exec(process.execPath, [path.join(directory, 'scripts/render-overlay.mjs'), 'enterprise-secrets'],
    { env: { ...process.env, ...azdEnvironment({ GHCP_ENTERPRISE_REGISTRY_FILE: path.join(directory, 'enterprise-registry.azure.example.json') }) } });
  assert.equal(cli.status, 0, cli.stderr);
  const secrets = JSON.parse(cli.stdout);
  assert.equal(secrets.length, 13);
  assert.deepEqual(secrets.filter((s) => s.generated).map((s) => s.name).sort(), ['ghcp-ent-fabrikam-ghe-session-secret',
    'ghcp-ent-fabrikam-ghe-sso-default-user-password', 'ghcp-ent-tailspin-session-secret', 'ghcp-ent-tailspin-sso-default-user-password']);
  assert.ok(secrets.every((s) => /^ghcp-ent-(tailspin|fabrikam-ghe)-[a-z-]+$/.test(s.name)));
  const none = exec(process.execPath, [path.join(directory, 'scripts/render-overlay.mjs'), 'enterprise-secrets'], { env: { ...process.env, ...azdEnvironment() } });
  assert.equal(none.stdout.trim(), '[]', 'without a registry: default only');
  // Hooks: generated per-enterprise secrets, presence check before deploy, per-enterprise names in Set-GhcpSecret.
  const hooks = (name) => readFileSync(path.join(directory, 'hooks', name), 'utf8');
  assert.match(hooks('postprovision.ps1'), /Get-EnterpriseSecrets \| Where-Object \{ \$_\.generated \}/);
  assert.match(hooks('deploy-app.ps1'), /Assert-EnterpriseSecretsPresent/);
  assert.match(hooks('Set-GhcpSecret.ps1'), /\$Name = "ghcp-ent-\$Enterprise-\$Kind"/);
});

test('Set-GhcpSecret -Kind values are exactly the Key Vault suffixes of the convention', async () => {
  const { ENTERPRISE_SECRETS } = await registryModule();
  const source = readFileSync(path.join(directory, 'hooks/Set-GhcpSecret.ps1'), 'utf8');
  const kinds = /\[ValidateSet\(([^)]+)\)\]\s*\[string\] \$Kind/.exec(source)[1].match(/'([a-z-]+)'/g).map((k) => k.slice(1, -1));
  assert.deepEqual(kinds.sort(), ENTERPRISE_SECRETS.map((s) => s.suffix).sort());
  assert.match(source, /ValidatePattern\('\^\[a-z\]\[a-z0-9-\]\{0,30\}\[a-z0-9\]\$'\)\]\[string\] \$Enterprise/);
});
