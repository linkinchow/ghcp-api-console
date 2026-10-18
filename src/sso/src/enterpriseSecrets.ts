import { SecretError } from '@ghcp/shared';
import { ssoSecret, type SsoEnterprise, type SsoSecretField } from './enterprises.js';

/** The secret, or `enterprise_secret_unconfigured` naming only the field path (design §3.4). */
export function requireSsoSecret(enterprise: SsoEnterprise, field: SsoSecretField): string {
  const secret = ssoSecret(enterprise, field);
  if (secret === undefined) throw unconfigured(enterprise, field);
  return secret;
}

/** The secret, or `undefined` when the profile has no reference or the referenced value is unset or empty. */
export function optionalSsoSecret(enterprise: SsoEnterprise, field: SsoSecretField): string | undefined {
  try {
    return ssoSecret(enterprise, field);
  } catch (error) {
    if (error instanceof SecretError && error.code === 'enterprise_secret_unconfigured') return undefined;
    throw error;
  }
}

function unconfigured(enterprise: SsoEnterprise, field: SsoSecretField): SecretError {
  return new SecretError('enterprise_secret_unconfigured', `${enterprise.id}.sso.${field}`, 'is not configured');
}
