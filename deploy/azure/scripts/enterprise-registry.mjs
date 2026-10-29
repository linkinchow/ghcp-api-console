// 多企业 registry（docs/multi-enterprise-registry.md）在 Azure 部署中的约定与校验。不访问网络。
//
// 依据代码（src/packages/shared/src/enterprise/）：
// - registryFields.ts：secret 字段只有 7 个——sso.signingCert / signingKey / sessionSecret / scimToken / seatPat /
//   defaultUserPassword，以及 modelsAdmin.copilotToken；引用格式 {"env": NAME} 或 {"file": "/绝对路径"}。
// - secrets.ts：{file} 必须是绝对路径；读取时才解析，缺失只影响该企业（成为阻塞项），不影响服务启动。
// - 读取方：SSO 读 sso.*（sso/src/enterprises.ts ssoSecret / ssoSessionSecret），Proxy 只读
//   modelsAdmin.copilotToken（proxy/src/enterprises.ts modelsAdminToken），Login 不读任何 secret。
// - scope.ts / registry.ts：企业 ID 匹配 ^[a-z][a-z0-9-]{0,30}[a-z0-9]$；registry 最多 32 个企业（含 default）。
// - registryDefaults.ts：SSO 必需 github.slug、sso.signingCert、signingKey、sessionSecret；github.com 的 Proxy / SSO
//   必需 github.shortcode；GHE.com 的 shortcode 必须为空、Login 必需 github.slug、apiBaseUrl / copilotApiBaseUrl
//   必须在同一个 <sub>.ghe.com 下；账号池模式的 Proxy 必需 pool.accountDomain。
// - sso/src/users/passwordPolicy.ts：账号池用户需要 sso.defaultUserPassword（至少 16 个字符）。
//
// Azure 约定（本部署额外施加，见 deploy/azure/README.md 第 8.6 节）：
// - default 企业仍由环境变量定义（文档推荐做法），机密名保持 ghcp-scim-token 等不变；registry 文件里不能有 default。
// - 其他企业的 secret 一律用 {file}，路径固定为 /run/secrets/<id>/<文件名>，内容来自 Key Vault 机密 ghcp-ent-<id>-<后缀>；
//   不允许 {env}（每个企业的机密不经过环境变量）。

export const REGISTRY_MOUNT_DIR = '/etc/ghcp-registry';
export const REGISTRY_FILE_NAME = 'enterprise-registry.json';
export const REGISTRY_FILE_PATH = `${REGISTRY_MOUNT_DIR}/${REGISTRY_FILE_NAME}`;
export const SECRETS_ROOT = '/run/secrets';

const ENTERPRISE_ID = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
const KEY_VAULT_SECRET_NAME = /^[A-Za-z0-9-]{1,127}$/;
const MAX_ENTERPRISES = 32;
const ACCOUNT_NAME_CAPACITY = 10_000;
const SHORTCODE = /^[a-z0-9]{3,8}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/i;

/** 每个 secret 字段：容器内文件名、Key Vault 机密名后缀、读取它的服务、是否必需、是否由部署生成。 */
export const ENTERPRISE_SECRETS = Object.freeze([
  { field: 'sso.signingCert', file: 'idp-cert.pem', suffix: 'saml-idp-cert', service: 'sso', required: true, generated: false },
  { field: 'sso.signingKey', file: 'idp-key.pem', suffix: 'saml-idp-key', service: 'sso', required: true, generated: false },
  { field: 'sso.sessionSecret', file: 'session-secret', suffix: 'session-secret', service: 'sso', required: true, generated: true },
  { field: 'sso.scimToken', file: 'scim-token', suffix: 'scim-token', service: 'sso', required: true, generated: false },
  { field: 'sso.seatPat', file: 'seat-pat', suffix: 'copilot-seat-pat', service: 'sso', required: true, generated: false },
  { field: 'sso.defaultUserPassword', file: 'default-user-password', suffix: 'sso-default-user-password', service: 'sso', required: true, generated: true },
  { field: 'modelsAdmin.copilotToken', file: 'models-admin-copilot-token', suffix: 'models-admin-copilot-token', service: 'proxy', required: false, generated: false },
]);

