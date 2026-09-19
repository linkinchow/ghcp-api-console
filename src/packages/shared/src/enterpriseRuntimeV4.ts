import { createHash } from 'node:crypto';
import { parseEnterpriseProfileV3, type EnterpriseProfileV3 } from './enterpriseV3.js';

/** Full parsed v3 identity and trusted configuration, excluding only mutable capacity. No secrets are read. */
export function enterpriseProfileIdentityHashV4(value: EnterpriseProfileV3): string {
  const { maxAccounts: _capacity, ...identity } = parseEnterpriseProfileV3(value);
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
