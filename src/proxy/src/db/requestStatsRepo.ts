import type { ProxyRequestStatDto } from '@ghcp/shared';
import { toCanonicalRequestedModelId } from '../copilot/modelIds.js';
import { getStorage, initializeStorage } from './connection.js';
import type { RecordRequestStatInput, RequestStatListQuery } from './storageTypes.js';

export async function recordRequestStat(input: RecordRequestStatInput): Promise<void> {
  await initializeStorage();
  await getStorage().recordRequestStat({
    ...input,
    model: input.model ? toCanonicalRequestedModelId(input.model) : undefined,
  });
}

export async function listRequestStats(identity?: string, limit = 100,enterpriseId?:string): Promise<ProxyRequestStatDto[]> {
  await initializeStorage();
  return (await getStorage().listRequestStats(identity, limit,enterpriseId)).map((stat) => ({
    ...stat,
    model: stat.model ? toCanonicalRequestedModelId(stat.model) : undefined,
  }));
}

export async function pageRequestStats(query: RequestStatListQuery) {
  await initializeStorage();
  const result = await getStorage().pageRequestStats(query);
  return { ...result, items: result.items.map(stat => ({ ...stat,
    model: stat.model ? toCanonicalRequestedModelId(stat.model) : undefined })) };
}

export async function pruneAllRequestStats(): Promise<void> {
  await initializeStorage();
  await getStorage().pruneAllRequestStats();
}
