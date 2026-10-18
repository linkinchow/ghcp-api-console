export interface TrustedUrl {
  /** Origin plus path without a trailing slash, e.g. `http://sso:7001/login`. */
  readonly href: string;
  readonly origin: string;
  readonly hostname: string;
  readonly segments: readonly string[];
}

const URL_PARTS = /^https?:\/\/([^/]*)(.*)$/i;
const DOT_SEGMENT = /(^|\/)\.{1,2}(\/|$)/;
const URL_CHECKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\s\u0000-\u001f\u007f]/, 'must not contain whitespace or control characters'],
  [/\\/, 'must not contain a backslash'],
  [/%(2e|2f|5c)/i, 'must not contain encoded dots, slashes or backslashes'],
  [/\?/, 'must not contain a query'],
  [/#/, 'must not contain a fragment'],
];

/**
 * Accepts only http(s) URLs without userinfo, query, fragment, backslashes, encoded separators or dot
 * segments. The checks run on the raw text because the URL parser silently resolves several of them.
 * Errors describe the rule, never the input. Compare results with `sameTrustedUrl`.
 */
export function parseTrustedUrl(raw: string): TrustedUrl {
  const parts = URL_PARTS.exec(raw);
  if (!parts) throw new Error('must be an http(s) URL');
  const failed = URL_CHECKS.find(([pattern]) => pattern.test(raw));
  if (failed) throw new Error(failed[1]);
  const [, authority, path] = parts;
  if (!authority) throw new Error('must have a host');
  if (authority.includes('@')) throw new Error('must not contain userinfo');
  if (DOT_SEGMENT.test(path)) throw new Error('must not contain dot segments');
  const url = parseUrl(raw);
  const segments = url.pathname.split('/').slice(1);
  if (segments.at(-1) === '') segments.pop();
  const href = segments.length > 0 ? `${url.origin}/${segments.join('/')}` : url.origin;
  return { href, origin: url.origin, hostname: url.hostname, segments };
}

/** Exact origin and per-segment path equality; `/a` never matches `/ab` or `/a/b`. */
export function sameTrustedUrl(left: TrustedUrl, right: TrustedUrl): boolean {
  if (left.origin !== right.origin || left.segments.length !== right.segments.length) return false;
  return left.segments.every((segment, index) => segment === right.segments[index]);
}

function parseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new Error('must be a valid URL');
  }
}
