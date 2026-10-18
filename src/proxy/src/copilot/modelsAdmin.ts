import { SecretError } from '@ghcp/shared';
import { modelsAdminToken, type ProxyEnterprise } from '../enterprises.js';

export type ModelsAdminErrorCode =
  | 'models_admin_not_configured'
  | 'models_admin_configuration_invalid'
  | 'models_admin_credential_missing';

/** The message is only the code: configuration values and secrets never reach error text. */
export class ModelsAdminError extends Error {
  constructor(readonly code: ModelsAdminErrorCode) {
    super(code);
    this.name = 'ModelsAdminError';
  }
}

export interface ModelsAdminCredential {
  githubLogin: string;
  githubUserId?: string;
  accessToken: string;
}

const GITHUB_LOGIN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const GITHUB_USER_ID = /^[1-9]\d{0,19}$/;

/**
 * Resolves the one GitHub enterprise admin of this enterprise whose Copilot token may read its model catalog
 * (design §7 item 4). The token is re-read on every call, so a rotated secret applies without a restart.
 */
export function resolveModelsAdmin(enterprise: ProxyEnterprise): ModelsAdminCredential {
  const admin = enterprise.profile.modelsAdmin;
  const { githubLogin, githubUserId } = admin ?? {};
  if (!githubLogin && !admin?.copilotToken) throw new ModelsAdminError('models_admin_not_configured');
  if (!githubLogin || !GITHUB_LOGIN.test(githubLogin)) throw new ModelsAdminError('models_admin_configuration_invalid');
  if (githubUserId !== undefined && !GITHUB_USER_ID.test(githubUserId)) {
    throw new ModelsAdminError('models_admin_configuration_invalid');
  }
  const accessToken = readAdminToken(enterprise);
  return { githubLogin, ...(githubUserId === undefined ? {} : { githubUserId }), accessToken };
}

function readAdminToken(enterprise: ProxyEnterprise): string {
  let token: string | undefined;
  try {
    token = modelsAdminToken(enterprise);
  } catch (error) {
    if (error instanceof SecretError) throw new ModelsAdminError('models_admin_credential_missing');
    throw error;
  }
  // Kubernetes secret mounts end with a newline (removed by readSecret); anything else must be a single token.
  if (!token || /\s/.test(token)) throw new ModelsAdminError('models_admin_credential_missing');
  return token;
}
