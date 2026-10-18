import { isAbsolute } from 'node:path';
import { parseGithubBaseUrl } from '../github.js';
import { parseTrustedUrl } from './trustedUrl.js';

export type SsoProvider = 'custom' | 'azure';
/** A reference to a secret; registries never carry secret values inline (design §3.4). */
export type SecretRef = { readonly env: string } | { readonly file: string };
export type FieldValue = string | number | SecretRef | string[];
/** Normalized fields of one enterprise keyed by path, such as `github.baseUrl`. */
export type ProfileFields = Map<string, FieldValue>;

export type RegistryErrorCode = 'enterprise_registry_invalid' | 'enterprise_env_conflict';

/** Startup configuration error. Messages name field paths and environment variables, never values. */
export class EnterpriseRegistryError extends Error {
  constructor(readonly code: RegistryErrorCode, readonly field: string, message: string) {
    super(message);
    this.name = 'EnterpriseRegistryError';
  }
}

export const LOGIN_SELECTOR_KEYS = [
  'deviceCodeInput',
  'deviceCodeSubmit',
  'githubLoginInput',
  'githubLoginSubmit',
  'githubSsoSubmit',
  'ssoUsernameInput',
  'ssoPasswordInput',
  'ssoSubmit',
  'azureUsernameInput',
  'azureNextSubmit',
  'azurePasswordInput',
  'azureSignInSubmit',
  'azureStaySignedInYes',
  'azureStaySignedInNo',
  'githubAuthorizeSubmit',
] as const;
export type LoginSelectorKey = (typeof LOGIN_SELECTOR_KEYS)[number];
export type LoginSelectors = Readonly<Partial<Record<LoginSelectorKey, string>>>;

export const SSO_SECRET_KEYS = [
  'signingCert',
  'signingKey',
  'sessionSecret',
  'scimToken',
  'seatPat',
  'defaultUserPassword',
] as const;
/** Pool account names available to all enterprises together (the Proxy's NAME_CAPACITY). */
export const ACCOUNT_NAME_CAPACITY = 10_000;
export const MAX_ALLOWED_LOGIN_URLS = 16;

type FieldKind =
  | 'text' | 'githubBaseUrl' | 'origin' | 'url' | 'urlList' | 'slug' | 'shortcode' | 'domain' | 'count'
  | 'provider' | 'secret';

const FIELD_KINDS: ReadonlyMap<string, FieldKind> = new Map<string, FieldKind>([
  ['displayName', 'text'],
  ['github.baseUrl', 'githubBaseUrl'],
  // API roots may sit behind a gateway path; r4 accepted any GITHUB_API_BASE_URL / COPILOT_API_BASE_URL.
  ['github.apiBaseUrl', 'url'],
  ['github.copilotApiBaseUrl', 'url'],
  ['github.slug', 'slug'],
  ['github.shortcode', 'shortcode'],
  ['github.oauthClientId', 'text'],
  ['sso.spEntityId', 'url'],
  ['sso.spAcsUrl', 'url'],
  ['sso.scimBaseUrl', 'url'],
  ['sso.emailDomain', 'domain'],
  ['sso.userPrefix', 'text'],
  ...SSO_SECRET_KEYS.map((key): [string, FieldKind] => [`sso.${key}`, 'secret']),
  ['login.ssoProvider', 'provider'],
  ['login.ssoLoginUrl', 'url'],
  ['login.allowedLoginUrls', 'urlList'],
  ...LOGIN_SELECTOR_KEYS.map((key): [string, FieldKind] => [`login.selectors.${key}`, 'text']),
  ['pool.accountDomain', 'domain'],
  ['pool.initialMaxAccounts', 'count'],
  ['modelsAdmin.githubLogin', 'text'],
  ['modelsAdmin.githubUserId', 'text'],
  ['modelsAdmin.copilotToken', 'secret'],
]);

