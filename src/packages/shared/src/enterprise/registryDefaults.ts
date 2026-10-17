import { parseGithubBaseUrl } from '../github.js';
import { defaultApiBaseUrls } from './githubEndpoints.js';
import type {
  EnterpriseBlocker,
  EnterpriseProfile,
  GithubProfile,
  LoginProfile,
  ModelsAdminProfile,
  ParseRegistryOptions,
  PoolProfile,
  ProfileEntry,
  SsoProfile,
} from './registry.js';
import {
  invalidRegistryField,
  LOGIN_SELECTOR_KEYS,
  readProvider,
  SSO_SECRET_KEYS,
  type LoginSelectorKey,
  type LoginSelectors,
  type ProfileFields,
  type SecretRef,
} from './registryFields.js';
import { DEFAULT_ENTERPRISE_ID } from './scope.js';
import { parseTrustedUrl, sameTrustedUrl, type TrustedUrl } from './trustedUrl.js';

type ProfileWithoutBlockers = Omit<EnterpriseProfile, 'blockers'>;

/** `POOL_MAX_ACCOUNTS`'s baseline default carries over to `default`; new enterprises start small. */
const DEFAULT_ENTERPRISE_MAX_ACCOUNTS = 100;
const ENTERPRISE_MAX_ACCOUNTS = 10;

/** Fills the design §3.3 defaults, applies per-profile GitHub rules (§3.6) and lists the service's blockers. */
export function resolveProfile(entry: ProfileEntry, options: ParseRegistryOptions): EnterpriseProfile {
  const github = resolveGithub(entry, options);
  const profile: ProfileWithoutBlockers = definedOnly({
    id: entry.id,
    displayName: text(entry.fields, 'displayName') ?? entry.id,
    github,
    sso: resolveSso(entry.fields, github),
    login: resolveLogin(entry, options),
    pool: resolvePool(entry),
    modelsAdmin: resolveModelsAdmin(entry.fields),
  });
  const blockers = requiredFields(profile, options)
    .filter((field) => valueAt(profile, field) === undefined)
    .map((field): EnterpriseBlocker => ({ code: 'enterprise_field_missing', field }));
  return { ...profile, blockers };
}

function resolveGithub(entry: ProfileEntry, options: ParseRegistryOptions): GithubProfile {
  const rawBaseUrl = text(entry.fields, 'github.baseUrl');
  if (rawBaseUrl === undefined) throw invalidRegistryField(`${entry.id}.github.baseUrl`, 'is required');
  const { baseUrl, host, isGheCom } = parseGithubBaseUrl(rawBaseUrl);
  const defaults = defaultApiBaseUrls({ baseUrl, isGheCom });
  const github: GithubProfile = definedOnly({
    baseUrl,
    host,
    isGheCom,
    apiBaseUrl: text(entry.fields, 'github.apiBaseUrl') ?? defaults.api,
    copilotApiBaseUrl: text(entry.fields, 'github.copilotApiBaseUrl') ?? defaults.copilotApi,
    slug: text(entry.fields, 'github.slug'),
    shortcode: resolveShortcode(entry, isGheCom),
    oauthClientId: text(entry.fields, 'github.oauthClientId') ?? options.oauthClientId,
  });
  if (isGheCom) assertSameGheTenant(entry.id, github);
  return github;
}

function resolveShortcode(entry: ProfileEntry, isGheCom: boolean): string | undefined {
  const shortcode = text(entry.fields, 'github.shortcode');
  const label = `${entry.id}.github.shortcode`;
  if (isGheCom && shortcode) throw invalidRegistryField(label, 'must be empty on GHE.com');
  if (!isGheCom && shortcode === '') throw invalidRegistryField(label, 'must match ^[a-z0-9]{3,8}$ on github.com');
  return isGheCom ? '' : shortcode;
}

function assertSameGheTenant(id: string, github: GithubProfile): void {
  for (const field of ['apiBaseUrl', 'copilotApiBaseUrl'] as const) {
    const host = new URL(github[field]).hostname;
    if (host !== github.host && !host.endsWith(`.${github.host}`)) {
      throw invalidRegistryField(`${id}.github.${field}`, 'must be under the same <sub>.ghe.com as github.baseUrl');
    }
  }
}

function resolveSso(fields: ProfileFields, github: GithubProfile): SsoProfile {
  const slugPath = github.slug === undefined ? undefined : `/enterprises/${encodeURIComponent(github.slug)}`;
  const secrets = Object.fromEntries(SSO_SECRET_KEYS.map((key) => [key, secret(fields, `sso.${key}`)]));
  return definedOnly({
    spEntityId: text(fields, 'sso.spEntityId') ?? (slugPath && `${github.baseUrl}${slugPath}`),
    spAcsUrl: text(fields, 'sso.spAcsUrl') ?? (slugPath && `${github.baseUrl}${slugPath}/saml/consume`),
    scimBaseUrl: text(fields, 'sso.scimBaseUrl') ?? (slugPath && `${github.apiBaseUrl}/scim/v2${slugPath}`),
    emailDomain: text(fields, 'sso.emailDomain'),
    userPrefix: text(fields, 'sso.userPrefix'),
    ...secrets,
  });
}