/** registryFields.ts 的 FIELD_KINDS（不含 secret）；azure.test.mjs 校验与源码一致。 */
export const REGISTRY_TEXT_FIELDS = Object.freeze([
  'displayName', 'github.baseUrl', 'github.apiBaseUrl', 'github.copilotApiBaseUrl', 'github.slug', 'github.shortcode',
  'github.oauthClientId', 'sso.spEntityId', 'sso.spAcsUrl', 'sso.scimBaseUrl', 'sso.emailDomain', 'sso.userPrefix',
  'login.ssoProvider', 'login.ssoLoginUrl', 'login.allowedLoginUrls', 'pool.accountDomain', 'pool.initialMaxAccounts',
  'modelsAdmin.githubLogin', 'modelsAdmin.githubUserId',
]);
export const LOGIN_SELECTOR_KEYS = Object.freeze([
  'deviceCodeInput', 'deviceCodeSubmit', 'githubLoginInput', 'githubLoginSubmit', 'githubSsoSubmit', 'ssoUsernameInput',
  'ssoPasswordInput', 'ssoSubmit', 'azureUsernameInput', 'azureNextSubmit', 'azurePasswordInput', 'azureSignInSubmit',
  'azureStaySignedInYes', 'azureStaySignedInNo', 'githubAuthorizeSubmit',
]);
const SECTIONS = new Set(['github', 'sso', 'login', 'login.selectors', 'pool', 'modelsAdmin']);
const KNOWN_FIELDS = new Set([...REGISTRY_TEXT_FIELDS, ...ENTERPRISE_SECRETS.map((s) => s.field),
  ...LOGIN_SELECTOR_KEYS.map((k) => `login.selectors.${k}`)]);

export const enterpriseSecretName = (id, secret) => `ghcp-ent-${id}-${secret.suffix}`;
export const enterpriseSecretPath = (id, secret) => `${SECRETS_ROOT}/${id}/${secret.file}`;
export const enterpriseSecretDir = (id) => `${SECRETS_ROOT}/${id}`;

function flatten(object, prefix, id, fields, errors) {
  for (const [key, value] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (path === 'id') continue;
    if (SECTIONS.has(path)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) errors.push(`${id}.${path} must be a JSON object`);
      else flatten(value, path, id, fields, errors);
    } else if (!KNOWN_FIELDS.has(path)) {
      errors.push(`${id}.${path} is not a known registry field`);
    } else {
      fields.set(path, value);
    }
  }
}

