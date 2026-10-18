import 'dotenv/config';

/**
 * Service-level settings only. Per-enterprise values (GitHub endpoints, slug, shortcode, SCIM, seat PAT,
 * default password, SAML certificates, session secret) come from the enterprise registry; see `enterprises.ts`.
 */
export interface SsoConfig {
  port: number;
  dbPath: string;
  internalApiToken: string;
  baseUrl: string;
  proxyBaseUrl: string;
  /** SSO_USER_EVENTS_LOG: the `default` enterprise's log; other enterprises write `<dir>/<id>/<basename>`. */
  eventLogPath: string;
}

export const config: SsoConfig = {
  port: readPort(process.env.PORT, 7001),
  dbPath: process.env.DB_PATH ?? './data/sso.sqlite',
  internalApiToken: process.env.INTERNAL_API_TOKEN ?? '',
  baseUrl: process.env.BASE_URL ?? 'http://localhost:7001',
  proxyBaseUrl: process.env.PROXY_BASE_URL ?? 'http://localhost:3000',
  eventLogPath: process.env.SSO_USER_EVENTS_LOG ?? './data/sso-user-events.log',
};

function readPort(value: string | undefined, defaultValue: number): number {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) throw new Error(`Invalid PORT "${value}".`);
  return parsed;
}
