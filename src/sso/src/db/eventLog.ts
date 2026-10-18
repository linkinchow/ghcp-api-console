import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SsoEnterprise } from '../enterprises.js';
import type { SsoUserRecord } from './usersRepo.js';

type EventUser = Pick<SsoUserRecord, 'ssoUser' | 'email' | 'role' | 'ghLogin'>;

/** Appends to the enterprise's own log: SSO_USER_EVENTS_LOG for `default`, `<dir>/<id>/<basename>` otherwise. */
export function appendUserEvent(enterprise: SsoEnterprise, action: string, user: EventUser): void {
  mkdirSync(dirname(enterprise.eventLogPath), { recursive: true });
  const event = {
    time: new Date().toISOString(),
    action,
    sso_user: user.ssoUser,
    email: user.email,
    role: user.role,
    gh_login: user.ghLogin,
  };
  appendFileSync(enterprise.eventLogPath, JSON.stringify(event) + '\n');
}
