/** URL hash state: `#/<page>?e=<enterpriseId>&<page query>`. The legacy `#<page>?...` form is still read. */
export interface HashState {
  page: string;
  enterpriseId?: string;
  /** Page query without `e`. */
  params: URLSearchParams;
}

export const ENTERPRISE_PARAM = 'e';

export function readHash(hash: string): HashState {
  const raw = hash.replace(/^#\/?/, '');
  const separator = raw.indexOf('?');
  const page = separator < 0 ? raw : raw.slice(0, separator);
  const params = new URLSearchParams(separator < 0 ? '' : raw.slice(separator + 1));
  const enterpriseId = params.get(ENTERPRISE_PARAM) ?? undefined;
  params.delete(ENTERPRISE_PARAM);
  return { page, enterpriseId: enterpriseId || undefined, params };
}

/** Builds `#/<page>?e=<id>&...`; the enterprise goes first so it stays visible in long list URLs. */
export function hashFor(page: string, enterpriseId?: string, params: URLSearchParams | string = ''): string {
  const query = new URLSearchParams();
  if (enterpriseId) query.set(ENTERPRISE_PARAM, enterpriseId);
  for (const [key, value] of new URLSearchParams(params)) {
    if (key !== ENTERPRISE_PARAM) query.append(key, value);
  }
  const text = query.toString();
  return `#/${page}${text ? `?${text}` : ''}`;
}

/** A list query hash on `page` that keeps the enterprise currently in the location hash. */
export function listHash(page: string, query: string, currentHash: string): string {
  return hashFor(page, readHash(currentHash).enterpriseId, query);
}
