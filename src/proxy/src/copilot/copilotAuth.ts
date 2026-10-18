import type { EnterpriseId } from '@ghcp/shared';

export interface CopilotAuthContext {
  identity: string;
  accessToken: string;
  api: string;
  /** The account's enterprise; prefixes model caches and records request statistics (design §5.4, §6). */
  enterpriseId?: EnterpriseId;
}
