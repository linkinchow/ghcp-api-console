import {
  DEFAULT_ENTERPRISE_ID,
  loadRegistry,
  readSecret,
  type EnterpriseId,
  type EnterpriseProfile,
  type Registry,
} from '@ghcp/shared';
import { config } from './config.js';

/** The GitHub and Copilot endpoints the Proxy calls for one enterprise (design §6). */
export interface ProxyEndpoints {
  readonly baseUrl: string;
  readonly isGheCom: boolean;
  /** REST API: `/user` subject checks and the Models admin verification. */
  readonly apiBaseUrl: string;
  /** Copilot API: inference, model catalogs and pool warmup. */
  readonly copilotApiBaseUrl: string;
  /** EMU login suffix stripped from new direct identities; always empty on GHE.com. */
  readonly shortcode: string;
}

/** One enterprise as the Proxy runs it: its frozen registry profile plus derived endpoints. */
export interface ProxyEnterprise {
  readonly id: EnterpriseId;
  readonly profile: EnterpriseProfile;
  readonly endpoints: ProxyEndpoints;
}

let enterprises: ReadonlyMap<EnterpriseId, ProxyEnterprise> | undefined;
let registryWarnings: readonly string[] = [];

/** Loads the registry once (design §3.7); later calls return the same frozen enterprises. */
export function proxyEnterprises(): readonly ProxyEnterprise[] {
  return [...loadedEnterprises().values()];
}

export function findProxyEnterprise(id: string): ProxyEnterprise | undefined {
  return loadedEnterprises().get(id as EnterpriseId);
}

export function defaultProxyEnterprise(): ProxyEnterprise {
  return requireProxyEnterprise(DEFAULT_ENTERPRISE_ID);
}

/** The enterprise of new direct-mode identities and of the deprecated `/api/accounts` listing. */
export function directModeEnterprise(): ProxyEnterprise {
  return requireProxyEnterprise(config.directModeEnterpriseId);
}

/** The enterprise an account or pool member row names; a row outside the registry is a startup invariant. */
export function requireProxyEnterprise(id: string): ProxyEnterprise {
  const enterprise = findProxyEnterprise(id);
  if (!enterprise) throw new Error(`Enterprise "${id}" is not in the enterprise registry.`);
  return enterprise;
}

export function proxyRegistryWarnings(): readonly string[] {
  loadedEnterprises();
  return registryWarnings;
}

/**
 * The Models admin Copilot token of the enterprise; `undefined` without a reference. The baseline re-read the
 * token file on every request, so a rotated mount applies at once; `maxAgeMs: 0` keeps that.
 */
export function modelsAdminToken(enterprise: ProxyEnterprise): string | undefined {
  const ref = enterprise.profile.modelsAdmin?.copilotToken;
  if (!ref) return undefined;
  const field = `${enterprise.id}.modelsAdmin.copilotToken`;
  return readSecret(ref, { field, env: process.env, maxAgeMs: 0 });
}

/** Test hook: builds the enterprises from an explicit registry instead of the environment. */
export function setProxyEnterprisesForTesting(registry: Registry | undefined): void {
  enterprises = registry ? buildEnterprises(registry) : undefined;
  registryWarnings = registry?.warnings ?? [];
}

function loadedEnterprises(): ReadonlyMap<EnterpriseId, ProxyEnterprise> {
  if (!enterprises) {
    const registry = loadRegistry({ service: 'proxy', env: process.env });
    enterprises = buildEnterprises(registry);
    registryWarnings = registry.warnings;
  }
  return enterprises;
}

function buildEnterprises(registry: Registry): ReadonlyMap<EnterpriseId, ProxyEnterprise> {
  return new Map(registry.enterprises.map((profile) => [profile.id, buildEnterprise(profile)]));
}

function buildEnterprise(profile: EnterpriseProfile): ProxyEnterprise {
  const { github } = profile;
  const endpoints: ProxyEndpoints = Object.freeze({
    baseUrl: github.baseUrl,
    isGheCom: github.isGheCom,
    apiBaseUrl: github.apiBaseUrl,
    copilotApiBaseUrl: github.copilotApiBaseUrl,
    shortcode: github.isGheCom ? '' : github.shortcode ?? '',
  });
  return Object.freeze({ id: profile.id, profile, endpoints });
}
