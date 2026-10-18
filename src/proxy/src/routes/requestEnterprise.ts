import type { Response } from 'express';
import { enterpriseOf } from '@ghcp/shared';
import type { ProxyEnterprise } from '../enterprises.js';

/** The enterprise `requireEnterprise(findProxyEnterprise)` resolved from `:enterpriseId` for this request. */
export function requestEnterprise(res: Response): ProxyEnterprise {
  return enterpriseOf<ProxyEnterprise>(res).profile;
}
