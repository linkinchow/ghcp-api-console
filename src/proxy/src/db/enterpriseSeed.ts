import {
  DEFAULT_ENTERPRISE_ID,
  loadRegistry,
  profileFingerprint,
  type EnterpriseId,
  type EnterpriseProfile,
} from '@ghcp/shared';

/** What storage needs to create or verify an enterprise row in `proxy_enterprises` (design §4.2). */
export interface EnterpriseSeed {
  id: EnterpriseId;
  /** sha256 of `{ id, githubBaseUrl, shortcode, accountDomain }`. */
  fingerprint: string;
  /** Initial cap. An upgraded pool keeps its persisted `user_pool_settings.max_accounts` instead. */
  maxAccounts: number;
}

/** The `default` enterprise as the Proxy's registry (or, without one, its environment) describes it. */
export function defaultEnterpriseSeed(env: NodeJS.ProcessEnv = process.env): EnterpriseSeed {
  const registry = loadRegistry({ service: 'proxy', env });
  const profile = registry.enterprises.find((enterprise) => enterprise.id === DEFAULT_ENTERPRISE_ID);
  if (!profile) throw new Error('The enterprise registry has no default enterprise.');
  return enterpriseSeed(profile);
}

export function enterpriseSeed(profile: EnterpriseProfile): EnterpriseSeed {
  return {
    id: profile.id,
    fingerprint: profileFingerprint(profile),
    maxAccounts: profile.pool.initialMaxAccounts,
  };
}
