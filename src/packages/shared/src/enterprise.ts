export const ENTERPRISE_SCHEMA_VERSION = 2 as const;
export const ENTERPRISE_CONTRACT_VERSION = 1 as const;
export const ENTERPRISE_CAPABILITY = 'enterprise-single-profile' as const;

export type EnterpriseId = string;
export type EnterpriseComponent = 'proxy' | 'sso' | 'login';

export interface EnterpriseProfile {
  id: EnterpriseId;
  slug: string;
  shortcode: string;
  accountDomain: string;
  revision: number;
  routes: {
    proxyInternalUrl: string;
    ssoInternalUrl: string;
    loginInternalUrl: string;
    ssoPublicUrl: string;
  };
}

export interface EnterpriseProfileDto extends EnterpriseProfile {
  capability: typeof ENTERPRISE_CAPABILITY;
  contractVersion: typeof ENTERPRISE_CONTRACT_VERSION;
  maxAccounts?: number;
}

export class EnterpriseContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'EnterpriseContractError';
  }
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new EnterpriseContractError('invalid_enterprise_profile');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new EnterpriseContractError('invalid_enterprise_profile');
  return value;
}

function trustedUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\//.test(value) || /[\s\\\x00-\x1f\x7f?#]/u.test(value)
      || /%(?:2f|5c|2e)/i.test(value) || /\/\.{1,2}(?:\/|$)/.test(value)) {
    throw new EnterpriseContractError('invalid_enterprise_route');
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
        || !url.hostname || /%(?:2f|5c|2e)/i.test(url.pathname)) throw new Error();
    return url.href.replace(/\/$/, '');
  } catch {
    throw new EnterpriseContractError('invalid_enterprise_route');
  }
}

export function enterpriseId(value: unknown): EnterpriseId {
  return text(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
}

export function requireEnterprise(value: unknown, expected: EnterpriseId, allowLegacyOmission = false): EnterpriseId {
  enterpriseId(expected);
  if (value === expected || (allowLegacyOmission && value === undefined)) return expected;
  throw new EnterpriseContractError('unsupported_enterprise');
}

export function requireEnterpriseRevision(value: unknown, expected: number): number {
  if (!Number.isSafeInteger(value) || value !== expected || expected < 1) {
    throw new EnterpriseContractError('enterprise_revision_mismatch');
  }
  return expected;
}

export function parseEnterpriseProfile(value: unknown): EnterpriseProfile {
  const row = object(value, ['id', 'slug', 'shortcode', 'accountDomain', 'revision', 'routes']);
  const id = enterpriseId(row.id);
  if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 1) {
    throw new EnterpriseContractError('invalid_enterprise_revision');
  }
  const domain = text(row.accountDomain, /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  if (domain.split('.').length < 2 || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      || !/^[a-z]{2,63}$/.test(domain.split('.').at(-1)!)) throw new EnterpriseContractError('invalid_enterprise_profile');
  const routes = object(row.routes, ['proxyInternalUrl', 'ssoInternalUrl', 'loginInternalUrl', 'ssoPublicUrl']);
  return {
    id,
    slug: text(row.slug, /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/),
    shortcode: text(row.shortcode, /^[a-z0-9]{3,8}$/),
    accountDomain: domain,
    revision: row.revision as number,
    routes: {
      proxyInternalUrl: trustedUrl(routes.proxyInternalUrl),
      ssoInternalUrl: trustedUrl(routes.ssoInternalUrl),
      loginInternalUrl: trustedUrl(routes.loginInternalUrl),
      ssoPublicUrl: trustedUrl(routes.ssoPublicUrl),
    },
  };
}

export function canonicalEnterpriseProfile(value: EnterpriseProfile): string {
  return JSON.stringify(parseEnterpriseProfile(value));
}

export function enterpriseProfileDto(profile: EnterpriseProfile, maxAccounts?: number): EnterpriseProfileDto {
  if (maxAccounts !== undefined && (!Number.isInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 10000)) {
    throw new EnterpriseContractError('invalid_enterprise_capacity');
  }
  return { ...parseEnterpriseProfile(profile), capability: ENTERPRISE_CAPABILITY,
    contractVersion: ENTERPRISE_CONTRACT_VERSION, ...(maxAccounts === undefined ? {} : { maxAccounts }) };
}
