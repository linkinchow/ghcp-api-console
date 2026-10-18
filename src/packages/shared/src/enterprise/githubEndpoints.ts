import { parseGithubBaseUrl } from '../github.js';

export interface GithubDeployment {
  /** Origin such as https://<host> or https://<subdomain>.ghe.com. */
  baseUrl: string;
  host: string;
  /** GitHub Enterprise Cloud with data residency (GHE.com). */
  isGheCom: boolean;
  /** GHE.com enterprise SSO entry page; GHE.com has no GitHub username step. */
  enterpriseSsoUrl?: string;
}

export interface DeviceFlowEndpoints {
  deviceCode: string;
  accessToken: string;
}

/** The profile fields the endpoints depend on; a registry profile satisfies this shape. */
export interface GithubEndpointsProfile {
  github: {
    baseUrl: string;
    apiBaseUrl?: string;
    copilotApiBaseUrl?: string;
    slug?: string;
    shortcode?: string;
  };
  sso?: {
    spEntityId?: string;
    spAcsUrl?: string;
    scimBaseUrl?: string;
  };
}

export interface GithubEndpoints extends GithubDeployment {
  enterpriseSsoUrl: string | undefined;
  slug: string | undefined;
  /** EMU login suffix; always empty on GHE.com, whose API rejects suffixed usernames. */
  shortcode: string;
  deviceFlow: Readonly<DeviceFlowEndpoints>;
  deviceVerificationUrl: string;
  apiBaseUrl: string;
  copilotApiBaseUrl: string;
  /** SAML SP identity; undefined when neither configured nor derivable (no slug). */
  spEntityId: string | undefined;
  spAcsUrl: string | undefined;
  scimBaseUrl: string | undefined;
}

export interface ApiBaseUrls {
  api: string;
  copilotApi: string;
}

const GHE_COM_AUTH_HOST = 'auth.ghe.com';

/** Computes every GitHub / GHE.com endpoint of one enterprise profile (design §6). */
export function githubEndpoints(profile: GithubEndpointsProfile): Readonly<GithubEndpoints> {
  const { github, sso } = profile;
  if (!github.baseUrl.trim()) throw new Error('github.baseUrl is required.');
  const deployment = resolveGithubDeployment(github.baseUrl, github.slug);
  const slug = github.slug?.trim() || undefined;
  const defaults = defaultApiBaseUrls(deployment);
  const apiBaseUrl = configuredUrl(github.apiBaseUrl) ?? defaults.api;
  const spEntityId = configuredUrl(sso?.spEntityId) ?? slugUrl(deployment.baseUrl, slug);
  return Object.freeze({
    ...deployment,
    enterpriseSsoUrl: deployment.enterpriseSsoUrl,
    slug,
    shortcode: deployment.isGheCom ? '' : github.shortcode?.trim() ?? '',
    deviceFlow: Object.freeze(deviceFlowEndpoints(deployment)),
    deviceVerificationUrl: `${deployment.baseUrl}/login/device`,
    apiBaseUrl,
    copilotApiBaseUrl: configuredUrl(github.copilotApiBaseUrl) ?? defaults.copilotApi,
    spEntityId,
    spAcsUrl: configuredUrl(sso?.spAcsUrl) ?? acsUrl(deployment.baseUrl, slug),
    scimBaseUrl: configuredUrl(sso?.scimBaseUrl) ?? scimUrl(apiBaseUrl, slug),
  });
}

/**
 * Default REST and Copilot API origins. This is the only place that may name the public github.com hosts.
 * GHE.com keeps the web origin's scheme and port so mock `<sub>.ghe.com` hosts derive matching API hosts.
 */
export function defaultApiBaseUrls(github: Pick<GithubDeployment, 'baseUrl' | 'isGheCom'>): ApiBaseUrls {
  if (!github.isGheCom) return { api: 'https://api.github.com', copilotApi: 'https://api.githubcopilot.com' };
  return { api: prefixHost(github.baseUrl, 'api'), copilotApi: prefixHost(github.baseUrl, 'copilot-api') };
}

function prefixHost(origin: string, label: string): string {
  const url = new URL(origin);
  url.hostname = `${label}.${url.hostname}`;
  return url.origin;
}

function configuredUrl(raw: string | undefined): string | undefined {
  return raw?.trim().replace(/\/+$/, '') || undefined;
}

function slugUrl(baseUrl: string, slug: string | undefined): string | undefined {
  return slug ? `${baseUrl}/enterprises/${encodeURIComponent(slug)}` : undefined;
}

function acsUrl(baseUrl: string, slug: string | undefined): string | undefined {
  return slug ? `${slugUrl(baseUrl, slug)}/saml/consume` : undefined;
}

function scimUrl(apiBaseUrl: string, slug: string | undefined): string | undefined {
  return slug ? `${apiBaseUrl}/scim/v2/enterprises/${encodeURIComponent(slug)}` : undefined;
}

export function resolveGithubDeployment(
  rawBaseUrl: string | undefined,
  enterpriseSlug: string | undefined,
): GithubDeployment {
  const { baseUrl, host, isGheCom } = parseGithubBaseUrl(rawBaseUrl);
  if (!isGheCom) return { baseUrl, host, isGheCom };
  const slug = enterpriseSlug?.trim();
  if (!slug) throw new Error('ENTERPRISE_SLUG is required when GITHUB_BASE_URL points to GHE.com.');
  return { baseUrl, host, isGheCom, enterpriseSsoUrl: `${baseUrl}/enterprises/${encodeURIComponent(slug)}/sso` };
}

export function deviceFlowEndpoints(github: GithubDeployment): DeviceFlowEndpoints {
  return {
    deviceCode: `${github.baseUrl}/login/device/code`,
    accessToken: `${github.baseUrl}/login/oauth/access_token`,
  };
}

/** The configured host, its subdomains and, on GHE.com, the shared auth.ghe.com sign-in host. */
export function isGitHubUrl(rawUrl: string, github: GithubDeployment): boolean {
  const hostname = hostnameOf(rawUrl);
  if (!hostname) return false;
  if (hostname === github.host || hostname.endsWith(`.${github.host}`)) return true;
  return github.isGheCom && hostname === GHE_COM_AUTH_HOST;
}

export function isGitHubSsoInterstitial(rawUrl: string, github: GithubDeployment): boolean {
  return isGitHubUrl(rawUrl, github) && pathnameOf(rawUrl).includes('/sso');
}

export function isGitHubDeviceAccountSelectionUrl(rawUrl: string, github: GithubDeployment): boolean {
  return isGitHubUrl(rawUrl, github) && pathnameOf(rawUrl).includes('/login/device/select_account');
}

/** GHE.com sign-in pages redirect to the enterprise SSO page instead of asking for a username. */
export function isGheComSignInPage(rawUrl: string, github: GithubDeployment): boolean {
  if (!github.isGheCom || !isGitHubUrl(rawUrl, github)) return false;
  const pathname = pathnameOf(rawUrl).replace(/\/+$/, '');
  return pathname === '/login' || pathname === '/session';
}

function hostnameOf(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function pathnameOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname.toLowerCase();
  } catch {
    return '';
  }
}
