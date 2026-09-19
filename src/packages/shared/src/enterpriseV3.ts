import { EnterpriseContractError, enterpriseId, parseEnterpriseProfile, type EnterpriseProfile } from './enterprise.js';

export const ENTERPRISE_V3_SCHEMA = 3 as const;
export const ENTERPRISE_V3_CONTRACT = 2 as const;
export const ENTERPRISE_V3_CAPABILITY = 'enterprise-isolation-legacy-pool' as const;

export type SecretReference = { env: string } | { file: string };
export interface EnterpriseProfileV3 extends EnterpriseProfile {
  maxAccounts: number;
  sso: {
    entityId: string; ssoUrl: string; loginUrl: string; logoutUrl: string;
    spEntityId: string; spAcsUrl: string; scimBaseUrl: string; githubApiBaseUrl: string;
    emailDomain: string; userPrefix: string;
    signingCertRef: SecretReference; signingKeyRef: SecretReference; sessionSecretRef: SecretReference;
    scimTokenRef?: SecretReference; seatPatRef?: SecretReference; defaultPasswordRef?: SecretReference;
  };
  login: { provider: 'custom' | 'azure'; allowedLoginUrls: string[]; selectors: Record<string, string> };
}
export interface EnterpriseRegistryV3 {
  version: 3;
  registryRevision: number;
  legacyEnterpriseId: string;
  profiles: EnterpriseProfileV3[];
}
export interface EnterpriseScope {
  enterpriseId: string;
  enterpriseRevision: number;
  registryRevision: number;
  profile: EnterpriseProfileV3;
}
export interface AuthorizationBinding {
  enterpriseId: string;
  enterpriseRevision: number;
  identity: string;
  accountIncarnation: string;
  oauthAttemptId: string;
  expectedGhLogin: string;
  expectedGithubUserId?: string;
}
export interface CreateLoginTaskV2 extends AuthorizationBinding {
  ssoUser: string;
  ssoPassword: string;
  ssoType: 'custom' | 'azure';
}
export type AuthorizationOutcome = 'active' | 'succeeded' | 'failed' | 'cancelled';

