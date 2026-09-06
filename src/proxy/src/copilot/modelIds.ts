export interface ModelIdResolution<T> {
  requestedId: string;
  canonicalId: string;
  upstreamId: string;
  model: T;
}

export class ModelIdCollisionError extends Error {
  constructor(
    readonly canonicalId: string,
    readonly upstreamIds: readonly string[],
  ) {
    super(`Multiple Copilot model IDs map to canonical ID "${canonicalId}": ${upstreamIds.join(', ')}`);
    this.name = 'ModelIdCollisionError';
  }
}

export function toCanonicalModelId(modelId: string): string {
  if (!modelId.startsWith('claude-')) return modelId;
  return modelId.replace(/(^|-)(\d+)\.(\d+)(?=$|-)/, '$1$2-$3');
}

function withoutDateAlias(modelId: string): string {
  return modelId.startsWith('claude-') ? modelId.replace(/-\d{8}$/, '') : modelId;
}

export function toCanonicalRequestedModelId(modelId: string): string {
  return withoutDateAlias(toCanonicalModelId(modelId));
}

export function buildModelIdIndex<T extends { id: string }>(models: readonly T[]): Map<string, ModelIdResolution<T>> {
  const canonicalGroups = new Map<string, T[]>();
  for (const model of models) {
    const canonicalId = toCanonicalModelId(model.id);
    const group = canonicalGroups.get(canonicalId);
    if (group) group.push(model);
    else canonicalGroups.set(canonicalId, [model]);
  }

  const index = new Map<string, ModelIdResolution<T>>();
  for (const [canonicalId, group] of canonicalGroups) {
    const upstreamIds = [...new Set(group.map((model) => model.id))];
    if (group.length !== 1) throw new ModelIdCollisionError(canonicalId, upstreamIds);
    const model = group[0]!;
    const resolution = { requestedId: canonicalId, canonicalId, upstreamId: model.id, model };
    index.set(canonicalId, resolution);
    index.set(model.id, resolution);
  }
  return index;
}

export function resolveModelId<T extends { id: string }>(
  index: ReadonlyMap<string, ModelIdResolution<T>>,
  requestedId: string,
): ModelIdResolution<T> | undefined {
  const canonicalRequestedId = toCanonicalModelId(requestedId);
  const withoutDate = withoutDateAlias(canonicalRequestedId);
  const resolved = index.get(requestedId)
    ?? index.get(canonicalRequestedId)
    ?? (withoutDate === canonicalRequestedId ? undefined : index.get(withoutDate));
  return resolved ? { ...resolved, requestedId } : undefined;
}

export function withCanonicalModelId<T extends { id: string }>(model: T): T {
  const id = toCanonicalModelId(model.id);
  return id === model.id ? model : { ...model, id };
}

export function withCanonicalModelIds<T extends { id: string }>(models: readonly T[]): T[] {
  buildModelIdIndex(models);
  const canonical = new Map<string, T>();
  for (const model of models) {
    const publicModel = withCanonicalModelId(model);
    if (!canonical.has(publicModel.id)) canonical.set(publicModel.id, publicModel);
  }
  return [...canonical.values()];
}
