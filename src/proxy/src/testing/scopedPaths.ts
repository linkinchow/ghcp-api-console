import assert from 'node:assert/strict';

/**
 * For SSO/Login mocks written against the single-enterprise paths: asserts that an `/api/...` call is scoped to
 * `enterpriseId` and returns the URL without the scope, so `/api/enterprises/default/users/x` reads `/api/users/x`.
 * It imports no application module, so tests may load it before they prepare the environment.
 */
export function unscopedUrl(input: string | URL | Request, enterpriseId = 'default'): URL {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!url.pathname.startsWith('/api/')) return url;
  const prefix = `/api/enterprises/${enterpriseId}/`;
  assert.ok(url.pathname.startsWith(prefix), `${url.pathname} is not scoped to ${enterpriseId}`);
  url.pathname = `/api/${url.pathname.slice(prefix.length)}`;
  return url;
}
