import {
  abortable,
  INTERNAL_AUTH_HEADER,
  isEnterpriseId,
  MAX_ENTERPRISES,
  readBoundedJson,
  type EnterpriseReadinessDto,
  type EnterpriseServiceReadinessDto,
} from '@ghcp/shared';
import { config } from '../config.js';
import { proxyEnterprises, type ProxyEnterprise } from '../enterprises.js';

/** The services Proxy compares its profile with (design §3.8). */
export type ReadinessPeer = 'sso' | 'login';

/** Fetches one peer's `GET /internal/enterprises` body; throws `ReadinessFetchError` when it cannot. */
export type ReadinessListingFetcher = (peer: ReadinessPeer, signal: AbortSignal) => Promise<unknown>;

export type ReadinessFetchFailure = 'unavailable' | 'invalid_response';

export class ReadinessFetchError extends Error {
  constructor(readonly failure: ReadinessFetchFailure) {
    super(failure);
    this.name = 'ReadinessFetchError';
  }
}

export interface EnterpriseReadinessOptions {
  enterprises?: () => readonly ProxyEnterprise[];
  fetchListing?: ReadinessListingFetcher;
  now?: () => number;
  /** How long a ready result is reused by this replica; 60 s by design. */
  readyTtlMs?: number;
  /** How long a not-ready result is reused, so a recovered peer is noticed soon. */
  notReadyTtlMs?: number;
  /** Bound of one peer request, including the body read. */
  timeoutMs?: number;
}

export interface ReadinessRequest {
  /** Ignore the cache; activation and resume use a live comparison. */
  fresh?: boolean;
  signal?: AbortSignal;
}

type PeerListing = ReadonlyMap<string, EnterpriseServiceReadinessDto> | ReadinessFetchFailure;

interface ReadinessSnapshot {
  readonly at: number;
  readonly results: ReadonlyMap<string, EnterpriseReadinessDto>;
}

export const READY_RESULT_TTL_MS = 60_000;
export const NOT_READY_RESULT_TTL_MS = 10_000;
export const READINESS_TIMEOUT_MS = 5_000;
export const READINESS_MAX_BYTES = 256 * 1024;
const MAX_BLOCKERS = 64;
const MAX_BLOCKER_LENGTH = 256;

/**
 * Cross-service readiness (design §3.8): Proxy compares its own profile of each enterprise with what SSO and
 * Login report. Results live in this replica's memory (ready ones 60 s, others 10 s) and are never persisted.
 * Every failure to read or trust a peer listing fails closed: the affected enterprises are not ready.
 */
export class EnterpriseReadinessClient {
  private snapshot?: ReadinessSnapshot;
  private refreshing?: Promise<ReadinessSnapshot>;
  private readonly enterprises: () => readonly ProxyEnterprise[];
  private readonly fetchListing: ReadinessListingFetcher;
  private readonly now: () => number;
  private readonly readyTtlMs: number;
  private readonly notReadyTtlMs: number;
  private readonly timeoutMs: number;

  constructor(options: EnterpriseReadinessOptions = {}) {
    this.enterprises = options.enterprises ?? proxyEnterprises;
    this.fetchListing = options.fetchListing ?? fetchPeerListing;
    this.now = options.now ?? Date.now;
    this.readyTtlMs = options.readyTtlMs ?? READY_RESULT_TTL_MS;
    this.notReadyTtlMs = options.notReadyTtlMs ?? NOT_READY_RESULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? READINESS_TIMEOUT_MS;
  }

  /** The readiness of one enterprise; an enterprise outside the Proxy registry is never ready. */
  async readiness(enterpriseId: string, request: ReadinessRequest = {}): Promise<EnterpriseReadinessDto> {
    const cached = request.fresh ? undefined : this.cached(enterpriseId);
    if (cached) return cached;
    const refresh = this.refreshing ?? this.startRefresh();
    const snapshot = await (request.signal ? abortable(refresh, request.signal) : refresh);
    return snapshot.results.get(enterpriseId) ?? unknownEnterprise(enterpriseId, snapshot.at);
  }

  /** The cached result without any network call; undefined when absent or past its TTL. */
  cached(enterpriseId: string): EnterpriseReadinessDto | undefined {
    const result = this.snapshot?.results.get(enterpriseId);
    if (!result || this.isStale(this.snapshot!.at, result)) return undefined;
    return result;
  }

  clear(): void {
    this.snapshot = undefined;
  }

  /** Ready results live 60 s; failures and not-ready results only 10 s (design §3.8). */
  private isStale(at: number, result: EnterpriseReadinessDto): boolean {
    return this.now() - at >= (result.ready ? this.readyTtlMs : this.notReadyTtlMs);
  }

  /** One refresh at a time per replica; a caller that gives up does not cancel it for the others. */
  private startRefresh(): Promise<ReadinessSnapshot> {
    const refresh = this.refresh().finally(() => {
      if (this.refreshing === refresh) this.refreshing = undefined;
    });
    this.refreshing = refresh;
    return refresh;
  }

  private async refresh(): Promise<ReadinessSnapshot> {
    const [sso, login] = await Promise.all([this.readPeer('sso'), this.readPeer('login')]);
    const at = this.now();
    const checkedAt = new Date(at).toISOString();
    const results = new Map(this.enterprises().map((enterprise) => [
      enterprise.id,
      compareEnterprise(enterprise, { sso, login }, checkedAt),
    ]));
    const snapshot = { at, results };
    this.snapshot = snapshot;
    return snapshot;
  }

