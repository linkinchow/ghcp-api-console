import { deepFreeze } from '../deepFreeze.js';
import { resolveProfile } from './registryDefaults.js';
import {
  ACCOUNT_NAME_CAPACITY,
  invalidRegistryField,
  normalizeField,
  type LoginSelectors,
  type ProfileFields,
  type SecretRef,
  type SsoProvider,
} from './registryFields.js';
import { isEnterpriseId, type EnterpriseId } from './scope.js';

export type RegistryService = 'proxy' | 'sso' | 'login';

export interface ProfileEntry {
  readonly id: EnterpriseId;
  readonly fields: ProfileFields;
}

export interface GithubProfile {
  readonly baseUrl: string;
  readonly host: string;
  readonly isGheCom: boolean;
  readonly apiBaseUrl: string;
  readonly copilotApiBaseUrl: string;
  readonly slug?: string;
  /** EMU login suffix; always '' on GHE.com and undefined when a github.com profile does not set it. */
  readonly shortcode?: string;
  readonly oauthClientId?: string;
}

export interface SsoProfile {
  readonly spEntityId?: string;
  readonly spAcsUrl?: string;
  readonly scimBaseUrl?: string;
  readonly emailDomain?: string;
  readonly userPrefix?: string;
  readonly signingCert?: SecretRef;
  readonly signingKey?: SecretRef;
  readonly sessionSecret?: SecretRef;
  readonly scimToken?: SecretRef;
  readonly seatPat?: SecretRef;
  readonly defaultUserPassword?: SecretRef;
}

export interface LoginProfile {
  readonly ssoProvider: SsoProvider;
  readonly ssoLoginUrl?: string;
  readonly allowedLoginUrls: readonly string[];
  readonly selectors: LoginSelectors;
}

export interface PoolProfile {
  readonly accountDomain?: string;
  readonly initialMaxAccounts: number;
}

export interface ModelsAdminProfile {
  readonly githubLogin?: string;
  readonly githubUserId?: string;
  readonly copilotToken?: SecretRef;
}

export interface EnterpriseBlocker {
  readonly code: 'enterprise_field_missing';
  readonly field: string;
}

export interface EnterpriseProfile {
  readonly id: EnterpriseId;
  readonly displayName: string;
  readonly github: GithubProfile;
  readonly sso: SsoProfile;
  readonly login: LoginProfile;
  readonly pool: PoolProfile;
  readonly modelsAdmin?: ModelsAdminProfile;
  /** Required fields the loading service lacks; a profile with blockers is not ready. */
  readonly blockers: readonly EnterpriseBlocker[];
}

export interface Registry {
  readonly version: 1;
  readonly enterprises: readonly EnterpriseProfile[];
  readonly warnings: readonly string[];
}

export interface ParseRegistryOptions {
  /** Service whose required fields become blockers; without one, no blockers are reported. */
  service?: RegistryService;
  /** Proxy caller-lease mode, where `pool.accountDomain` is required. */
  poolMode?: boolean;
  /** `SSO_URL`: the default login URL of `default`, and the origin of other enterprises' login URLs. */
  ssoUrl?: string;
  /** Global OAuth client ID used when a profile does not set `github.oauthClientId`. */
  oauthClientId?: string;
  /** Global selectors used for keys a profile does not set. */
  selectors?: LoginSelectors;
}

export const REGISTRY_VERSION = 1;
export const MAX_ENTERPRISES = 32;

const SECTIONS = new Set(['github', 'sso', 'login', 'login.selectors', 'pool', 'modelsAdmin']);

/** Parses and validates a registry (JSON text or parsed value) without any environment; the result is frozen. */
export function parseRegistry(json: unknown, options: ParseRegistryOptions = {}): Registry {
  const value = typeof json === 'string' ? parseJsonText(json) : json;
  return deepFreeze(resolveRegistry(readRegistryEntries(value), options));
}

