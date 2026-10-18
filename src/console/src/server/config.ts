import 'dotenv/config';

export interface ConsoleConfig {
  port: number;
  adminsFile: string;
  sessionSecret: string;
  internalApiToken: string;
  proxyBaseUrl: string;
  ssoBaseUrl: string;
  loginBaseUrl: string;
  /** Browser-facing Console URL behind a proxy that rewrites `Host`; its host is accepted as a write origin. */
  publicBaseUrl?: string;
}

export const config: ConsoleConfig = {
  port: readPort(process.env.PORT, 7004),
  adminsFile: process.env.ADMINS_FILE ?? './data/admins.json',
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-secret-change-me',
  internalApiToken: process.env.INTERNAL_API_TOKEN ?? '',
  proxyBaseUrl: process.env.PROXY_BASE_URL ?? 'http://localhost:3000',
  ssoBaseUrl: process.env.SSO_BASE_URL ?? 'http://localhost:7001',
  loginBaseUrl: process.env.LOGIN_BASE_URL ?? 'http://localhost:7003',
  publicBaseUrl: readPublicBaseUrl(process.env.CONSOLE_PUBLIC_BASE_URL),
};

function readPublicBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = URL.canParse(value) ? new URL(value) : undefined;
  if (parsed?.protocol !== 'http:' && parsed?.protocol !== 'https:') {
    throw new Error(`Invalid CONSOLE_PUBLIC_BASE_URL "${value}".`);
  }
  return value;
}

function readPort(value: string | undefined, defaultValue: number): number {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) throw new Error(`Invalid PORT "${value}".`);
  return parsed;
}
