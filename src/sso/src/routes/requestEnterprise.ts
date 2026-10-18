import type { Response } from 'express';
import { enterpriseOf } from '@ghcp/shared';
import type { SsoEnterprise } from '../enterprises.js';

/** The enterprise `requireEnterprise(findSsoEnterprise)` resolved from `:enterpriseId` for this request. */
export function requestEnterprise(res: Response): SsoEnterprise {
  return enterpriseOf<SsoEnterprise>(res).profile;
}
