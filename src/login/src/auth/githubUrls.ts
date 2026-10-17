import { parseGithubBaseUrl } from '@ghcp/shared';

export interface GithubDeployment {
  /** Origin such as https://github.com or https://<subdomain>.ghe.com. */
  baseUrl: string;
  host: string;
  /** GitHub Enterprise Cloud with data residency (GHE.com). */
  isGheCom: boolean;
  /** GHE.com enterprise SSO entry page; GHE.com has no GitHub username step. */
  enterpriseSsoUrl?: string;
}

const GHE_COM_AUTH_HOST = 'auth.ghe.com';

export function resolveGithubDeployment(rawBaseUrl: string | undefined, enterpriseSlug: string | undefined): GithubDeployment {
  const { baseUrl, host, isGheCom } = parseGithubBaseUrl(rawBaseUrl);
  if (!isGheCom) return { baseUrl, host, isGheCom };
  const slug = enterpriseSlug?.trim();
  if (!slug) throw new Error('ENTERPRISE_SLUG is required when GITHUB_BASE_URL points to GHE.com.');
  return { baseUrl, host, isGheCom, enterpriseSsoUrl: `${baseUrl}/enterprises/${encodeURIComponent(slug)}/sso` };
}

export function deviceFlowEndpoints(github: GithubDeployment): { deviceCode: string; accessToken: string } {
  return {
    deviceCode: `${github.baseUrl}/login/device/code`,
    accessToken: `${github.baseUrl}/login/oauth/access_token`,
  };
}

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
