/** One entry of the Copilot model catalog, as shown on the Console Models page. */
export interface ProxyModelDto {
  /** Canonical Claude-style ID that callers send to Proxy. */
  id: string;
  /** ID as returned by Copilot. */
  upstreamId: string;
  name?: string;
  /** Proxy API paths this model can serve (may include inferred compatibility). */
  supportedPaths: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Allow-listed upstream metadata; never credentials. */
  details: Record<string, unknown>;
}

/**
 * GET /api/models: the catalog visible to the configured GitHub enterprise admin.
 * Pool and direct-mode accounts are never used to answer this request.
 */
export interface AdminModelsResponse {
  adminLogin: string;
  fetchedAt: string;
  cacheStatus: 'fresh' | 'cached' | 'stale';
  /** Which view public callers get by default (Claude Code optimized mode lists Messages models). */
  defaultView: 'all' | 'messages';
  models: ProxyModelDto[];
}
