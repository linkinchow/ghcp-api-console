const GITHUB_COM_MAX_LOGIN_LENGTH = 39;
// GHE.com reserves room for its hidden shortcode, so visible usernames are limited to 30 characters.
const GHE_COM_MAX_LOGIN_LENGTH = 30;

/**
 * Predicts the GH login GitHub derives from a SCIM userName: `<handle>_<shortcode>` on GitHub.com,
 * plain `<handle>` when no shortcode is given (GHE.com, whose API rejects suffixed usernames).
 */
export function normalizeHandle(userName: string, shortcode: string): string {
  const local = userName.includes('@') ? userName.split('@')[0]! : userName;
  let handle = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const suffix = shortcode ? `_${shortcode}` : '';
  const maxLocal = suffix ? Math.max(1, GITHUB_COM_MAX_LOGIN_LENGTH - suffix.length) : GHE_COM_MAX_LOGIN_LENGTH;
  if (handle.length > maxLocal) handle = handle.slice(0, maxLocal).replace(/-+$/g, '');
  return `${handle}${suffix}`;
}
