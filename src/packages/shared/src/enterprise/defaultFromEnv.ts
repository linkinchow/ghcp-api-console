import { resolve } from 'node:path';
import { DEFAULT_GITHUB_BASE_URL, parseGithubBaseUrl } from '../github.js';
import type { ParseRegistryOptions, RegistryService } from './registry.js';
import {
  LOGIN_SELECTOR_KEYS,
  normalizeField,
  type LoginSelectorKey,
  type LoginSelectors,
  type ProfileFields,
} from './registryFields.js';

export type ServiceEnv = Readonly<Record<string, string | undefined>>;

export interface EnvDefault {
  /** Fields set by environment variables; a `default` registry entry must agree with each of them. */
  readonly fields: ProfileFields;
  /** The environment variable behind each field path, for conflict messages. */
  readonly sources: ReadonlyMap<string, string>;
  readonly warnings: readonly string[];
}

export interface DefaultFromEnvOptions {
  /** `github.baseUrl` of the registry's `default` entry; it decides GHE.com rules before env values. */
  registryBaseUrl?: string;
}

interface EnvMapping {
  readonly env: string;
  readonly field: string;
  /** Converts the trimmed, non-empty variable value; the value itself by default. */
  readonly value?: (raw: string) => unknown;
}

/** Built-in values of today's service configs, applied only where neither the registry nor the env sets a field. */
const BASELINE_SHORTCODE = 'octo';
const BASELINE_SLUG = 'acme';
const BASELINE_CERT_DIR = '../../certs';
const BASELINE_MOCK_GITHUB_BASE_URL = 'http://localhost:8002';
const BASELINE_OAUTH_CLIENT_ID = 'Ov23li8tweQw6odWQebz';
const SHORTCODE_VARIABLE = 'ENTERPRISE_SHORTCODE';
const BASE_URL_FIELD = 'github.baseUrl';

const PROXY_MAPPINGS: readonly EnvMapping[] = [
  { env: 'GITHUB_BASE_URL', field: 'github.baseUrl' },
  { env: 'GITHUB_API_BASE_URL', field: 'github.apiBaseUrl' },
  { env: 'COPILOT_API_BASE_URL', field: 'github.copilotApiBaseUrl' },
  { env: SHORTCODE_VARIABLE, field: 'github.shortcode' },
  { env: 'MODELS_ADMIN_GITHUB_LOGIN', field: 'modelsAdmin.githubLogin' },
  { env: 'MODELS_ADMIN_GITHUB_USER_ID', field: 'modelsAdmin.githubUserId' },
  // The file variable comes first: the baseline prefers it, so the token variable is then ignored with a warning.
  { env: 'MODELS_ADMIN_COPILOT_TOKEN_FILE', field: 'modelsAdmin.copilotToken', value: (file) => ({ file }) },
  envRef('MODELS_ADMIN_COPILOT_TOKEN', 'modelsAdmin.copilotToken'),
];

/** Pool variables only count in caller-lease mode, as in `userPool/config.ts`. */
const POOL_MAPPINGS: readonly EnvMapping[] = [
  { env: 'POOL_ACCOUNT_EMAIL_DOMAIN', field: 'pool.accountDomain' },
  { env: 'POOL_MAX_ACCOUNTS', field: 'pool.initialMaxAccounts', value: parseCount },
];

const SSO_MAPPINGS: readonly EnvMapping[] = [
  { env: 'GITHUB_BASE_URL', field: 'github.baseUrl' },
  { env: 'GITHUB_API_BASE_URL', field: 'github.apiBaseUrl' },
  { env: 'ENTERPRISE_SLUG', field: 'github.slug' },
  { env: SHORTCODE_VARIABLE, field: 'github.shortcode' },
  { env: 'SP_ENTITY_ID', field: 'sso.spEntityId' },
  { env: 'SP_ACS_URL', field: 'sso.spAcsUrl' },
  { env: 'SCIM_BASE_URL', field: 'sso.scimBaseUrl' },
  envRef('SCIM_TOKEN', 'sso.scimToken'),
  envRef('GITHUB_COPILOT_SEAT_PAT', 'sso.seatPat'),
  envRef('SESSION_SECRET', 'sso.sessionSecret'),
  envRef('SSO_DEFAULT_USER_PASSWORD', 'sso.defaultUserPassword'),
  { env: 'CERT_DIR', field: 'sso.signingCert', value: (dir) => certFiles(dir).cert },
  { env: 'CERT_DIR', field: 'sso.signingKey', value: (dir) => certFiles(dir).key },
];

const LOGIN_MAPPINGS: readonly EnvMapping[] = [
  { env: 'GITHUB_BASE_URL', field: 'github.baseUrl' },
  { env: 'ENTERPRISE_SLUG', field: 'github.slug' },
  { env: 'GITHUB_OAUTH_CLIENT_ID', field: 'github.oauthClientId' },
  { env: 'SSO_URL', field: 'login.ssoLoginUrl' },
  ...LOGIN_SELECTOR_KEYS.map((key): EnvMapping => ({ env: selectorVariable(key), field: `login.selectors.${key}` })),
];

/**
 * Maps one service's environment to `default` enterprise fields (design §3.5). Only variables that are set
 * and non-empty count. On GHE.com, ENTERPRISE_SHORTCODE is ignored with one warning, as in the baseline.
 */