function parseBaseUrl(raw) {
  try {
    const url = new URL(String(raw).trim());
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) return undefined;
    const host = url.hostname.toLowerCase();
    if (host === 'github.com') return { baseUrl: url.origin, host, isGheCom: false };
    if (/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/.test(host)) return { baseUrl: url.origin, host, isGheCom: true };
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * Validates an operator registry for this deployment. `context`: { defaultBaseUrl, defaultSlug, defaultAccountDomain,
 * defaultMaxAccounts, ssoPublicBaseUrl }. Returns { errors, warnings, enterprises: [{ id, isGheCom, slug, secrets }] }
 * where `secrets` lists { field, path, name, service, required, generated } for every referenced secret.
 */
export function validateEnterpriseRegistry(registry, context = {}) {
  const errors = [];
  const warnings = [];
  const enterprises = [];
  if (typeof registry !== 'object' || registry === null || Array.isArray(registry)) {
    return { errors: ['the enterprise registry must be a JSON object'], warnings, enterprises };
  }
  for (const key of Object.keys(registry)) if (key !== 'version' && key !== 'enterprises') errors.push(`registry.${key} is not a known registry field`);
  if (registry.version !== 1) errors.push('registry.version must be 1');
  const list = registry.enterprises;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ENTERPRISES - 1) {
    errors.push(`registry.enterprises must list 1 to ${MAX_ENTERPRISES - 1} enterprises (default is defined by the environment)`);
    return { errors, warnings, enterprises };
  }
  const ids = new Set();
  const slugs = new Map();
  const domains = new Map();
  const secretNames = new Map();
  if (context.defaultSlug && context.defaultBaseUrl) slugs.set(`${context.defaultBaseUrl} ${context.defaultSlug.toLowerCase()}`, 'default');
  if (context.defaultAccountDomain) domains.set(context.defaultAccountDomain.toLowerCase(), 'default');
  let capacity = Number(context.defaultMaxAccounts ?? 100);

  list.forEach((entry, index) => {
    const label = `enterprises[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) { errors.push(`${label} must be a JSON object`); return; }
    const id = entry.id;
    if (typeof id !== 'string' || !ENTERPRISE_ID.test(id)) { errors.push(`${label}.id must match ^[a-z][a-z0-9-]{0,30}[a-z0-9]$`); return; }
    if (id === 'default') {
      errors.push('default must not be in the registry: it is defined by the environment and the existing Key Vault secrets (ghcp-scim-token, ...)');
      return;
    }
    if (ids.has(id)) { errors.push(`${id}: duplicate enterprise id`); return; }
    ids.add(id);
    const fields = new Map();
    flatten(entry, '', id, fields, errors);

    const base = parseBaseUrl(fields.get('github.baseUrl') ?? '');
    if (!base) { errors.push(`${id}.github.baseUrl is required: https://github.com or https://<subdomain>.ghe.com`); return; }
    const slug = fields.get('github.slug');
    const shortcode = fields.get('github.shortcode');
    if (typeof slug !== 'string' || !SLUG.test(slug)) errors.push(`${id}.github.slug is required (the enterprise slug; SSO${base.isGheCom ? ' and Login' : ''} need it)`);
    if (base.isGheCom) {
      if (shortcode) errors.push(`${id}.github.shortcode must be empty on GHE.com`);
      for (const field of ['github.apiBaseUrl', 'github.copilotApiBaseUrl']) {
        const value = fields.get(field);
        if (value === undefined) continue;
        let host = '';
        try { host = new URL(String(value)).hostname.toLowerCase(); } catch { /* invalid */ }
        if (host !== base.host && !host.endsWith(`.${base.host}`)) errors.push(`${id}.${field} must be under the same ${base.host} as github.baseUrl`);
      }
    } else if (typeof shortcode !== 'string' || !SHORTCODE.test(shortcode.toLowerCase())) {
      errors.push(`${id}.github.shortcode is required on github.com and must match ^[a-z0-9]{3,8}$`);
    }
    if (typeof slug === 'string') {
      const key = `${base.baseUrl} ${slug.toLowerCase()}`;
      if (slugs.has(key)) errors.push(`${id}.github.slug duplicates ${slugs.get(key)}.github.slug`);
      slugs.set(key, id);
    }
    const domain = fields.get('pool.accountDomain');
    if (typeof domain !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,63}$/i.test(domain)) {
      errors.push(`${id}.pool.accountDomain is required in caller-lease mode (an email domain)`);
    } else {
      if (domains.has(domain.toLowerCase())) errors.push(`${id}.pool.accountDomain duplicates ${domains.get(domain.toLowerCase())}.pool.accountDomain`);
      domains.set(domain.toLowerCase(), id);
    }
    const max = fields.get('pool.initialMaxAccounts');
    if (max !== undefined && !(Number.isSafeInteger(max) && max >= 1 && max <= ACCOUNT_NAME_CAPACITY)) {
      errors.push(`${id}.pool.initialMaxAccounts must be an integer between 1 and ${ACCOUNT_NAME_CAPACITY}`);
    }
    capacity += typeof max === 'number' ? max : 10;
    const provider = fields.get('login.ssoProvider');
    if (provider !== undefined && provider !== 'custom' && provider !== 'azure') errors.push(`${id}.login.ssoProvider must be "custom" or "azure"`);
    const loginUrl = fields.get('login.ssoLoginUrl');
    if (loginUrl !== undefined && context.ssoPublicBaseUrl) {
      const expected = `${context.ssoPublicBaseUrl}/enterprises/${id}/login`;
      if (String(loginUrl).replace(/[?#].*$/s, '') !== expected) {
        errors.push(`${id}.login.ssoLoginUrl must be ${expected} (or omit it: Login derives it from SSO_PUBLIC_BASE_URL)`);
      }
    }

    const secrets = [];
    for (const secret of ENTERPRISE_SECRETS) {
      const ref = fields.get(secret.field);
      const expectedPath = enterpriseSecretPath(id, secret);
      if (ref === undefined) {
        if (secret.required) errors.push(`${id}.${secret.field} is required: {"file": "${expectedPath}"}`);
        continue;
      }
      if (typeof ref !== 'object' || ref === null || Array.isArray(ref) || Object.keys(ref).length !== 1) {
        errors.push(`${id}.${secret.field} must be {"file": "${expectedPath}"}`);
        continue;
      }
      if ('env' in ref) {
        errors.push(`${id}.${secret.field}: {"env": ...} is not supported in this deployment; use {"file": "${expectedPath}"}`);
        continue;
      }
      if (ref.file !== expectedPath) {
        errors.push(`${id}.${secret.field} must reference ${expectedPath} (Key Vault secret ${enterpriseSecretName(id, secret)}), not ${ref.file}`);
        continue;
      }
      const name = enterpriseSecretName(id, secret);
      if (!KEY_VAULT_SECRET_NAME.test(name)) { errors.push(`${id}: Key Vault secret name ${name} is invalid`); continue; }
      if (secretNames.has(name)) errors.push(`${id}: Key Vault secret name ${name} collides with ${secretNames.get(name)}`);
      secretNames.set(name, `${id}.${secret.field}`);
      secrets.push({ field: secret.field, path: expectedPath, file: secret.file, name, service: secret.service, required: secret.required, generated: secret.generated });
    }
    if (fields.has('modelsAdmin.copilotToken') && !fields.has('modelsAdmin.githubLogin') && !fields.has('modelsAdmin.githubUserId')) {
      warnings.push(`${id}.modelsAdmin.copilotToken is set without modelsAdmin.githubLogin / githubUserId`);
    }
    enterprises.push({ id, isGheCom: base.isGheCom, baseUrl: base.baseUrl, slug, secrets });
  });
  if (capacity > ACCOUNT_NAME_CAPACITY) errors.push(`pool.initialMaxAccounts must not sum to more than ${ACCOUNT_NAME_CAPACITY} across enterprises`);
  return { errors, warnings, enterprises };
}

/** One SecretProviderClass per (service, enterprise): only the files that service reads, as plain files (no sync). */
export function enterpriseSecretProviderClasses(enterprises, service, { keyVault, tenantId, clientId }) {
  return enterprises
    .map((enterprise) => ({ enterprise, secrets: enterprise.secrets.filter((s) => s.service === service) }))
    .filter(({ secrets }) => secrets.length > 0)
    .map(({ enterprise, secrets }) => ({
      apiVersion: 'secrets-store.csi.x-k8s.io/v1',
      kind: 'SecretProviderClass',
      metadata: {
        name: `ghcp-${service}-ent-${enterprise.id}`,
        labels: { 'app.kubernetes.io/name': `ghcp-${service}`, 'app.kubernetes.io/part-of': 'ghcp', 'ghcp-enterprise': enterprise.id },
      },
      spec: {
        provider: 'azure',
        parameters: {
          usePodIdentity: 'false',
          clientID: clientId,
          keyvaultName: keyVault,
          tenantId,
          cloudName: '',
          objects: `array:\n${secrets.map((s) => `  - |\n    objectName: ${s.name}\n    objectType: secret\n    objectAlias: ${s.file}\n`).join('')}`,
        },
      },
    }));
}
