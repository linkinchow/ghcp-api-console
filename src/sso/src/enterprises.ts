import { basename, dirname, join } from 'node:path';
import {
  DEFAULT_ENTERPRISE_ID,
  githubEndpoints,
  loadRegistry,
  readSecret,
  type EnterpriseId,
  type EnterpriseProfile,
  type GithubEndpoints,
  type Registry,
  type SecretRef,
} from '@ghcp/shared';
import { config } from './config.js';

/** One enterprise as the SSO service runs it: its frozen registry profile plus derived values. */
export interface SsoEnterprise {
  readonly id: EnterpriseId;
  readonly profile: EnterpriseProfile;
  readonly endpoints: Readonly<GithubEndpoints>;
  /** Public path prefix of the SAML routes: '' for `default` (root paths), `/enterprises/<id>` otherwise. */
  readonly publicPath: string;
  /** `default` keeps SSO_USER_EVENTS_LOG; other enterprises write `<dir>/<id>/<basename>`. */
  readonly eventLogPath: string;
}

export type SsoSecretField =
  | 'signingCert'
  | 'signingKey'
  | 'sessionSecret'
  | 'scimToken'
  | 'seatPat'
  | 'defaultUserPassword';

/** The baseline development fallback; only the `default` enterprise may use it. */
const DEVELOPMENT_SESSION_SECRET = 'dev-secret-change-me';

let enterprises: ReadonlyMap<EnterpriseId, SsoEnterprise> | undefined;
let registryWarnings: readonly string[] = [];

/** Loads the registry once (design §3.7); later calls return the same frozen enterprises. */
export function ssoEnterprises(): readonly SsoEnterprise[] {
  return [...loadedEnterprises().values()];
}

export function findSsoEnterprise(id: string): SsoEnterprise | undefined {
  return loadedEnterprises().get(id as EnterpriseId);
}

export function defaultSsoEnterprise(): SsoEnterprise {
  const enterprise = findSsoEnterprise(DEFAULT_ENTERPRISE_ID);
  if (!enterprise) throw new Error('The enterprise registry has no default enterprise.');
  return enterprise;
}

export function ssoRegistryWarnings(): readonly string[] {
  loadedEnterprises();
  return registryWarnings;
}

/** Reads a secret of the enterprise; `undefined` when the profile has no reference for it. */
export function ssoSecret(enterprise: SsoEnterprise, field: SsoSecretField): string | undefined {
  const ref: SecretRef | undefined = enterprise.profile.sso[field];
  if (!ref) return undefined;
  return readSecret(ref, { field: `${enterprise.id}.sso.${field}`, env: process.env });
}

/** The cookie-session signing key; `default` keeps the baseline development fallback when SESSION_SECRET is unset. */
export function ssoSessionSecret(enterprise: SsoEnterprise): string {
  const ref = enterprise.profile.sso.sessionSecret;
  const isBaselineRef = ref !== undefined && 'env' in ref && ref.env === 'SESSION_SECRET';
  if (enterprise.id === DEFAULT_ENTERPRISE_ID && isBaselineRef && !process.env.SESSION_SECRET) {
    return DEVELOPMENT_SESSION_SECRET;
  }
  const secret = ssoSecret(enterprise, 'sessionSecret');
  if (!secret) throw new Error(`${enterprise.id}.sso.sessionSecret is not configured.`);
  return secret;
}

/** Test hook: builds the enterprises from an explicit registry instead of the environment. */
export function setSsoEnterprisesForTesting(registry: Registry | undefined): void {
  enterprises = registry ? buildEnterprises(registry) : undefined;
  registryWarnings = registry?.warnings ?? [];
}

function loadedEnterprises(): ReadonlyMap<EnterpriseId, SsoEnterprise> {
  if (!enterprises) {
    const registry = loadRegistry({ service: 'sso', env: process.env });
    enterprises = buildEnterprises(registry);
    registryWarnings = registry.warnings;
  }
  return enterprises;
}

function buildEnterprises(registry: Registry): ReadonlyMap<EnterpriseId, SsoEnterprise> {
  return new Map(registry.enterprises.map((profile) => [profile.id, buildEnterprise(profile)]));
}

function buildEnterprise(profile: EnterpriseProfile): SsoEnterprise {
  const isDefault = profile.id === DEFAULT_ENTERPRISE_ID;
  return Object.freeze({
    id: profile.id,
    profile,
    endpoints: githubEndpoints(profile),
    publicPath: isDefault ? '' : `/enterprises/${profile.id}`,
    eventLogPath: isDefault ? config.eventLogPath : enterpriseEventLogPath(profile.id),
  });
}

function enterpriseEventLogPath(id: EnterpriseId): string {
  return join(dirname(config.eventLogPath), id, basename(config.eventLogPath));
}
