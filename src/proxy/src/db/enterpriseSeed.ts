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

/** Every enterprise of the Proxy's registry (or, without one, its environment), `default` first. */
export function enterpriseSeeds(env: NodeJS.ProcessEnv = process.env): EnterpriseSeed[] {
  const registry = loadRegistry({ service: 'proxy', env });
  const seeds = registry.enterprises.map(enterpriseSeed);
  const defaultSeed = seeds.find(isDefaultSeed);
  if (!defaultSeed) throw new Error('The enterprise registry has no default enterprise.');
  return [defaultSeed, ...seeds.filter((seed) => !isDefaultSeed(seed))];
}

/** The `default` enterprise alone; single-enterprise tests and the base migrations use it. */
export function defaultEnterpriseSeed(env: NodeJS.ProcessEnv = process.env): EnterpriseSeed {
  return enterpriseSeeds(env)[0];
}

/** The `default` seed of a registry seed list; storage constructors require one. */
export function requireDefaultSeed(seeds: readonly EnterpriseSeed[]): EnterpriseSeed {
  const seed = seeds.find(isDefaultSeed);
  if (!seed) throw new Error('The enterprise seeds have no default enterprise.');
  return seed;
}

function isDefaultSeed(seed: EnterpriseSeed): boolean {
  return seed.id === DEFAULT_ENTERPRISE_ID;
}

export function enterpriseSeed(profile: EnterpriseProfile): EnterpriseSeed {
  return {
    id: profile.id,
    fingerprint: profileFingerprint(profile),
    maxAccounts: profile.pool.initialMaxAccounts,
  };
}
