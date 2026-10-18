import { Router, type Request, type Response } from 'express';
import { apiError } from '@ghcp/shared';
import { getUser } from '../db/usersRepo.js';
import { knownDefaultPasswordForUserAsync } from '../users/passwordPolicy.js';
import { requestEnterprise } from './requestEnterprise.js';

/** scrypt checks run on the libuv pool; the cap is process-wide, across enterprises. */
const MAX_CONCURRENT_RESOLUTIONS = 4;
let resolving = 0;

/** `/users/:ssoUser/login-credentials` for Login; mounted behind `requireEnterprise` under `/internal`. */
export function createLoginCredentialsRouter(): Router {
  const router = Router();
  router.post('/users/:ssoUser/login-credentials', loginCredentialsHandler);
  return router;
}

async function loginCredentialsHandler(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const enterprise = requestEnterprise(res);
  const user = getUser(enterprise.id, req.params.ssoUser as string);
  if (!user) {
    res.status(404).json(apiError('user_not_found', 'The existing SSO user was not found.'));
    return;
  }
  if (resolving >= MAX_CONCURRENT_RESOLUTIONS) {
    res.setHeader('Retry-After', '1');
    const message = 'Default credential checks are busy; retry this account shortly.';
    res.status(429).json(apiError('default_credentials_busy', message));
    return;
  }
  resolving++;
  let password: string | undefined;
  try {
    password = await knownDefaultPasswordForUserAsync(enterprise, user);
  } finally {
    resolving--;
  }
  if (!password) {
    const message = 'This account no longer uses a known default password. Provide an override for this account.';
    res.status(409).json(apiError('password_override_required', message));
    return;
  }
  res.json({ ssoUser: user.ssoUser, password });
}
