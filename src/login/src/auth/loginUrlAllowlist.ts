import { parseLoginUrl, type TrustedUrl } from '@ghcp/shared';

/**
 * Whether the browser's current page is one of the enterprise's SSO login pages, so SSO credentials may be typed
 * into it. An entry matches the same origin and any path that starts with all of the entry's segments: r4 accepted
 * sub-paths of SSO_URL, but `/login` must not match `/loginfoo`. The current page's query and fragment are
 * ignored; userinfo, backslashes, encoded separators and dot segments never match.
 */
export function isAllowedLoginUrl(rawUrl: string, allowedUrls: readonly string[]): boolean {
  const current = tryParseLoginUrl(rawUrl);
  if (!current) return false;
  return allowedUrls.some((entry) => {
    const allowed = tryParseLoginUrl(entry);
    return allowed !== undefined && isSegmentPrefix(allowed, current);
  });
}

function isSegmentPrefix(allowed: TrustedUrl, current: TrustedUrl): boolean {
  if (allowed.origin !== current.origin || allowed.segments.length > current.segments.length) return false;
  return allowed.segments.every((segment, index) => segment === current.segments[index]);
}

function tryParseLoginUrl(raw: string): TrustedUrl | undefined {
  try {
    return parseLoginUrl(raw);
  } catch {
    return undefined;
  }
}
