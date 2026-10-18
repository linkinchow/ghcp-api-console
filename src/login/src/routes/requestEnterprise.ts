import type { Response } from 'express';
import { enterpriseOf } from '@ghcp/shared';
import type { LoginEnterprise } from '../enterprises.js';

/** The enterprise `requireEnterprise(findLoginEnterprise)` resolved from `:enterpriseId` for this request. */
export function requestEnterprise(res: Response): LoginEnterprise {
  return enterpriseOf<LoginEnterprise>(res).profile;
}