const MAX_TEXT_LENGTH = 1024;
const MAX_PATH_LENGTH = 4096;
const SHORTCODE = /^[a-z0-9]{3,8}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const SECRET_ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TOP_LEVEL_DOMAIN = /^[a-z]{2,63}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const NORMALIZERS: Record<FieldKind, (value: unknown) => FieldValue> = {
  text: readText,
  githubBaseUrl: (value) => parseGithubBaseUrl(readOrigin(value)).baseUrl,
  origin: readOrigin,
  url: (value) => parseTrustedUrl(readString(value)).href,
  urlList: readUrlList,
  slug: readSlug,
  shortcode: readShortcode,
  domain: readDomain,
  count: readCount,
  provider: readProvider,
  secret: readSecretRef,
};

/** Validates and normalizes one field value; errors name `label` (a field path or env variable). */
export function normalizeField(path: string, value: unknown, label: string): FieldValue {
  const kind = FIELD_KINDS.get(path);
  if (!kind) throw invalidRegistryField(label, 'is not a known field');
  try {
    return NORMALIZERS[kind](value);
  } catch (error) {
    throw invalidRegistryField(label, error instanceof Error ? error.message : 'is invalid');
  }
}

export function readProvider(value: unknown): SsoProvider {
  if (value !== 'custom' && value !== 'azure') throw new Error('must be "custom" or "azure"');
  return value;
}

export function invalidRegistryField(field: string, reason: string): EnterpriseRegistryError {
  return new EnterpriseRegistryError('enterprise_registry_invalid', field, `${field} ${reason}.`);
}

function readString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('must be a string');
  return value.trim();
}

function readText(value: unknown): string {
  const result = readString(value);
  if (!result) throw new Error('must not be empty');
  if (result.length > MAX_TEXT_LENGTH || CONTROL_CHARS.test(result)) {
    throw new Error(`must be a single line of at most ${MAX_TEXT_LENGTH} characters`);
  }
  return result;
}

function readOrigin(value: unknown): string {
  const url = parseTrustedUrl(readString(value));
  if (url.segments.length > 0) throw new Error('must be an origin without a path');
  return url.origin;
}

function readUrlList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ALLOWED_LOGIN_URLS) {
    throw new Error(`must be an array of 1 to ${MAX_ALLOWED_LOGIN_URLS} URLs`);
  }
  return value.map((item, index) => {
    try {
      return parseTrustedUrl(readString(item)).href;
    } catch (error) {
      throw new Error(`[${index}] ${error instanceof Error ? error.message : 'is invalid'}`);
    }
  });
}

function readSlug(value: unknown): string {
  const slug = readText(value);
  if (!SLUG.test(slug)) throw new Error('must be a GitHub enterprise slug');
  return slug;
}

/** '' is kept so GHE.com profiles can state it; github.com rejects it when the profile is resolved. */
/** Lower-cased like the baseline SSO did when it built logins, so `ACME` keeps working. */
function readShortcode(value: unknown): string {
  const shortcode = readString(value).toLowerCase();
  if (shortcode && !SHORTCODE.test(shortcode)) throw new Error('must match ^[a-z0-9]{3,8}$');
  return shortcode;
}

function readDomain(value: unknown): string {
  const domain = readText(value).toLowerCase();
  const labels = domain.split('.');
  const valid = domain.length <= 253
    && labels.length >= 2
    && labels.every((label) => DOMAIN_LABEL.test(label))
    && TOP_LEVEL_DOMAIN.test(labels[labels.length - 1]);
  if (!valid) throw new Error('must be an email domain');
  return domain;
}

function readCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > ACCOUNT_NAME_CAPACITY) {
    throw new Error(`must be an integer between 1 and ${ACCOUNT_NAME_CAPACITY}`);
  }
  return value;
}

function readSecretRef(value: unknown): SecretRef {
  const ref = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
  const keys = Object.keys(ref);
  if (keys.length === 1 && 'env' in ref && typeof ref.env === 'string' && SECRET_ENV_NAME.test(ref.env)) {
    return { env: ref.env };
  }
  if (keys.length === 1 && 'file' in ref && isSecretFilePath(ref.file)) return { file: ref.file };
  throw new Error('must be {"env": "NAME"} or {"file": "/absolute/path"}');
}

function isSecretFilePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PATH_LENGTH && !value.includes('\0') && isAbsolute(value);
}
