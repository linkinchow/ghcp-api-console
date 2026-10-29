#!/usr/bin/env node
// 按 azd 环境（Bicep 输出 + 运维填写的企业变量）生成每个环境的私有 Kustomize overlay。
// 只读环境变量、只写 deploy/azure/.generated/<环境>/（已在 .gitignore 中），不访问网络、不调用 az / kubectl。
//
//   node deploy/azure/scripts/render-overlay.mjs render [--out <目录>] [--require-approved]
//   node deploy/azure/scripts/render-overlay.mjs validate-public-access
//
// 生成：
//   <out>/app/              引用 deploy/kubernetes/overlays/<github-com|ghe-com> + components/azure-aks（+ 可选组件），
//                           替换 REPLACE_*（ACR、Key Vault、Workload Identity、内网 IP、来源网段）并写入企业变量；
//   <out>/mysql-bootstrap/  引用 deploy/azure/k8s/mysql-bootstrap，替换同样的 Azure 值。
// 生成的文件是 JSON（YAML 的子集），避免手写 YAML 转义。
import { createHash, X509Certificate } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  enterpriseSecretDir,
  enterpriseSecretProviderClasses,
  REGISTRY_FILE_NAME,
  REGISTRY_FILE_PATH,
  REGISTRY_MOUNT_DIR,
  validateEnterpriseRegistry,
} from './enterprise-registry.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const azureDir = path.resolve(scriptDir, '..');
export const deployDir = path.resolve(azureDir, '..');

const IMAGES = ['ghcp-proxy', 'ghcp-sso', 'ghcp-login', 'ghcp-console'];
const SPC_NAMES = ['ghcp-proxy-kv', 'ghcp-sso-kv', 'ghcp-login-kv', 'ghcp-console-kv'];
const DNS_LABEL = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
export function isIpv4(value) {
  const parts = String(value).split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export function isCidr(value) {
  const [ip, bits, extra] = String(value).split('/');
  return extra === undefined && isIpv4(ip) && /^\d{1,2}$/.test(bits ?? '') && Number(bits) <= 32;
}

/** "a, b,c" / '["a","b"]' → ['a','b','c']（空值 → []）。 */
export function list(value) {
  if (value === undefined || value === null || String(value).trim() === '') return [];
  const text = String(value).trim();
  if (text.startsWith('[')) return JSON.parse(text).map((v) => String(v).trim()).filter(Boolean);
  return text.split(',').map((v) => v.trim()).filter(Boolean);
}

const unique = (values) => [...new Set(values)];
const truthy = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['true', '1', 'yes'].includes(String(value).toLowerCase());
};

/** 10.40.0.0/22 → 10.40.0.0/255.255.252.0（MySQL 账号的 host 写法）。 */
export function cidrToMysqlHost(cidr) {
  if (!isCidr(cidr)) throw new Error(`not a CIDR: ${cidr}`);
  const [ip, bits] = cidr.split('/');
  const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  const octets = [24, 16, 8, 0].map((shift) => (mask >>> shift) & 255);
  return `${ip}/${octets.join('.')}`;
}

function relativeTo(fromDir, target) {
  return path.relative(fromDir, target).split(path.sep).join('/');
}

