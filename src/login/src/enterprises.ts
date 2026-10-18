import {
  DEFAULT_ENTERPRISE_ID,
  githubEndpoints,
  HttpApiError,
  loadRegistry,
  resolveGithubDeployment,
  type EnterpriseId,
  type EnterpriseProfile,
  type GithubDeployment,
  type GithubEndpoints,
  type Registry,
  type SsoProvider,
} from '@ghcp/shared';

/** One enterprise as the Login service runs it: its frozen registry profile plus derived GitHub endpoints. */
export interface LoginEnterprise {
  readonly id: EnterpriseId;
  readonly profile: EnterpriseProfile;
  /** Undefined while a required field is missing (GHE.com without `github.slug`); see `blockers`. */
  readonly endpoints: Readonly<GithubEndpoints> | undefined;
  readonly deployment: Readonly<GithubDeployment> | undefined;
  /** Readiness blockers (design §3.8) as `<code>:<field>`; tasks are refused while any remain. */
  readonly blockers: readonly string[];
}

/** An enterprise without blockers, so every value a login run needs is present. */
export interface ReadyLoginEnterprise extends LoginEnterprise {
  readonly endpoints: Readonly<GithubEndpoints>;
  readonly deployment: Readonly<GithubDeployment>;
  readonly oauthClientId: string;
}

let enterprises: ReadonlyMap<EnterpriseId, LoginEnterprise> | undefined;
let registryWarnings: readonly string[] = [];

/** Loads the registry once (design §3.7); later calls return the same frozen enterprises. */
export function loginEnterprises(): readonly LoginEnterprise[] {
  return [...loadedEnterprises().values()];
}

export function findLoginEnterprise(id: string): LoginEnterprise | undefined {
  return loadedEnterprises().get(id as EnterpriseId);
}

export function defaultLoginEnterprise(): LoginEnterprise {
  const enterprise = findLoginEnterprise(DEFAULT_ENTERPRISE_ID);
  if (!enterprise) throw new Error('The enterprise registry has no default enterprise.');
  return enterprise;
}

export function loginRegistryWarnings(): readonly string[] {
  loadedEnterprises();
  return registryWarnings;
}

/** The enterprise ready to run a login, or 503 `enterprise_not_ready` naming its blockers. */
export function readyLoginEnterprise(enterprise: LoginEnterprise): ReadyLoginEnterprise {
  const { endpoints, deployment } = enterprise;
  const oauthClientId = enterprise.profile.github.oauthClientId;
  if (enterprise.blockers.length > 0 || !endpoints || !deployment || !oauthClientId) {
    const message = `Enterprise "${enterprise.id}" is not ready: ${enterprise.blockers.join(', ')}.`;
    throw new HttpApiError(503, 'enterprise_not_ready', message);
  }
  return { ...enterprise, endpoints, deployment, oauthClientId };
}

/**
 * The SSO provider of one task. A profile without `login.ssoProvider` lets each task choose, as r4 did
 * (omitted means `custom`); a profile that sets it only accepts that provider (design §5.7).
 */
export function resolveSsoType(enterprise: LoginEnterprise, requested: unknown): SsoProvider {
  const provider = enterprise.profile.login.ssoProvider;
  if (provider === undefined) return readRequestedSsoType(requested);
  if (requested === undefined || requested === provider) return provider;
  const message = `ssoType must be omitted or equal this enterprise's SSO provider (${provider}).`;
  throw new HttpApiError(400, 'sso_type_mismatch', message);
}

function readRequestedSsoType(requested: unknown): SsoProvider {
  if (requested === undefined) return 'custom';
  if (requested === 'custom' || requested === 'azure') return requested;
  throw new HttpApiError(400, 'invalid_login_task', 'ssoType must be custom or azure.');
}

/** Test hook: builds the enterprises from an explicit registry instead of the environment. */
export function setLoginEnterprisesForTesting(registry: Registry | undefined): void {
  enterprises = registry ? buildEnterprises(registry) : undefined;
  registryWarnings = registry?.warnings ?? [];
}

function loadedEnterprises(): ReadonlyMap<EnterpriseId, LoginEnterprise> {
  if (!enterprises) {
    const registry = loadRegistry({ service: 'login', env: process.env });
    enterprises = buildEnterprises(registry);
    registryWarnings = registry.warnings;
  }
  return enterprises;
}

function buildEnterprises(registry: Registry): ReadonlyMap<EnterpriseId, LoginEnterprise> {
  return new Map(registry.enterprises.map((profile) => [profile.id, buildEnterprise(profile)]));
}

function buildEnterprise(profile: EnterpriseProfile): LoginEnterprise {
  const blockers = loginBlockers(profile);
  const derivable = !profile.github.isGheCom || profile.github.slug !== undefined;
  return Object.freeze({
    id: profile.id,
    profile,
    endpoints: derivable ? githubEndpoints(profile) : undefined,
    deployment: derivable ? Object.freeze(deploymentOf(profile)) : undefined,
    blockers: Object.freeze(blockers),
  });
}

function deploymentOf(profile: EnterpriseProfile): GithubDeployment {
  return resolveGithubDeployment(profile.github.baseUrl, profile.github.slug);
}

/** Registry blockers plus what a login run needs: a client ID and, for explicitly custom SSO, its login page. */
function loginBlockers(profile: EnterpriseProfile): string[] {
  const blockers = profile.blockers.map((blocker) => `${blocker.code}:${blocker.field}`);
  if (!profile.github.oauthClientId) blockers.push('enterprise_field_missing:github.oauthClientId');
  if (profile.login.ssoProvider === 'custom' && !profile.login.ssoLoginUrl) {
    blockers.push('enterprise_field_missing:login.ssoLoginUrl');
  }
  return blockers;
}
