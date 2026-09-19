import type { EnterpriseScope } from '@ghcp/shared';
import { getScopeProfile } from '../enterprise.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { config } from '../config.js';
import type { SsoUserRecord } from './usersRepo.js';

export function appendUserEvent(action: string, user: Pick<SsoUserRecord, 'ssoUser' | 'email' | 'role' | 'ghLogin' | 'enterpriseId'>, scope: EnterpriseScope): void {
  const profile = getScopeProfile(scope);
  if (user.enterpriseId !== profile.id) throw new Error('User event enterprise mismatch.');
  const path = join(dirname(config.eventLogPath), profile.id, basename(config.eventLogPath));
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    JSON.stringify({
      time: new Date().toISOString(),
      action,
      enterpriseId: profile.id,
      enterpriseRevision: profile.revision,
      sso_user: user.ssoUser,
      email: user.email,
      role: user.role,
      gh_login: user.ghLogin,
    }) + '\n',
  );
}