function json(object) {
  return `${JSON.stringify(object, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// 公网访问参数校验（preprovision hook 调用；与 infra/types.bicep 的类型一致）
// ---------------------------------------------------------------------------
export function validatePublicAccess(raw) {
  const errors = [];
  const warnings = [];
  let value;
  try {
    value = raw === undefined || String(raw).trim() === '' ? {} : JSON.parse(raw);
  } catch (error) {
    return { errors: [`GHCP_PUBLIC_ACCESS is not valid JSON: ${error.message}`], warnings, value: null };
  }
  const known = ['sso', 'console', 'litellm', 'proxy', 'allowedSourceCidrs', 'litellmAllowedSourceCidrs', 'proxyAllowedSourceCidrs',
    'proxyClientCaCertificate', 'ssoAllowAnySource', 'litellmAllowAnySource', 'hostNames', 'certificateNames', 'litellmBackend',
    'litellmAllowedPathPrefixes', 'wafMode', 'splitHorizonDns'];
  for (const key of Object.keys(value)) if (!known.includes(key)) errors.push(`unknown key publicAccess.${key}`);
  for (const key of ['sso', 'console', 'litellm', 'proxy']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') errors.push(`publicAccess.${key} must be true or false`);
  }
  for (const key of ['allowedSourceCidrs', 'litellmAllowedSourceCidrs', 'proxyAllowedSourceCidrs']) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key])) { errors.push(`publicAccess.${key} must be an array`); continue; }
    for (const cidr of value[key]) {
      if (!isCidr(cidr)) errors.push(`publicAccess.${key}: ${cidr} is not an IPv4 CIDR (use a.b.c.d/32 for one address)`);
      else if (cidr.endsWith('/0')) errors.push(`publicAccess.${key}: ${cidr} allows the whole internet; use *AllowAnySource instead`);
    }
  }
  const enabled = ['sso', 'console', 'litellm', 'proxy'].filter((key) => value[key] === true);
  if (value.proxy === true) {
    // 持有共享 API_KEY 的任何人都能冒用任意 X-User-Identity：来源必须收窄到 LiteLLM 的出口地址。
    const sources = value.proxyAllowedSourceCidrs ?? [];
    if (!Array.isArray(sources) || sources.length === 0) {
      errors.push('publicAccess.proxyAllowedSourceCidrs is required when publicAccess.proxy is true (LiteLLM egress IPs only)');
    }
    for (const cidr of Array.isArray(sources) ? sources : []) {
      if (isCidr(cidr) && Number(cidr.split('/')[1]) < 28) {
        warnings.push(`publicAccess.proxyAllowedSourceCidrs: ${cidr} is wider than /28; list only the LiteLLM egress addresses`);
      }
    }
    const ca = value.proxyClientCaCertificate;
    if (ca === undefined || ca === '') {
      warnings.push('Proxy is published without mutual TLS: set publicAccess.proxyClientCaCertificate so only LiteLLM can connect');
    } else {
      try {
        const certificate = new X509Certificate(Buffer.from(String(ca).replace(/-----[A-Z ]+-----|\s/g, ''), 'base64'));
        if (!certificate.ca) warnings.push('publicAccess.proxyClientCaCertificate is not a CA certificate');
      } catch {
        errors.push('publicAccess.proxyClientCaCertificate must be the base64 of a CA certificate (public, no private key)');
      }
      if (/PRIVATE KEY/.test(String(ca))) errors.push('publicAccess.proxyClientCaCertificate must not contain a private key');
    }
    warnings.push('Proxy is published: anyone holding the shared API_KEY can claim any caller identity. Prefer publishing LiteLLM (public-access-design.md section 4).');
  }
  for (const key of enabled) {
    const host = value.hostNames?.[key];
    if (!host) errors.push(`publicAccess.hostNames.${key} is required when publicAccess.${key} is true`);
    else if (!DNS_LABEL.test(host)) errors.push(`publicAccess.hostNames.${key}: ${host} is not a lowercase DNS name (no scheme, port or path)`);
  }
  const hosts = enabled.map((key) => value.hostNames?.[key]).filter(Boolean);
  if (new Set(hosts).size !== hosts.length) errors.push('publicAccess.hostNames must be different for each endpoint');
  if (value.litellm === true) {
    const backend = value.litellmBackend;
    if (!backend?.address) errors.push('publicAccess.litellmBackend.address is required when publicAccess.litellm is true');
    if (backend?.port !== undefined && !(Number.isInteger(backend.port) && backend.port > 0 && backend.port < 65536)) {
      errors.push('publicAccess.litellmBackend.port must be a TCP port');
    }
    for (const prefix of value.litellmAllowedPathPrefixes ?? []) {
      if (!String(prefix).startsWith('/')) errors.push(`publicAccess.litellmAllowedPathPrefixes: ${prefix} must start with /`);
    }
  }
  if (value.wafMode !== undefined && !['Prevention', 'Detection'].includes(value.wafMode)) {
    errors.push('publicAccess.wafMode must be Prevention or Detection');
  }
  if (value.console === true && (value.allowedSourceCidrs ?? []).length === 0) {
    warnings.push('Console is published but allowedSourceCidrs is empty: only clients inside the VNet can reach it');
  }
  if (value.sso === true && value.ssoAllowAnySource === true) {
    warnings.push('SSO accepts any source address: SAML pages are open to the internet (password login is rate limited)');
  }
  if (value.litellm === true && value.litellmAllowAnySource === true) {
    warnings.push('LiteLLM accepts any source address: every request still needs a LiteLLM virtual key');
  }
  return { errors, warnings, value };
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
function enterpriseConfig(env, hosting, problems) {
  const slug = env.GHCP_ENTERPRISE_SLUG || '';
  const pending = (name) => problems.pending.push(name);
  if (!slug) pending('GHCP_ENTERPRISE_SLUG');
  else if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) problems.errors.push('GHCP_ENTERPRISE_SLUG must be the lowercase enterprise slug');
  const s = slug || 'REPLACE_ENTERPRISE_SLUG';
  const enterprise = {};
  const sso = {};
  if (hosting === 'ghe.com') {
    const sub = env.GHCP_GHE_SUBDOMAIN || '';
    if (!sub) pending('GHCP_GHE_SUBDOMAIN');
    else if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(sub)) problems.errors.push('GHCP_GHE_SUBDOMAIN must be the <subdomain> of <subdomain>.ghe.com');
    if (env.GHCP_ENTERPRISE_SHORTCODE) problems.warnings.push('GHCP_ENTERPRISE_SHORTCODE is ignored on GHE.com');
    const d = sub || 'REPLACE_GHE_SUBDOMAIN';
    enterprise.GITHUB_BASE_URL = `https://${d}.ghe.com`;
    sso.SP_ENTITY_ID = `https://${d}.ghe.com/enterprises/${s}`;
    sso.SP_ACS_URL = `https://${d}.ghe.com/enterprises/${s}/saml/consume`;
    sso.SCIM_BASE_URL = `https://api.${d}.ghe.com/scim/v2/enterprises/${s}`;
  } else {
    const shortcode = env.GHCP_ENTERPRISE_SHORTCODE || '';
    if (!shortcode) pending('GHCP_ENTERPRISE_SHORTCODE');
    else if (!/^[A-Za-z0-9]{1,32}$/.test(shortcode)) problems.errors.push('GHCP_ENTERPRISE_SHORTCODE must be alphanumeric');
    enterprise.GITHUB_BASE_URL = '';
    enterprise.ENTERPRISE_SHORTCODE = shortcode || 'REPLACE_ENTERPRISE_SHORTCODE';
    sso.SP_ENTITY_ID = `https://github.com/enterprises/${s}`;
    sso.SP_ACS_URL = `https://github.com/enterprises/${s}/saml/consume`;
    sso.SCIM_BASE_URL = `https://api.github.com/scim/v2/enterprises/${s}`;
  }
  enterprise.ENTERPRISE_SLUG = s;
  if (env.GHCP_GITHUB_API_BASE_URL) enterprise.GITHUB_API_BASE_URL = env.GHCP_GITHUB_API_BASE_URL;
  return { enterprise, sso };
}

