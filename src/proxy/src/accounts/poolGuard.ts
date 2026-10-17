import { HttpApiError } from '@ghcp/shared';
import { getUserPool } from '../userPool/runtime.js';

export const POOL_MEMBER_MANAGED_MESSAGE = 'Use User pool recovery controls for this account; an independent Login task cannot be started.';

export async function isPoolManagedAccount(identity: string): Promise<boolean> {
  return Boolean(await (await getUserPool())?.inventory(identity));
}

/** Manual and batch reauthorization must not start Login tasks for accounts the user pool owns. */
export async function assertNotPoolManagedAccount(identity: string): Promise<void> {
  if (await isPoolManagedAccount(identity)) {
    throw new HttpApiError(409, 'pool_member_managed', POOL_MEMBER_MANAGED_MESSAGE);
  }
}