function resolveLogin(entry: ProfileEntry, options: ParseRegistryOptions): LoginProfile {
  const ssoLoginUrl = text(entry.fields, 'login.ssoLoginUrl') ?? defaultSsoLoginUrl(entry.id, options.ssoUrl);
  const allowedLoginUrls = list(entry.fields, 'login.allowedLoginUrls') ?? (ssoLoginUrl ? [ssoLoginUrl] : []);
  if (ssoLoginUrl && !allowedLoginUrls.some((allowed) => sameUrlText(allowed, ssoLoginUrl))) {
    throw invalidRegistryField(`${entry.id}.login.allowedLoginUrls`, 'must include login.ssoLoginUrl');
  }
  return definedOnly({
    ssoProvider: readProvider(text(entry.fields, 'login.ssoProvider') ?? 'custom'),
    ssoLoginUrl,
    allowedLoginUrls,
    selectors: resolveSelectors(entry.fields, options.selectors ?? {}),
  });
}

/** `SSO_URL` itself for `default`; `<SSO_URL origin>/enterprises/<id>/login` for the others. */
function defaultSsoLoginUrl(id: string, ssoUrl: string | undefined): string | undefined {
  if (!ssoUrl) return undefined;
  const url = parseSsoUrl(ssoUrl);
  return id === DEFAULT_ENTERPRISE_ID ? url.href : `${url.origin}/enterprises/${id}/login`;
}

function parseSsoUrl(raw: string): TrustedUrl {
  try {
    return parseTrustedUrl(raw.trim());
  } catch (error) {
    throw invalidRegistryField('SSO_URL', error instanceof Error ? error.message : 'is invalid');
  }
}

function resolveSelectors(fields: ProfileFields, defaults: LoginSelectors): LoginSelectors {
  const selectors: Partial<Record<LoginSelectorKey, string>> = {};
  for (const key of LOGIN_SELECTOR_KEYS) {
    const selector = text(fields, `login.selectors.${key}`) ?? defaults[key];
    if (selector !== undefined) selectors[key] = selector;
  }
  return selectors;
}

function resolvePool(entry: ProfileEntry): PoolProfile {
  const fallback = entry.id === DEFAULT_ENTERPRISE_ID ? DEFAULT_ENTERPRISE_MAX_ACCOUNTS : ENTERPRISE_MAX_ACCOUNTS;
  const initialMaxAccounts = entry.fields.get('pool.initialMaxAccounts');
  return definedOnly({
    accountDomain: text(entry.fields, 'pool.accountDomain'),
    initialMaxAccounts: typeof initialMaxAccounts === 'number' ? initialMaxAccounts : fallback,
  });
}

function resolveModelsAdmin(fields: ProfileFields): ModelsAdminProfile | undefined {
  const modelsAdmin = definedOnly({
    githubLogin: text(fields, 'modelsAdmin.githubLogin'),
    githubUserId: text(fields, 'modelsAdmin.githubUserId'),
    copilotToken: secret(fields, 'modelsAdmin.copilotToken'),
  });
  return Object.keys(modelsAdmin).length > 0 ? modelsAdmin : undefined;
}

/** Fields each service needs before the enterprise is ready (design §3.3); missing ones are blockers. */
function requiredFields(profile: ProfileWithoutBlockers, options: ParseRegistryOptions): string[] {
  const { service, poolMode } = options;
  const { isGheCom } = profile.github;
  const required: string[] = [];
  if (service === 'sso') required.push('github.slug', 'sso.signingCert', 'sso.signingKey', 'sso.sessionSecret');
  if (service === 'login' && isGheCom) required.push('github.slug');
  if ((service === 'proxy' || service === 'sso') && !isGheCom) required.push('github.shortcode');
  if (service === 'proxy' && poolMode) required.push('pool.accountDomain');
  return required;
}

function valueAt(source: object, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), source);
}

function sameUrlText(left: string, right: string): boolean {
  return sameTrustedUrl(parseTrustedUrl(left), parseTrustedUrl(right));
}

function text(fields: ProfileFields, path: string): string | undefined {
  const value = fields.get(path);
  return typeof value === 'string' ? value : undefined;
}

function list(fields: ProfileFields, path: string): string[] | undefined {
  const value = fields.get(path);
  return Array.isArray(value) ? value : undefined;
}

function secret(fields: ProfileFields, path: string): SecretRef | undefined {
  const value = fields.get(path);
  return typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Drops undefined properties so optional fields are absent rather than present-but-undefined. */
function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
