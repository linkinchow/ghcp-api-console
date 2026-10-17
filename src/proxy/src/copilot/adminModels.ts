import type { ProxyModelDto } from '@ghcp/shared';
import { COPILOT_API_PATHS, modelSupportsPath, type ModelInfo } from './copilotClient.js';
import { toCanonicalModelId, withCanonicalModelIds } from './modelIds.js';

const MAX_TEXT_LENGTH = 4096;
const MAX_LIST_ITEMS = 64;

// Only these upstream fields are shown in the Console details dialog; anything else is dropped.
const MODEL_FIELDS = ['id', 'name', 'object', 'version', 'vendor', 'preview', 'model_picker_enabled', 'supported_endpoints'];
const CAPABILITY_FIELDS = ['family', 'type', 'tokenizer', 'object', 'endpoints'];
const LIMIT_FIELDS = ['max_context_window_tokens', 'max_prompt_tokens', 'max_output_tokens'];
const SUPPORT_FIELDS = ['tool_calls', 'parallel_tool_calls', 'vision', 'streaming', 'structured_outputs', 'reasoning_effort'];
const POLICY_FIELDS = ['state', 'terms'];

/** Converts the raw Copilot catalog into Console DTOs with canonical IDs and allow-listed metadata. */
export function toAdminModels(models: ModelInfo[]): ProxyModelDto[] {
  // Throws ModelIdCollisionError instead of silently merging two upstream IDs into one canonical ID.
  withCanonicalModelIds(models);
  return models.map(toAdminModel);
}

function toAdminModel(model: ModelInfo): ProxyModelDto {
  const capabilities = asRecord(model.capabilities);
  const limits = asRecord(capabilities?.limits);
  const details: Record<string, unknown> = pick(model, MODEL_FIELDS);
  if (capabilities) {
    details.capabilities = {
      ...pick(capabilities, CAPABILITY_FIELDS),
      limits: pick(limits, LIMIT_FIELDS),
      supports: pick(asRecord(capabilities.supports), SUPPORT_FIELDS),
    };
  }
  const policy = asRecord(model.policy);
  if (policy) details.policy = pick(policy, POLICY_FIELDS);

  return {
    id: toCanonicalModelId(model.id),
    upstreamId: model.id,
    name: boundedText(model.name),
    supportedPaths: COPILOT_API_PATHS.filter((path) => modelSupportsPath(model, path)),
    contextWindow: nonNegativeInteger(limits?.max_context_window_tokens),
    maxOutputTokens: nonNegativeInteger(limits?.max_output_tokens),
    details,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT_LENGTH) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Copies allow-listed scalar or string-list fields; nested objects are never copied wholesale. */
function pick(source: Record<string, unknown> | undefined, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string') {
      result[key] = boundedText(value);
    } else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      result[key] = value;
    } else if (Array.isArray(value)) {
      result[key] = value
        .slice(0, MAX_LIST_ITEMS)
        .filter((item): item is string => typeof item === 'string')
        .map(boundedText);
    }
  }
  return result;
}
