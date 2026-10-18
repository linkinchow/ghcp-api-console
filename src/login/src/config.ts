import 'dotenv/config';
import type { GithubDeployment, LoginSelectors, SsoProvider } from '@ghcp/shared';

/** Process-level settings; per-enterprise values (GitHub, SSO login page, selectors) live in the registry. */
export interface LoginConfig {
  port: number;
  dbPath: string;
  internalApiToken: string;
  proxyBaseUrl: string;
  logDir: string;
  githubOauthScope: string;
  opencodeUserAgent: string;
  auth: AuthConfig;
}

export interface AuthConfig {
  azureStaySignedIn: boolean;
  headless: boolean;
  debugArtifactsDir: string;
}

/** Everything one browser authorization needs, built from the task's enterprise (design §5.7). */
export interface RuntimeAuthConfig extends AuthConfig {
  github: GithubDeployment;
  ssoProvider: SsoProvider;
  ssoLoginUrl?: string;
  /** Pages that may receive SSO credentials; see `auth/loginUrlAllowlist.ts`. */
  allowedLoginUrls: readonly string[];
  selectors: LoginSelectors;
  timeoutMs: number;
  debugLogs: boolean;
  debugArtifacts: boolean;
}

export const config: LoginConfig = {
  port: readPort(process.env.PORT, 7003),
  dbPath: process.env.DB_PATH ?? './data/login.sqlite',
  internalApiToken: process.env.INTERNAL_API_TOKEN ?? '',
  proxyBaseUrl: process.env.PROXY_BASE_URL ?? 'http://localhost:3000',
  logDir: process.env.LOG_DIR ?? './logs/login',
  githubOauthScope: readOptionalString(process.env.GITHUB_OAUTH_SCOPE) ?? 'read:user',
  opencodeUserAgent: readOptionalString(process.env.OPENCODE_USER_AGENT)
    ?? `opencode/${readOptionalString(process.env.OPENCODE_VERSION) ?? '1.0.0'}`,
  auth: {
    azureStaySignedIn: readBoolean(process.env.AZURE_STAY_SIGNED_IN, false),
    headless: readBoolean(process.env.AUTH_HEADLESS, true),
    debugArtifactsDir: process.env.AUTH_DEBUG_ARTIFACT_DIR ?? '.auth-debug',
  },
};

function readPort(value: string | undefined, defaultValue: number): number {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) throw new Error(`Invalid PORT "${value}".`);
  return parsed;
}

function readBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`Invalid boolean "${value}".`);
}

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