  /** The deadline also bounds a fetcher that ignores its signal, so a hung peer cannot stall the refresh. */
  private async readPeer(peer: ReadinessPeer): Promise<PeerListing> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      return parseListing(await abortable(this.fetchListing(peer, signal), signal));
    } catch (error) {
      return error instanceof ReadinessFetchError ? error.failure : 'unavailable';
    }
  }
}

/** The shared per-replica cache. */
export const enterpriseReadiness = new EnterpriseReadinessClient();

/** `GET <peer>/internal/enterprises` with the internal token, a deadline and a bounded body. */
export async function fetchPeerListing(peer: ReadinessPeer, signal: AbortSignal): Promise<unknown> {
  const baseUrl = peer === 'sso' ? config.ssoBaseUrl : config.loginBaseUrl;
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/internal/enterprises`, {
    headers: { Accept: 'application/json', [INTERNAL_AUTH_HEADER]: config.internalApiToken },
    redirect: 'error',
    signal,
  });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new ReadinessFetchError('unavailable');
  }
  try {
    return await readBoundedJson(response, READINESS_MAX_BYTES);
  } catch {
    throw new ReadinessFetchError(signal.aborted ? 'unavailable' : 'invalid_response');
  }
}

/** A listing is trusted whole or not at all: one malformed or duplicated row rejects it. */
function parseListing(body: unknown): PeerListing {
  if (!Array.isArray(body) || body.length > MAX_ENTERPRISES) return 'invalid_response';
  const rows = new Map<string, EnterpriseServiceReadinessDto>();
  for (const value of body) {
    const row = parseRow(value);
    if (!row || rows.has(row.id)) return 'invalid_response';
    rows.set(row.id, row);
  }
  return rows;
}

function parseRow(value: unknown): EnterpriseServiceReadinessDto | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (!isEnterpriseId(row.id) || typeof row.configured !== 'boolean' || !isBlockerList(row.blockers)) return undefined;
  const fields = [row.githubBaseUrl, row.slug, row.shortcode];
  if (!fields.every(isNullableText)) return undefined;
  return {
    id: row.id,
    githubBaseUrl: row.githubBaseUrl as string | null,
    slug: row.slug as string | null,
    shortcode: row.shortcode as string | null,
    configured: row.configured,
    blockers: [...row.blockers],
  };
}

function isNullableText(value: unknown): boolean {
  return value === null || typeof value === 'string' && value.length <= MAX_BLOCKER_LENGTH;
}

function isBlockerList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_BLOCKERS) return false;
  return value.every((entry) => typeof entry === 'string' && entry.length <= MAX_BLOCKER_LENGTH);
}

interface PeerListings {
  sso: PeerListing;
  login: PeerListing;
}

function compareEnterprise(
  enterprise: ProxyEnterprise,
  listings: PeerListings,
  checkedAt: string,
): EnterpriseReadinessDto {
  const proxy = proxyRow(enterprise);
  const sso = peerRow(listings.sso, enterprise.id);
  const login = peerRow(listings.login, enterprise.id);
  const blockers = [
    ...proxy.blockers.map((blocker) => `proxy:${blocker}`),
    ...peerBlockers('sso', listings.sso, sso, proxy),
    ...peerBlockers('login', listings.login, login, proxy),
    ...crossBlockers(proxy, sso, login),
  ];
  return {
    enterpriseId: enterprise.id,
    ready: blockers.length === 0,
    blockers,
    services: { proxy, sso, login },
    checkedAt,
  };
}

function proxyRow(enterprise: ProxyEnterprise): EnterpriseServiceReadinessDto {
  const { github, blockers } = enterprise.profile;
  return {
    id: enterprise.id,
    githubBaseUrl: github.baseUrl,
    slug: github.slug ?? null,
    shortcode: github.shortcode ?? null,
    configured: blockers.length === 0,
    blockers: blockers.map((blocker) => `${blocker.code}:${blocker.field}`),
  };
}

function peerRow(listing: PeerListing, id: string): EnterpriseServiceReadinessDto | null {
  return typeof listing === 'string' ? null : listing.get(id) ?? null;
}

function peerBlockers(
  peer: ReadinessPeer,
  listing: PeerListing,
  row: EnterpriseServiceReadinessDto | null,
  proxy: EnterpriseServiceReadinessDto,
): string[] {
  if (typeof listing === 'string') return [`${peer}_${listing}`];
  if (!row) return [`${peer}_missing`];
  const blockers = row.blockers.map((blocker) => `${peer}:${blocker}`);
  if (!row.configured && blockers.length === 0) blockers.push(`${peer}_not_configured`);
  if (normalizeOrigin(row.githubBaseUrl) !== normalizeOrigin(proxy.githubBaseUrl)) {
    blockers.push(`${peer}_github_base_url_mismatch`);
  }
  return blockers;
}

/** The shortcode is shared by Proxy and SSO; the slug by SSO and Login, when Login reports one. */
function crossBlockers(
  proxy: EnterpriseServiceReadinessDto,
  sso: EnterpriseServiceReadinessDto | null,
  login: EnterpriseServiceReadinessDto | null,
): string[] {
  const blockers: string[] = [];
  if (sso && (sso.shortcode ?? '') !== (proxy.shortcode ?? '')) blockers.push('shortcode_mismatch');
  if (sso && login?.slug != null && login.slug !== sso.slug) blockers.push('slug_mismatch');
  return blockers;
}

function normalizeOrigin(url: string | null): string | null {
  return url === null ? null : url.replace(/\/+$/, '').toLowerCase();
}

function unknownEnterprise(enterpriseId: string, at: number): EnterpriseReadinessDto {
  return {
    enterpriseId,
    ready: false,
    blockers: ['proxy_missing'],
    services: { proxy: null, sso: null, login: null },
    checkedAt: new Date(at).toISOString(),
  };
}