function requireValue(env, name, problems, check) {
  const value = env[name];
  if (value === undefined || String(value).trim() === '') {
    problems.errors.push(`${name} is not set (run azd provision first, or set it with azd env set)`);
    return `REPLACE_${name}`;
  }
  if (check && !check(value)) problems.errors.push(`${name} has an unexpected value: ${value}`);
  return String(value).trim();
}

function networkPolicies(ctx) {
  const policies = [];
  // 下面都是“追加放行”：标准 NetworkPolicy 取并集，components/network-policy 的默认拒绝和占位规则保持不变。
  policies.push({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'ghcp-azure-proxy-mysql' },
    spec: {
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'ghcp-proxy' } },
      policyTypes: ['Egress'],
      // MySQL 私有终结点所在的子网。
      egress: [{ to: [{ ipBlock: { cidr: ctx.peSubnet } }], ports: [{ protocol: 'TCP', port: 3306 }] }],
    },
  });
  policies.push({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'ghcp-azure-sso-ingress' },
    spec: {
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'ghcp-sso' } },
      policyTypes: ['Ingress'],
      // 内部负载均衡（externalTrafficPolicy: Local 保留源地址）与 App GW 子网。
      ingress: [{ from: ctx.ssoSources.map((cidr) => ({ ipBlock: { cidr } })), ports: [{ protocol: 'TCP', port: 7001 }] }],
    },
  });
  policies.push({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'ghcp-azure-console-ingress' },
    spec: {
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'ghcp-console' } },
      policyTypes: ['Ingress'],
      ingress: [{ from: ctx.consoleSources.map((cidr) => ({ ipBlock: { cidr } })), ports: [{ protocol: 'TCP', port: 7004 }] }],
    },
  });
  if (ctx.appGwPrivateIp) {
    policies.push({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'ghcp-azure-login-appgw' },
      spec: {
        podSelector: { matchLabels: { 'app.kubernetes.io/name': 'ghcp-login' } },
        policyTypes: ['Egress'],
        // Login 的 Chromium 经 App GW 私网前端访问对外的 SSO 主机名（components/network-policy 只放行非私网 443）。
        egress: [{ to: [{ ipBlock: { cidr: `${ctx.appGwPrivateIp}/32` } }], ports: [{ protocol: 'TCP', port: 443 }] }],
      },
    });
  }
  if (ctx.proxyIlbSources.length) {
    policies.push({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'ghcp-azure-proxy-ilb-ingress' },
      spec: {
        podSelector: { matchLabels: { 'app.kubernetes.io/name': 'ghcp-proxy' } },
        policyTypes: ['Ingress'],
        ingress: [{ from: ctx.proxyIlbSources.map((cidr) => ({ ipBlock: { cidr } })), ports: [{ protocol: 'TCP', port: 3000 }] }],
      },
    });
  }
  return policies;
}

/**
 * Renders both overlays for one environment. `env` is the azd environment (process.env in the hooks).
 * Returns { files: {relativePath: content}, summary, errors, warnings, pending, approved }.
 */
/** The operator registry: options.registry (tests), else the JSON file named by GHCP_ENTERPRISE_REGISTRY_FILE. */
function loadRegistryInput(env, options, problems) {
  if (options.registry !== undefined) return options.registry;
  const file = env.GHCP_ENTERPRISE_REGISTRY_FILE;
  if (!file) return undefined;
  try {
    return JSON.parse(readFileSync(path.resolve(file), 'utf8'));
  } catch (error) {
    problems.errors.push(`GHCP_ENTERPRISE_REGISTRY_FILE could not be read as JSON: ${error.message}`);
    return undefined;
  }
}