const fail = (code: string): never => { throw new EnterpriseContractError(code); };
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('enterprise_registry_invalid');
  const row = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) return fail('enterprise_registry_invalid');
  return row;
}
function str(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) return fail('enterprise_registry_invalid');
  return value;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) return fail('enterprise_registry_invalid');
  return value as number;
}
export function enterpriseUrlV3(value: unknown): string {
  const input = str(value);
  if (!/^https?:\/\//.test(input) || /[\s\\?#]/u.test(input) || /%(?:2e|2f|5c)/i.test(input) || /\/\.{1,2}(?:\/|$)/.test(input)) return fail('enterprise_route_invalid');
  let url: URL;
  try { url = new URL(input); } catch { return fail('enterprise_route_invalid'); }
  if (url.username || url.password || !url.hostname || url.search || url.hash) return fail('enterprise_route_invalid');
  return url.href.replace(/\/$/, '');
}
function secret(value: unknown): SecretReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('enterprise_secret_reference_invalid');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 1) return fail('enterprise_secret_reference_invalid');
  if (typeof row.env === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(row.env)) return { env: row.env };
  if (typeof row.file === 'string' && /^(?:[a-zA-Z]:[\\/]|\/)/.test(row.file) && !/[\x00-\x1f\x7f]/u.test(row.file)) return { file: row.file };
  return fail('enterprise_secret_reference_invalid');
}
export function parseEnterpriseProfileV3(value: unknown): EnterpriseProfileV3 {
  const row = record(value, ['id','slug','shortcode','accountDomain','revision','routes','maxAccounts','sso','login']);
  const base = parseEnterpriseProfile(Object.fromEntries(['id','slug','shortcode','accountDomain','revision','routes'].map(key => [key, row[key]])));
  const s = record(row.sso, ['entityId','ssoUrl','loginUrl','logoutUrl','spEntityId','spAcsUrl','scimBaseUrl','githubApiBaseUrl','emailDomain','userPrefix','signingCertRef','signingKeyRef','sessionSecretRef'], ['scimTokenRef','seatPatRef','defaultPasswordRef']);
  const login = record(row.login, ['provider','allowedLoginUrls','selectors']);
  if (login.provider !== 'custom' && login.provider !== 'azure') return fail('enterprise_login_provider_invalid');
  if (!Array.isArray(login.allowedLoginUrls) || login.allowedLoginUrls.length < 1 || login.allowedLoginUrls.length > 16) return fail('enterprise_login_urls_invalid');
  const allowedLoginUrls = login.allowedLoginUrls.map(enterpriseUrlV3);
  if (new Set(allowedLoginUrls).size !== allowedLoginUrls.length) return fail('enterprise_login_urls_invalid');
  if (!login.selectors || typeof login.selectors !== 'object' || Array.isArray(login.selectors) || Object.keys(login.selectors).length > 32) return fail('enterprise_selectors_invalid');
  const selectors: Record<string,string> = {};
  for (const [key, val] of Object.entries(login.selectors)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(key)) return fail('enterprise_selectors_invalid');
    selectors[key] = str(val, 512);
  }
  const domain = str(s.emailDomain, 253);
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(domain) || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return fail('enterprise_sso_domain_invalid');
  const prefix = str(s.userPrefix, 32);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(prefix)) return fail('enterprise_user_prefix_invalid');
  const sso = {
    entityId: str(s.entityId), ssoUrl: enterpriseUrlV3(s.ssoUrl), loginUrl: enterpriseUrlV3(s.loginUrl), logoutUrl: enterpriseUrlV3(s.logoutUrl),
    spEntityId: str(s.spEntityId), spAcsUrl: enterpriseUrlV3(s.spAcsUrl), scimBaseUrl: enterpriseUrlV3(s.scimBaseUrl), githubApiBaseUrl: enterpriseUrlV3(s.githubApiBaseUrl),
    emailDomain: domain, userPrefix: prefix, signingCertRef: secret(s.signingCertRef), signingKeyRef: secret(s.signingKeyRef), sessionSecretRef: secret(s.sessionSecretRef),
    ...(s.scimTokenRef === undefined ? {} : { scimTokenRef: secret(s.scimTokenRef) }),
    ...(s.seatPatRef === undefined ? {} : { seatPatRef: secret(s.seatPatRef) }),
    ...(s.defaultPasswordRef === undefined ? {} : { defaultPasswordRef: secret(s.defaultPasswordRef) }),
  };
  if (!allowedLoginUrls.includes(sso.loginUrl)) return fail('enterprise_login_urls_invalid');
  return { ...base, maxAccounts: integer(row.maxAccounts,10000), sso,
    login: { provider: login.provider, allowedLoginUrls, selectors: Object.fromEntries(Object.entries(selectors).sort(([a],[b]) => a.localeCompare(b))) } };
}
export function parseEnterpriseRegistryV3(value: unknown): EnterpriseRegistryV3 {
  const row = record(value, ['version','registryRevision','legacyEnterpriseId','profiles']);
  if (row.version !== 3 || !Array.isArray(row.profiles) || row.profiles.length < 1 || row.profiles.length > 100) return fail('enterprise_registry_invalid');
  const profiles = row.profiles.map(parseEnterpriseProfileV3).sort((a,b) => a.id.localeCompare(b.id));
  const legacyEnterpriseId = enterpriseId(row.legacyEnterpriseId);
  if (!profiles.some(profile => profile.id === legacyEnterpriseId)) return fail('enterprise_legacy_missing');
  for (const key of ['id','slug','shortcode'] as const) if (new Set(profiles.map(profile => profile[key])).size !== profiles.length) return fail('enterprise_registry_duplicate');
  if (profiles.reduce((sum,profile) => sum+profile.maxAccounts,0)>10000) return fail('enterprise_registry_capacity');
  const publicUrls = profiles.flatMap(profile => [profile.sso.ssoUrl, profile.sso.loginUrl, profile.sso.logoutUrl]);
  if (new Set(publicUrls).size !== publicUrls.length) return fail('enterprise_registry_route_collision');
  for (const profile of profiles) {
    const root = new URL(profile.routes.ssoPublicUrl).origin;
    for (const [kind,value] of [['sso',profile.sso.ssoUrl],['login',profile.sso.loginUrl],['logout',profile.sso.logoutUrl]] as const) {
      const url = new URL(value);
      const expectedPath = profile.id === legacyEnterpriseId ? `/${kind}` : `/profiles/${profile.id}/${kind}`;
      if (url.origin !== root || url.pathname !== expectedPath) return fail('enterprise_public_route_mismatch');
    }
  }
  return { version:3, registryRevision:integer(row.registryRevision), legacyEnterpriseId, profiles };
}
export function canonicalEnterpriseRegistryV3(value: EnterpriseRegistryV3): string { return JSON.stringify(parseEnterpriseRegistryV3(value)); }
export function canonicalEnterpriseIdentityRegistryV3(value: EnterpriseRegistryV3): string {
  const registry = parseEnterpriseRegistryV3(value);
  return JSON.stringify({ ...registry, profiles: registry.profiles.map(({ maxAccounts: _capacity, ...profile }) => profile) });
}
export function resolveEnterpriseScope(registry: EnterpriseRegistryV3, id?: unknown): EnterpriseScope {
  const selected = id === undefined ? registry.legacyEnterpriseId : enterpriseId(id);
  const profile = registry.profiles.find(item => item.id === selected);
  if (!profile) return fail('enterprise_not_found');
  return Object.freeze({ enterpriseId: profile.id, enterpriseRevision: profile.revision, registryRevision: registry.registryRevision, profile });
}
export function parseAuthorizationBinding(value: unknown): AuthorizationBinding {
  const row = record(value, ['enterpriseId','enterpriseRevision','identity','accountIncarnation','oauthAttemptId','expectedGhLogin'], ['expectedGithubUserId']);
  const identity = str(row.identity,255), expectedGhLogin = str(row.expectedGhLogin,100);
  if (identity.trim() !== identity || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(expectedGhLogin)) return fail('authorization_binding_invalid');
  if (row.expectedGithubUserId !== undefined && (typeof row.expectedGithubUserId !== 'string' || !/^[1-9]\d{0,19}$/.test(row.expectedGithubUserId))) return fail('authorization_binding_invalid');
  return { enterpriseId:enterpriseId(row.enterpriseId), enterpriseRevision:integer(row.enterpriseRevision), identity,
    accountIncarnation:enterpriseId(row.accountIncarnation), oauthAttemptId:enterpriseId(row.oauthAttemptId), expectedGhLogin,
    ...(row.expectedGithubUserId === undefined ? {} : { expectedGithubUserId: row.expectedGithubUserId as string }) };
}
export function bindingKey(value: AuthorizationBinding): string { return JSON.stringify(parseAuthorizationBinding(value)); }