export function defaultFromEnv(
  service: RegistryService,
  env: ServiceEnv,
  options: DefaultFromEnvOptions = {},
): EnvDefault {
  const fields: ProfileFields = new Map();
  const sources = new Map<string, string>();
  const warnings: string[] = [];
  for (const mapping of serviceMappings(service, env)) {
    const raw = readVariable(env, mapping.env);
    if (raw === undefined) continue;
    const owner = sources.get(mapping.field);
    if (owner !== undefined) {
      warnings.push(`${mapping.env} is ignored because ${owner} is set.`);
    } else if (mapping.env === SHORTCODE_VARIABLE && isGheCom(options.registryBaseUrl ?? fields.get(BASE_URL_FIELD))) {
      warnings.push(`${SHORTCODE_VARIABLE} is ignored on GHE.com.`);
    } else {
      fields.set(mapping.field, normalizeField(mapping.field, (mapping.value ?? String)(raw), mapping.env));
      sources.set(mapping.field, mapping.env);
    }
  }
  return { fields, sources, warnings };
}

/**
 * Today's built-in defaults for `default`, computed from the merged fields. They fill fields that neither the
 * registry nor the environment sets and never conflict with either.
 */
export function fallbackFields(service: RegistryService, env: ServiceEnv, fields: ProfileFields): ProfileFields {
  const fallbacks: ProfileFields = new Map([['github.baseUrl', DEFAULT_GITHUB_BASE_URL]]);
  if (service !== 'login' && !isGheCom(fields.get('github.baseUrl') ?? DEFAULT_GITHUB_BASE_URL)) {
    fallbacks.set('github.shortcode', BASELINE_SHORTCODE);
  }
  if (service === 'sso') addSsoFallbacks(fallbacks, env, fields);
  return fallbacks;
}

/** Service-wide settings that also apply to enterprises other than `default`. */
export function registryOptionsFromEnv(service: RegistryService, env: ServiceEnv): ParseRegistryOptions {
  if (service === 'proxy') return { service, poolMode: isPoolMode(env) };
  if (service === 'sso') return { service };
  return {
    service,
    ssoUrl: readVariable(env, 'SSO_URL'),
    oauthClientId: readVariable(env, 'GITHUB_OAUTH_CLIENT_ID') ?? BASELINE_OAUTH_CLIENT_ID,
    selectors: selectorsFromEnv(env),
  };
}

export function isPoolMode(env: ServiceEnv): boolean {
  return env.ACCOUNT_ROUTING_MODE === 'caller-lease';
}

/** `deviceCodeInput` → `AUTH_DEVICE_CODE_INPUT_SELECTOR`. */
export function selectorVariable(key: LoginSelectorKey): string {
  return `AUTH_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}_SELECTOR`;
}

function serviceMappings(service: RegistryService, env: ServiceEnv): readonly EnvMapping[] {
  if (service === 'proxy') return isPoolMode(env) ? [...PROXY_MAPPINGS, ...POOL_MAPPINGS] : PROXY_MAPPINGS;
  return service === 'sso' ? SSO_MAPPINGS : LOGIN_MAPPINGS;
}

function addSsoFallbacks(fallbacks: ProfileFields, env: ServiceEnv, fields: ProfileFields): void {
  const certs = certFiles(BASELINE_CERT_DIR);
  fallbacks.set('github.slug', BASELINE_SLUG);
  fallbacks.set('sso.sessionSecret', { env: 'SESSION_SECRET' });
  fallbacks.set('sso.signingCert', certs.cert);
  fallbacks.set('sso.signingKey', certs.key);
  // Development fallback of the baseline SSO: ACS and SCIM point at the mock GitHub unless configured.
  const mockBaseUrl = env.MOCK_GITHUB_BASE_URL ?? BASELINE_MOCK_GITHUB_BASE_URL;
  if (!mockBaseUrl.trim()) return;
  const slug = fields.get('github.slug') ?? BASELINE_SLUG;
  const label = 'MOCK_GITHUB_BASE_URL';
  const mock = String(normalizeField('sso.spAcsUrl', mockBaseUrl, label));
  fallbacks.set('sso.spAcsUrl', normalizeField('sso.spAcsUrl', `${mock}/enterprises/${slug}/saml/consume`, label));
  fallbacks.set('sso.scimBaseUrl', normalizeField('sso.scimBaseUrl', `${mock}/scim/v2/enterprises/${slug}`, label));
}

function selectorsFromEnv(env: ServiceEnv): LoginSelectors {
  const selectors: Partial<Record<LoginSelectorKey, string>> = {};
  for (const key of LOGIN_SELECTOR_KEYS) {
    const variable = selectorVariable(key);
    const selector = readVariable(env, variable);
    if (selector !== undefined) selectors[key] = String(normalizeField(`login.selectors.${key}`, selector, variable));
  }
  return selectors;
}

/** Compose passes unset variables as empty strings, so blank values count as unset. */
function readVariable(env: ServiceEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

function isGheCom(baseUrl: unknown): boolean {
  return typeof baseUrl === 'string' && parseGithubBaseUrl(baseUrl).isGheCom;
}

function envRef(name: string, field: string): EnvMapping {
  return { env: name, field, value: () => ({ env: name }) };
}

/** The baseline resolves CERT_DIR against the working directory; secret files must be absolute. */
function certFiles(dir: string): { cert: { file: string }; key: { file: string } } {
  return { cert: { file: resolve(dir, 'idp-cert.pem') }, key: { file: resolve(dir, 'idp-key.pem') } };
}

/** Digits become a number; anything else stays a string so the field check reports it. */
function parseCount(raw: string): unknown {
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}