export function renderOverlay(env, outDir, options = {}) {
  const problems = { errors: [], warnings: [], pending: [] };
  const hosting = requireValue(env, 'GHCP_GITHUB_HOSTING', problems, (v) => ['github.com', 'ghe.com'].includes(v));
  const namespace = requireValue(env, 'GHCP_NAMESPACE', problems, (v) => /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(v));
  const acr = requireValue(env, 'AZURE_CONTAINER_REGISTRY_ENDPOINT', problems, (v) => /^[a-z0-9]+\.azurecr\.[a-z.]+$/.test(v));
  const keyVault = requireValue(env, 'AZURE_KEY_VAULT_NAME', problems);
  const tenantId = requireValue(env, 'AZURE_TENANT_ID', problems);
  const clientId = requireValue(env, 'GHCP_WORKLOAD_CLIENT_ID', problems);
  const replicas = Number(requireValue(env, 'GHCP_PROXY_REPLICAS', problems, (v) => Number.isInteger(Number(v)) && Number(v) >= 2));
  const diskSku = requireValue(env, 'GHCP_DISK_SKU', problems);
  const ilbSubnet = requireValue(env, 'GHCP_ILB_SUBNET_NAME', problems);
  const ssoIlbIp = requireValue(env, 'GHCP_SSO_ILB_IP', problems, isIpv4);
  const consoleIlbIp = requireValue(env, 'GHCP_CONSOLE_ILB_IP', problems, isIpv4);
  const vnetPrefixes = list(requireValue(env, 'VNET_ADDRESS_PREFIXES', problems));
  const peSubnet = requireValue(env, 'PE_SUBNET_PREFIX', problems, isCidr);
  const appGwSubnet = requireValue(env, 'APPGW_SUBNET_PREFIX', problems, isCidr);
  const aksSubnet = requireValue(env, 'AKS_SUBNET_PREFIX', problems, isCidr);
  const podCidr = env.POD_CIDR || '';
  const mysqlFqdn = requireValue(env, 'MYSQL_FQDN', problems);
  const mysqlAdmin = requireValue(env, 'MYSQL_ADMIN_LOGIN', problems);
  const mysqlDatabase = env.MYSQL_DATABASE || 'ghcp_proxy';
  for (const cidr of vnetPrefixes) if (!isCidr(cidr)) problems.errors.push(`VNET_ADDRESS_PREFIXES: ${cidr} is not a CIDR`);
  if (!podCidr) problems.warnings.push('POD_CIDR is unknown (existing cluster without overlay?): add the pod range to GHCP_INTERNAL_ALLOWED_CIDRS if Login reaches SSO through its internal load balancer');
  else if (!isCidr(podCidr)) problems.errors.push(`POD_CIDR: ${podCidr} is not a CIDR`);

  const mysqlMode = env.GHCP_MYSQL_MODE || 'auto-migrate';
  if (!['auto-migrate', 'dba-schema'].includes(mysqlMode)) problems.errors.push('GHCP_MYSQL_MODE must be auto-migrate or dba-schema');
  const engine = env.GHCP_NETWORK_POLICY_ENGINE || 'unknown';
  const enableNetworkPolicy = truthy(env.GHCP_ENABLE_NETWORK_POLICY, !['none', 'unknown'].includes(engine));
  if (enableNetworkPolicy && engine === 'none') {
    problems.warnings.push('GHCP_ENABLE_NETWORK_POLICY=true but the cluster has no network policy engine: the policies are not enforced');
  }
  // Proxy 经 App GW 对外（publicAccess.proxy）时，App GW 的后端就是 Proxy 内部负载均衡，只放行 App GW 子网。
  const publicProxyHost = env.GHCP_PUBLIC_PROXY_HOST || '';
  const proxyIlb = truthy(env.GHCP_PROXY_ILB) || Boolean(publicProxyHost);
  const litellmSources = list(env.GHCP_PROXY_ILB_ALLOWED_CIDRS);
  for (const cidr of litellmSources) if (!isCidr(cidr) || cidr.endsWith('/0')) problems.errors.push(`GHCP_PROXY_ILB_ALLOWED_CIDRS: ${cidr} is not allowed`);
  if (truthy(env.GHCP_PROXY_ILB) && !litellmSources.length) {
    problems.errors.push('GHCP_PROXY_ILB=true needs GHCP_PROXY_ILB_ALLOWED_CIDRS (the LiteLLM node subnet)');
  }
  const proxyIlbSources = proxyIlb ? unique([...(publicProxyHost ? [env.APPGW_SUBNET_PREFIX] : []), ...litellmSources]) : [];
  const proxyIlbIp = proxyIlb ? requireValue(env, 'GHCP_PROXY_ILB_IP', problems, isIpv4) : '';

  const internalAllowed = list(env.GHCP_INTERNAL_ALLOWED_CIDRS);
  for (const cidr of internalAllowed) if (!isCidr(cidr) || cidr.endsWith('/0')) problems.errors.push(`GHCP_INTERNAL_ALLOWED_CIDRS: ${cidr} is not allowed`);
  const adminSources = internalAllowed.length ? internalAllowed : vnetPrefixes;
  // SSO：管理员、App GW 子网，以及集群内的 Login（访问负载均衡 IP 时源地址是 Pod 地址）。
  const ssoSources = unique([...(podCidr ? [podCidr] : []), aksSubnet, appGwSubnet, ...adminSources]);
  const consoleSources = unique([appGwSubnet, ...adminSources]);

  // 对外地址
  const publicSsoHost = env.GHCP_PUBLIC_SSO_HOST || '';
  const publicConsoleHost = env.GHCP_PUBLIC_CONSOLE_HOST || '';
  const appGwPrivateIp = env.APPGW_PRIVATE_IP || '';
  let ssoPublicBaseUrl = env.GHCP_SSO_PUBLIC_BASE_URL || '';
  if (!ssoPublicBaseUrl) ssoPublicBaseUrl = publicSsoHost ? `https://${publicSsoHost}` : `http://${ssoIlbIp}:7001`;
  if (!/^https?:\/\/[^/\s]+$/.test(ssoPublicBaseUrl)) problems.errors.push('GHCP_SSO_PUBLIC_BASE_URL must be scheme://host[:port] without a path');
  if (publicSsoHost && !appGwPrivateIp) problems.errors.push('GHCP_PUBLIC_SSO_HOST is set but APPGW_PRIVATE_IP is empty');
  const consolePublicBaseUrl = publicConsoleHost ? `https://${publicConsoleHost}` : '';

  const { enterprise, sso } = enterpriseConfig(env, hosting, problems);
  enterprise.SSO_PUBLIC_BASE_URL = ssoPublicBaseUrl;

  const proxyConfig = {};
  for (const [envName, key] of [['GHCP_POOL_ACCOUNT_EMAIL_DOMAIN', 'POOL_ACCOUNT_EMAIL_DOMAIN'], ['GHCP_POOL_WARMUP_MODEL', 'POOL_WARMUP_MODEL']]) {
    if (env[envName]) proxyConfig[key] = env[envName];
    else problems.pending.push(envName);
  }
  if (env.GHCP_PROXY_CONFIG_OVERRIDES) {
    let overrides;
    try { overrides = JSON.parse(env.GHCP_PROXY_CONFIG_OVERRIDES); } catch { overrides = null; }
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      problems.errors.push('GHCP_PROXY_CONFIG_OVERRIDES must be a JSON object of string values');
    } else {
      for (const [key, value] of Object.entries(overrides)) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string') problems.errors.push(`GHCP_PROXY_CONFIG_OVERRIDES.${key} must be a string`);
        else if (['API_KEY', 'MYSQL_URL', 'INTERNAL_API_TOKEN', 'SESSION_SECRET', 'MODELS_ADMIN_COPILOT_TOKEN'].includes(key)) {
          problems.errors.push(`GHCP_PROXY_CONFIG_OVERRIDES.${key}: secrets belong in Key Vault, not in a ConfigMap`);
        } else proxyConfig[key] = value;
      }
    }
  }

  // ---- 多企业 registry（可选）：default 仍由环境变量定义，文件只列新增企业 ----
  const registryInput = loadRegistryInput(env, options, problems);
  const multiEnterprise = registryInput !== undefined;
  let enterprises = [];
  if (multiEnterprise) {
    const checked = validateEnterpriseRegistry(registryInput, {
      defaultBaseUrl: hosting === 'ghe.com' ? enterprise.GITHUB_BASE_URL : 'https://github.com',
      defaultSlug: env.GHCP_ENTERPRISE_SLUG,
      defaultAccountDomain: env.GHCP_POOL_ACCOUNT_EMAIL_DOMAIN,
      defaultMaxAccounts: Number(proxyConfig.POOL_MAX_ACCOUNTS ?? 100),
      ssoPublicBaseUrl,
    });
    for (const error of checked.errors) problems.errors.push(`enterprise registry: ${error}`);
    for (const warning of checked.warnings) problems.warnings.push(`enterprise registry: ${warning}`);
    enterprises = checked.enterprises;
    proxyConfig.ENTERPRISE_REGISTRY_FILE = REGISTRY_FILE_PATH;
    sso.ENTERPRISE_REGISTRY_FILE = REGISTRY_FILE_PATH;
  }

  const approvedRequested = env.GHCP_CONFIG_APPROVED === 'true';
  const approved = approvedRequested && problems.pending.length === 0 && problems.errors.length === 0;
  if (approvedRequested && problems.pending.length) {
    problems.errors.push(`GHCP_CONFIG_APPROVED=true but these values are missing: ${problems.pending.join(', ')}`);
  }

  // ---- app overlay ----
  const appDir = path.join(outDir, 'app');
  const rel = (target) => relativeTo(appDir, target);
  const k8s = path.join(deployDir, 'kubernetes');
  const components = [rel(path.join(k8s, 'components', 'azure-aks'))];
  if (enableNetworkPolicy) components.push(rel(path.join(k8s, 'components', 'network-policy')));
  if (mysqlMode === 'dba-schema') components.push(rel(path.join(k8s, 'components', 'mysql-dba-schema')));
  if (proxyIlb) components.push(rel(path.join(k8s, 'components', 'azure-proxy-ilb')));
  const resources = [rel(path.join(k8s, 'overlays', hosting === 'ghe.com' ? 'ghe-com' : 'github-com'))];
  if (enableNetworkPolicy) resources.push('network-policy-azure.yaml');

  const spcPatch = (name) => ({
    apiVersion: 'secrets-store.csi.x-k8s.io/v1',
    kind: 'SecretProviderClass',
    metadata: { name },
    spec: { parameters: { keyvaultName: keyVault, tenantId, clientID: clientId } },
  });
  const ilbPatch = (name, ip, sources) => ({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      annotations: {
        'service.beta.kubernetes.io/azure-load-balancer-internal-subnet': ilbSubnet,
        'service.beta.kubernetes.io/azure-load-balancer-ipv4': ip,
      },
    },
    spec: { loadBalancerSourceRanges: sources },
  });
  const patches = [
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'ghcp-common' }, data: { GHCP_CONFIG_APPROVED: approved ? 'true' : 'BLOCKED' } },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'ghcp-enterprise' }, data: enterprise },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'ghcp-sso-config' }, data: sso },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'ghcp-proxy-config' }, data: proxyConfig },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'ghcp-console-config' }, data: { CONSOLE_PUBLIC_BASE_URL: consolePublicBaseUrl } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'ghcp-proxy' }, spec: { replicas } },
    {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: 'ghcp-workload', annotations: { 'azure.workload.identity/client-id': clientId, 'azure.workload.identity/tenant-id': tenantId } },
    },
    { apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: 'ghcp-azure-disk' }, parameters: { skuName: diskSku } },
    ilbPatch('ghcp-sso-ilb', ssoIlbIp, ssoSources),
    ilbPatch('ghcp-console-ilb', consoleIlbIp, consoleSources),
    ...SPC_NAMES.map(spcPatch),
  ];
  if (proxyIlb) patches.push(ilbPatch('ghcp-proxy-ilb', proxyIlbIp, proxyIlbSources));
  // registry 以 ConfigMap 只读挂载到 Proxy、SSO、Login（kustomize 生成带内容哈希的名字：registry 变化即滚动重启三者）；
  // 每个企业的机密按读取方挂载：SSO 只拿 sso.*，Proxy 只拿 modelsAdmin.copilotToken，Login 不拿任何机密。
  const enterpriseClasses = { proxy: [], sso: [] };
  if (multiEnterprise) {
    patches.push({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'ghcp-login-config' }, data: { ENTERPRISE_REGISTRY_FILE: REGISTRY_FILE_PATH } });
    const azure = { keyVault, tenantId, clientId };
    for (const service of ['proxy', 'sso']) enterpriseClasses[service] = enterpriseSecretProviderClasses(enterprises, service, azure);
    for (const service of ['proxy', 'sso', 'login']) {
      const classes = enterpriseClasses[service] ?? [];
      const volumes = [{ name: 'enterprise-registry', configMap: { name: 'ghcp-enterprise-registry', items: [{ key: REGISTRY_FILE_NAME, path: REGISTRY_FILE_NAME }] } },
        ...classes.map((spc) => ({
          name: `ent-${spc.metadata.labels['ghcp-enterprise']}`,
          csi: { driver: 'secrets-store.csi.k8s.io', readOnly: true, volumeAttributes: { secretProviderClass: spc.metadata.name } },
        }))];
      const mounts = [{ name: 'enterprise-registry', mountPath: REGISTRY_MOUNT_DIR, readOnly: true },
        ...classes.map((spc) => ({ name: `ent-${spc.metadata.labels['ghcp-enterprise']}`, mountPath: enterpriseSecretDir(spc.metadata.labels['ghcp-enterprise']), readOnly: true }))];
      patches.push({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: `ghcp-${service}` },
        spec: { template: { spec: { volumes, containers: [{ name: service, volumeMounts: mounts }] } } },
      });
    }
    if (enterpriseClasses.proxy.length + enterpriseClasses.sso.length > 0) resources.push('enterprise-secret-provider-classes.yaml');
  }
  // 这些 ConfigMap 没有内容哈希后缀，内容变化（例如打开公网开关后的 CONSOLE_PUBLIC_BASE_URL）不会让 Pod 重启，
  // 环境变量就一直是旧值。把每个服务读取的渲染值的哈希写进 Pod 模板注解，值变化时 kubectl apply 即滚动更新该服务。
  const configData = Object.fromEntries(patches.filter((p) => p.kind === 'ConfigMap').map((p) => [p.metadata.name, p.data]));
  const SERVICE_CONFIG_MAPS = {
    proxy: ['ghcp-common', 'ghcp-enterprise', 'ghcp-proxy-config'],
    sso: ['ghcp-common', 'ghcp-enterprise', 'ghcp-sso-config'],
    login: ['ghcp-common', 'ghcp-enterprise', 'ghcp-login-config'],
    console: ['ghcp-common', 'ghcp-console-config'],
  };
  for (const [service, names] of Object.entries(SERVICE_CONFIG_MAPS)) {
    const hash = createHash('sha256').update(JSON.stringify(names.map((name) => [name, configData[name] ?? null]))).digest('hex').slice(0, 16);
    patches.push({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: `ghcp-${service}` },
      spec: { template: { metadata: { annotations: { 'ghcp.azure/config-hash': hash } } } },
    });
  }
  if (publicSsoHost && appGwPrivateIp) {
    // Login 的 Chromium 不依赖 VNet 的 DNS 配置也能经 App GW 私网前端访问对外的 SSO 主机名。
    patches.push({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'ghcp-login' },
      spec: { template: { spec: { hostAliases: [{ ip: appGwPrivateIp, hostnames: [publicSsoHost] }] } } },
    });
  }

  const files = {};
  const header = '# GENERATED by deploy/azure/scripts/render-overlay.mjs. Do not edit or commit; re-run the renderer.\n';
  const kustomization = {
    apiVersion: 'kustomize.config.k8s.io/v1beta1',
    kind: 'Kustomization',
    namespace,
    resources,
    components,
    images: IMAGES.map((name) => ({ name: `REPLACE_ACR_LOGIN_SERVER/ghcp/${name}`, newName: `${acr}/ghcp/${name}` })),
    patches: patches.map((_, i) => ({ path: `patch-${String(i + 1).padStart(2, '0')}.yaml` })),
  };
  // components/network-policy 中 LiteLLM 的占位值：LiteLLM 所在 namespace 与 Pod 标签（默认 app=litellm，
  // 即 LiteLLM AKS 模板的 Pod 标签）。`test` 保证组件的规则顺序没变。
  if (enableNetworkPolicy && env.GHCP_LITELLM_NAMESPACE) {
    const [labelKey, labelValue] = (env.GHCP_LITELLM_POD_LABEL || 'app=litellm').split('=');
    if (!labelKey || !labelValue) problems.errors.push('GHCP_LITELLM_POD_LABEL must be key=value');
    kustomization.patches.push({
      target: { kind: 'NetworkPolicy', name: 'ghcp-proxy' },
      patch: json([
        { op: 'test', path: '/spec/ingress/0/from/0/namespaceSelector/matchLabels/kubernetes.io~1metadata.name', value: 'REPLACE_LITELLM_NAMESPACE' },
        { op: 'replace', path: '/spec/ingress/0/from/0/namespaceSelector/matchLabels/kubernetes.io~1metadata.name', value: env.GHCP_LITELLM_NAMESPACE },
        { op: 'test', path: '/spec/ingress/0/from/0/podSelector/matchLabels/app.kubernetes.io~1name', value: 'REPLACE_LITELLM_APP_LABEL' },
        { op: 'replace', path: '/spec/ingress/0/from/0/podSelector', value: { matchLabels: { [labelKey]: labelValue ?? '' } } },
      ]),
    });
  }
  if (multiEnterprise) {
    kustomization.configMapGenerator = [{
      name: 'ghcp-enterprise-registry',
      files: [REGISTRY_FILE_NAME],
      options: { labels: { 'app.kubernetes.io/part-of': 'ghcp' } },
    }];
    files[`app/${REGISTRY_FILE_NAME}`] = `${JSON.stringify(registryInput, null, 2)}\n`;
    const classes = [...enterpriseClasses.sso, ...enterpriseClasses.proxy];
    if (classes.length) files['app/enterprise-secret-provider-classes.yaml'] = header + classes.map((c) => JSON.stringify(c, null, 2)).join('\n---\n') + '\n';
  }
  files['app/kustomization.yaml'] = header + json(kustomization);
  patches.forEach((patch, i) => { files[`app/patch-${String(i + 1).padStart(2, '0')}.yaml`] = header + json(patch); });
  if (enableNetworkPolicy) {
    const policies = networkPolicies({ peSubnet, ssoSources, consoleSources, appGwPrivateIp: publicSsoHost ? appGwPrivateIp : '', proxyIlbSources });
    files['app/network-policy-azure.yaml'] = header + policies.map((p) => JSON.stringify(p, null, 2)).join('\n---\n') + '\n';
  }

  // ---- mysql-bootstrap overlay ----
  const bootstrapDir = path.join(outDir, 'mysql-bootstrap');
  const proxyUserHost = env.GHCP_MYSQL_PROXY_USER_HOST || '%';
  if (proxyUserHost !== '%' && !/^[0-9./]+$/.test(proxyUserHost)) problems.errors.push('GHCP_MYSQL_PROXY_USER_HOST must be % or a.b.c.d/netmask');
  const bootstrap = {
    apiVersion: 'kustomize.config.k8s.io/v1beta1',
    kind: 'Kustomization',
    namespace,
    resources: [relativeTo(bootstrapDir, path.join(azureDir, 'k8s', 'mysql-bootstrap'))],
    images: [{ name: 'docker.io/linkinchow/ghcp-proxy', newName: `${acr}/ghcp/ghcp-proxy` }],
    patches: [{ path: 'patch-config.yaml' }, { path: 'patch-spc.yaml' }, { path: 'patch-sa.yaml' }],
  };
  files['mysql-bootstrap/kustomization.yaml'] = header + json(bootstrap);
  files['mysql-bootstrap/patch-config.yaml'] = header + json({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'ghcp-mysql-bootstrap-config' },
    data: {
      MYSQL_HOST: mysqlFqdn,
      MYSQL_ADMIN_USER: mysqlAdmin,
      MYSQL_DATABASE: mysqlDatabase,
      MYSQL_PROXY_USER_HOST: proxyUserHost,
      GHCP_MYSQL_MODE: mysqlMode,
    },
  });
  files['mysql-bootstrap/patch-spc.yaml'] = header + json(spcPatch('ghcp-mysql-bootstrap-kv'));
  files['mysql-bootstrap/patch-sa.yaml'] = header + json(patches.find((p) => p.kind === 'ServiceAccount'));
  if (enableNetworkPolicy) {
    // The Job carries app.kubernetes.io/part-of=ghcp, so once the app is deployed the namespace's default deny
    // also blocks it; without this, every later postprovision (new enterprise, public access) times out on MySQL.
    bootstrap.resources.push('network-policy.yaml');
    files['mysql-bootstrap/kustomization.yaml'] = header + json(bootstrap);
    files['mysql-bootstrap/network-policy.yaml'] = header + json({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'ghcp-azure-mysql-bootstrap' },
      spec: {
        podSelector: { matchLabels: { 'app.kubernetes.io/name': 'ghcp-mysql-bootstrap' } },
        policyTypes: ['Egress'],
        egress: [{ to: [{ ipBlock: { cidr: peSubnet } }], ports: [{ protocol: 'TCP', port: 3306 }] }],
      },
    });
  }

  const summary = {
    environment: env.AZURE_ENV_NAME || '',
    namespace,
    githubHosting: hosting,
    approved,
    identity: {
      GITHUB_BASE_URL: enterprise.GITHUB_BASE_URL || '(github.com)',
      ENTERPRISE_SLUG: enterprise.ENTERPRISE_SLUG,
      ...(hosting === 'github.com' ? { ENTERPRISE_SHORTCODE: enterprise.ENTERPRISE_SHORTCODE } : {}),
      POOL_ACCOUNT_EMAIL_DOMAIN: proxyConfig.POOL_ACCOUNT_EMAIL_DOMAIN ?? 'REPLACE_POOL_ACCOUNT_EMAIL_DOMAIN',
      POOL_WARMUP_MODEL: proxyConfig.POOL_WARMUP_MODEL ?? 'REPLACE_POOL_WARMUP_MODEL',
    },
    githubSaml: {
      signOnUrl: `${ssoPublicBaseUrl}/sso`,
      issuer: `${ssoPublicBaseUrl}/metadata`,
      spEntityId: sso.SP_ENTITY_ID,
      acsUrl: sso.SP_ACS_URL,
      scimBaseUrl: sso.SCIM_BASE_URL,
    },
    ssoPublicBaseUrl,
    consolePublicBaseUrl: consolePublicBaseUrl || `(internal) http://${consoleIlbIp}:7004`,
    proxyReplicas: replicas,
    proxyInternalLoadBalancer: proxyIlb ? `http://${proxyIlbIp}:3000` : '(none)',
    proxyPublicHost: publicProxyHost || '(not published)',
    mysql: { host: mysqlFqdn, database: mysqlDatabase, mode: mysqlMode },
    networkPolicy: enableNetworkPolicy,
    loadBalancerSourceRanges: { sso: ssoSources, console: consoleSources, proxy: proxyIlbSources },
    enterprises: multiEnterprise ? enterprises.map((e) => ({
      id: e.id,
      githubBaseUrl: e.baseUrl,
      slug: e.slug,
      githubSaml: { signOnUrl: `${ssoPublicBaseUrl}/enterprises/${e.id}/sso`, issuer: `${ssoPublicBaseUrl}/enterprises/${e.id}/metadata` },
      keyVaultSecrets: e.secrets.map((s) => s.name),
    })) : '(registry not used: default only)',
  };
  const enterpriseSecrets = enterprises.flatMap((e) => e.secrets.map((s) => ({
    name: s.name, enterprise: e.id, field: s.field, service: s.service, required: s.required, generated: s.generated,
  })));
  return { files, summary, errors: problems.errors, warnings: problems.warnings, pending: problems.pending, approved, enterpriseSecrets };
}

