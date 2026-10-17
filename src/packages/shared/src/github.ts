export interface GithubBaseUrl {
  /** Origin such as https://github.com or https://<subdomain>.ghe.com. */
  baseUrl: string;
  host: string;
  /**
   * GitHub Enterprise Cloud with data residency (GHE.com). The enterprise shortcode is hidden there
   * and the REST API rejects usernames that carry the `_<shortcode>` suffix.
   */
  isGheCom: boolean;
}

export const DEFAULT_GITHUB_BASE_URL = 'https://github.com';

export function parseGithubBaseUrl(rawBaseUrl: string | undefined): GithubBaseUrl {
  const raw = rawBaseUrl?.trim() || DEFAULT_GITHUB_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid GITHUB_BASE_URL "${raw}".`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(`Invalid GITHUB_BASE_URL "${raw}". Use an origin such as https://github.com or https://<subdomain>.ghe.com.`);
  }
  const host = url.hostname.toLowerCase();
  return { baseUrl: url.origin, host, isGheCom: host.endsWith('.ghe.com') };
}
