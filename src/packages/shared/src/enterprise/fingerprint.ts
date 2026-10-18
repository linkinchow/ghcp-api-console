import { createHash } from 'node:crypto';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** The identity fields of a profile (design §3.6); a registry `EnterpriseProfile` satisfies this shape. */
export interface ProfileIdentity {
  readonly id: string;
  readonly github: { readonly baseUrl: string; readonly shortcode?: string };
  readonly pool: { readonly accountDomain?: string };
}

/**
 * The single stable hash of an enterprise's immutable identity. Inputs must already be registry-normalized
 * (origin base URL, lower-case domain); a missing shortcode or account domain hashes as `null`.
 */
export function profileFingerprint(profile: ProfileIdentity): string {
  const identity = {
    id: profile.id,
    githubBaseUrl: profile.github.baseUrl,
    shortcode: profile.github.shortcode ?? null,
    accountDomain: profile.pool.accountDomain ?? null,
  };
  return createHash('sha256').update(canonicalJson(identity)).digest('hex');
}

/** JSON with object keys sorted by code point and no whitespace, so equal values serialize identically. */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const keys = Object.keys(value).sort(compareKeys);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function compareKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