export function writeOverlay(result, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  for (const [relative, content] of Object.entries(result.files)) {
    const file = path.join(outDir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, { encoding: 'utf8' });
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function main(argv) {
  const [command, ...rest] = argv;
  const option = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (command === 'validate-public-access') {
    const { errors, warnings } = validatePublicAccess(process.env.GHCP_PUBLIC_ACCESS);
    for (const warning of warnings) console.warn(`[public-access] warning: ${warning}`);
    for (const error of errors) console.error(`[public-access] error: ${error}`);
    return errors.length ? 1 : 0;
  }
  if (command === 'enterprise-secrets') {
    // Key Vault 机密清单（JSON），供 hooks 检查与生成；不写文件。
    const result = renderOverlay(process.env, path.join(azureDir, '.generated', 'unused'));
    const registryErrors = result.errors.filter((e) => e.startsWith('enterprise registry'));
    for (const error of registryErrors) console.error(`[render] error: ${error}`);
    if (registryErrors.length) return 1;
    console.log(JSON.stringify(result.enterpriseSecrets));
    return 0;
  }
  if (command === 'render') {
    const envName = process.env.AZURE_ENV_NAME;
    if (!envName || !/^[A-Za-z0-9-]+$/.test(envName)) {
      console.error('[render] AZURE_ENV_NAME is not set (run inside an azd hook or after azd env select)');
      return 1;
    }
    const outDir = path.resolve(option('--out') ?? path.join(azureDir, '.generated', envName));
    const result = renderOverlay(process.env, outDir);
    for (const warning of result.warnings) console.warn(`[render] warning: ${warning}`);
    for (const error of result.errors) console.error(`[render] error: ${error}`);
    if (result.errors.length) return 1;
    writeOverlay(result, outDir);
    console.log(`[render] wrote ${outDir}`);
    console.log(JSON.stringify(result.summary, null, 2));
    if (!result.approved) {
      const missing = result.pending.length ? ` Missing: ${result.pending.join(', ')}.` : '';
      console.warn(`[render] GHCP_CONFIG_APPROVED is not true: the pods stay at the start gate.${missing} Review the identity fields above ` +
        '(they cannot change once there is data), then: azd env set GHCP_CONFIG_APPROVED true');
      if (rest.includes('--require-approved')) return 3;
    }
    return 0;
  }
  console.error('usage: render-overlay.mjs render [--out <dir>] [--require-approved] | validate-public-access | enterprise-secrets');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