/** Structural validation: top-level shape, known fields only, and each field's own format. */
export function readRegistryEntries(json: unknown): ProfileEntry[] {
  const root = requireRecord(json, 'registry');
  const unknownKey = Object.keys(root).find((key) => key !== 'version' && key !== 'enterprises');
  if (unknownKey !== undefined) throw invalidRegistryField(unknownKey, 'is not a known registry field');
  if (root.version !== REGISTRY_VERSION) throw invalidRegistryField('version', `must be ${REGISTRY_VERSION}`);
  const { enterprises } = root;
  if (!Array.isArray(enterprises) || enterprises.length < 1 || enterprises.length > MAX_ENTERPRISES) {
    throw invalidRegistryField('enterprises', `must be an array of 1 to ${MAX_ENTERPRISES} enterprises`);
  }
  return enterprises.map((entry, index) => readEntry(entry, `enterprises[${index}]`));
}

/** Applies profile defaults and rules, then the registry-wide rules of design §3.6. */
export function resolveRegistry(entries: readonly ProfileEntry[], options: ParseRegistryOptions = {}): Registry {
  if (entries.length < 1 || entries.length > MAX_ENTERPRISES) {
    throw invalidRegistryField('enterprises', `must contain 1 to ${MAX_ENTERPRISES} enterprises`);
  }
  const enterprises = entries.map((entry) => resolveProfile(entry, options));
  assertUnique(enterprises, 'id', (profile) => profile.id);
  assertUnique(enterprises, 'github.slug', slugKey);
  assertUnique(enterprises, 'pool.accountDomain', (profile) => profile.pool.accountDomain);
  assertUnique(enterprises, 'login.ssoLoginUrl', (profile) => profile.login.ssoLoginUrl);
  assertCapacity(enterprises);
  return { version: REGISTRY_VERSION, enterprises, warnings: [] };
}

function readEntry(raw: unknown, label: string): ProfileEntry {
  const entry = requireRecord(raw, label);
  if (!isEnterpriseId(entry.id)) {
    throw invalidRegistryField(`${label}.id`, 'must match ^[a-z][a-z0-9-]{0,30}[a-z0-9]$');
  }
  const fields: ProfileFields = new Map();
  collectFields(entry, '', entry.id, fields);
  return { id: entry.id, fields };
}

function collectFields(source: Record<string, unknown>, prefix: string, id: string, fields: ProfileFields): void {
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (path === 'id') continue;
    if (SECTIONS.has(path)) {
      collectFields(requireRecord(value, `${id}.${path}`), path, id, fields);
    } else {
      fields.set(path, normalizeField(path, value, `${id}.${path}`));
    }
  }
}

/** One slug per GitHub instance; slugs compare case-insensitively. */
function slugKey(profile: EnterpriseProfile): string | undefined {
  const { slug, baseUrl } = profile.github;
  return slug === undefined ? undefined : `${baseUrl} ${slug.toLowerCase()}`;
}

function assertUnique(
  enterprises: readonly EnterpriseProfile[],
  field: string,
  keyOf: (profile: EnterpriseProfile) => string | undefined,
): void {
  const owners = new Map<string, string>();
  for (const profile of enterprises) {
    const key = keyOf(profile);
    if (key === undefined) continue;
    const owner = owners.get(key);
    if (owner !== undefined) throw invalidRegistryField(`${profile.id}.${field}`, `duplicates ${owner}.${field}`);
    owners.set(key, profile.id);
  }
}

function assertCapacity(enterprises: readonly EnterpriseProfile[]): void {
  const total = enterprises.reduce((sum, profile) => sum + profile.pool.initialMaxAccounts, 0);
  if (total > ACCOUNT_NAME_CAPACITY) {
    const reason = `must not sum to more than ${ACCOUNT_NAME_CAPACITY} across enterprises`;
    throw invalidRegistryField('pool.initialMaxAccounts', reason);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidRegistryField(label, 'must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function parseJsonText(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw invalidRegistryField('registry', 'must be valid JSON');
  }
}
