import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { config } from '../config.js';

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

export interface ModelsAdminSettings {
  githubLogin?: string;
  githubUserId?: string;
  /** Absolute path to a mounted secret; re-read on every request so rotation needs no restart. */
  tokenFile?: string;
}

export interface ModelsAdminCredential {
  githubLogin: string;
  githubUserId?: string;
  accessToken: string;
}

const GITHUB_LOGIN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const GITHUB_USER_ID = /^[1-9]\d{0,19}$/;
const MAX_TOKEN_FILE_BYTES = 128 * 1024;
const TOKEN_ENV = 'MODELS_ADMIN_COPILOT_TOKEN';

export function modelsAdminSettingsFromConfig(): ModelsAdminSettings {
  return {
    githubLogin: config.modelsAdminGithubLogin,
    githubUserId: config.modelsAdminGithubUserId,
    tokenFile: config.modelsAdminCopilotTokenFile,
  };
}

/**
 * Resolves the one GitHub enterprise admin whose Copilot token may read the model catalog.
 * The token comes from MODELS_ADMIN_COPILOT_TOKEN_FILE (preferred) or MODELS_ADMIN_COPILOT_TOKEN.
 */
export function resolveModelsAdmin(
  settings: ModelsAdminSettings = modelsAdminSettingsFromConfig(),
  env: NodeJS.ProcessEnv = process.env,
): ModelsAdminCredential {
  const { githubLogin, githubUserId, tokenFile } = settings;
  // Compose passes unset variables as empty strings; treat those as not configured.
  const tokenFromEnv = env[TOKEN_ENV] || undefined;
  if (!githubLogin && !tokenFile && tokenFromEnv === undefined) throw new ModelsAdminError('models_admin_not_configured');

  const validLogin = githubLogin !== undefined && GITHUB_LOGIN.test(githubLogin);
  const validUserId = githubUserId === undefined || GITHUB_USER_ID.test(githubUserId);
  const validTokenFile = tokenFile === undefined || isAbsolute(tokenFile);
  const oneTokenSource = !(tokenFile && tokenFromEnv !== undefined);
  if (!validLogin || !validUserId || !validTokenFile || !oneTokenSource) {
    throw new ModelsAdminError('models_admin_configuration_invalid');
  }

  const accessToken = tokenFile ? readTokenFile(tokenFile) : tokenFromEnv;
  if (!accessToken || /\s/.test(accessToken) || accessToken.length > MAX_TOKEN_FILE_BYTES) {
    throw new ModelsAdminError('models_admin_credential_missing');
  }
  return { githubLogin: githubLogin!, ...(githubUserId === undefined ? {} : { githubUserId }), accessToken };
}

function readTokenFile(file: string): string | undefined {
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size > MAX_TOKEN_FILE_BYTES) return undefined;
    // Kubernetes secret mounts commonly end with a newline; anything else must be a single token.
    return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  } catch {
    return undefined;
  }
}
