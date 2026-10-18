import type { EnterpriseId, ManagementQuery, ProxyRequestStatDto } from '@ghcp/shared';
import { toCanonicalRequestedModelId } from '../copilot/modelIds.js';
import { getStorage, initializeStorage } from './connection.js';
import type { RecordRequestStatInput } from './storageTypes.js';

export async function recordRequestStat(input: RecordRequestStatInput): Promise<void> {
  await initializeStorage();
  await getStorage().recordRequestStat({
    ...input,
    model: input.model ? toCanonicalRequestedModelId(input.model) : undefined,
  });
}

export async function listRequestStats(
  enterpriseId: EnterpriseId,
  identity?: string,
  limit = 100,
): Promise<ProxyRequestStatDto[]> {
  await initializeStorage();
  return (await getStorage().listRequestStats(enterpriseId, identity, limit)).map((stat) => ({
    ...stat,
    model: stat.model ? toCanonicalRequestedModelId(stat.model) : undefined,
  }));
}

export async function pruneAllRequestStats(): Promise<void> {
  await initializeStorage();
  await getStorage().pruneAllRequestStats();
}

export async function listRequestStatsPage(enterpriseId: EnterpriseId, query: ManagementQuery) {
  await initializeStorage();
  return getStorage().listRequestStatsPage(enterpriseId, query);
}
