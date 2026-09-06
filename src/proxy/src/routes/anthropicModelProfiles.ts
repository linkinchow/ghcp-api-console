export type ThinkingPolicy = 'enabled-only' | 'adaptive-only' | 'all';

import { toCanonicalModelId } from '../copilot/modelIds.js';

export interface AnthropicModelProfile {
  canonicalId: string;
  acceptedEfforts: readonly string[];
  thinking: ThinkingPolicy;
  maxThinkingBudget: number;
  acceptsMidConversationSystem: boolean;
  stripBetas: readonly string[];
  supportsAdaptiveThinking: boolean;
}

const DEFAULT_MAX_THINKING_BUDGET = 32_000;

const ENABLED_ONLY: Omit<AnthropicModelProfile, 'canonicalId'> = {
  acceptedEfforts: [],
  thinking: 'enabled-only',
  maxThinkingBudget: DEFAULT_MAX_THINKING_BUDGET,
  acceptsMidConversationSystem: false,
  stripBetas: [],
  supportsAdaptiveThinking: false,
};

const ALL_THINKING: Omit<AnthropicModelProfile, 'canonicalId'> = {
  acceptedEfforts: ['low', 'medium', 'high', 'max'],
  thinking: 'all',
  maxThinkingBudget: DEFAULT_MAX_THINKING_BUDGET,
  acceptsMidConversationSystem: false,
  stripBetas: [],
  supportsAdaptiveThinking: true,
};

const ADAPTIVE_ONLY: Omit<AnthropicModelProfile, 'canonicalId'> = {
  acceptedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  thinking: 'adaptive-only',
  maxThinkingBudget: DEFAULT_MAX_THINKING_BUDGET,
  acceptsMidConversationSystem: false,
  stripBetas: [],
  supportsAdaptiveThinking: true,
};

const PROFILES = new Map<string, AnthropicModelProfile>(
  [
    profile('claude-haiku-4-5', ENABLED_ONLY, { stripBetas: ['context-1m-*'] }),
    profile('claude-sonnet-4', ALL_THINKING),
    profile('claude-sonnet-4-5', ENABLED_ONLY, { stripBetas: ['context-1m-*'] }),
    profile('claude-sonnet-4-6', ALL_THINKING),
    profile('claude-opus-4-5', ENABLED_ONLY),
    profile('claude-opus-4-6', ALL_THINKING),
    profile('claude-opus-4-6-1m', ALL_THINKING, { stripBetas: ['context-1m-*'] }),
    profile('claude-opus-4-7', ADAPTIVE_ONLY),
    profile('claude-opus-4-7-1m-internal', ADAPTIVE_ONLY, { stripBetas: ['context-1m-*'] }),
    profile('claude-opus-4-7-high', ADAPTIVE_ONLY, { acceptedEfforts: ['high'] }),
    profile('claude-opus-4-7-xhigh', ADAPTIVE_ONLY, { acceptedEfforts: ['xhigh'] }),
    profile('claude-opus-4-8', ADAPTIVE_ONLY, { acceptsMidConversationSystem: true }),
  ].map((item) => [item.canonicalId, item]),
);

export function getAnthropicModelProfile(modelId: string): AnthropicModelProfile {
  const canonicalId = toCanonicalModelId(modelId);
  const exact = PROFILES.get(canonicalId);
  if (exact) return exact;

  if (/(^|-)haiku(-|$)/i.test(canonicalId)) {
    return profile(canonicalId, ENABLED_ONLY, { stripBetas: ['context-1m-*'] });
  }
  if (/(^|-)opus-4-([78])($|-)/i.test(canonicalId)) {
    return profile(canonicalId, ADAPTIVE_ONLY, { acceptsMidConversationSystem: canonicalId.includes('opus-4-8') });
  }
  if (/(^|-)(sonnet|opus)-4-5($|-)/i.test(canonicalId)) {
    return profile(canonicalId, ENABLED_ONLY);
  }
  return profile(canonicalId, ALL_THINKING);
}

function profile(
  canonicalId: string,
  base: Omit<AnthropicModelProfile, 'canonicalId'>,
  overrides: Partial<Omit<AnthropicModelProfile, 'canonicalId'>> = {},
): AnthropicModelProfile {
  return {
    canonicalId,
    acceptedEfforts: overrides.acceptedEfforts ?? base.acceptedEfforts,
    thinking: overrides.thinking ?? base.thinking,
    maxThinkingBudget: overrides.maxThinkingBudget ?? base.maxThinkingBudget,
    acceptsMidConversationSystem: overrides.acceptsMidConversationSystem ?? base.acceptsMidConversationSystem,
    stripBetas: overrides.stripBetas ?? base.stripBetas,
    supportsAdaptiveThinking: overrides.supportsAdaptiveThinking ?? base.supportsAdaptiveThinking,
  };
}
