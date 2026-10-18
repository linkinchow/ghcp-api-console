import { externalFetch, loggerFor, type CopilotSeatSnapshot } from '@ghcp/shared';
import type { SsoEnterprise } from '../enterprises.js';
import { requireSsoSecret } from '../enterpriseSecrets.js';

export interface CopilotSeatMutationResult {
  ghLogin: string;
  operation: 'assign' | 'remove';
  status: number;
  response: unknown;
}

export class CopilotSeatNotAssignedError extends Error {
  constructor(
    readonly ghLogin: string,
    readonly status: number,
    readonly response: unknown,
  ) {
    super(`GitHub user "${ghLogin}" does not have a Copilot seat.`);
    this.name = 'CopilotSeatNotAssignedError';
  }
}

const logger = loggerFor('sso', 'copilot-seats');
const GITHUB_API_VERSION = '2026-03-10';

export async function assignCopilotSeat(
  enterprise: SsoEnterprise,
  ghLogin: string,
): Promise<CopilotSeatMutationResult> {
  return mutateCopilotSeat(enterprise, 'assign', ghLogin);
}

export async function removeCopilotSeat(
  enterprise: SsoEnterprise,
  ghLogin: string,
): Promise<CopilotSeatMutationResult> {
  return mutateCopilotSeat(enterprise, 'remove', ghLogin);
}

export async function listCopilotSeatAssignments(enterprise: SsoEnterprise): Promise<Map<string, CopilotSeatSnapshot>> {
  const assignments = new Map<string, CopilotSeatSnapshot>();
  const visited = new Set<string>();
  let url: string | undefined = `${enterpriseApiUrl(enterprise, '/copilot/billing/seats')}?per_page=100&page=1`;
  while (url) {
    if (visited.has(url)) throw new Error('GitHub Copilot seat list returned a repeated pagination link.');
    visited.add(url);
    const { res, response } = await readSeats(enterprise, url);
    const page = parseSeatListPage(response);
    for (const [login, seat] of page.assignments) mergeSeat(assignments, login, seat);
    url = nextPageUrl(res, url, page.itemCount);
  }
  logger.info('list', 'Listed GitHub enterprise direct Copilot seats', {
    enterpriseId: enterprise.id,
    assignedSeats: assignments.size,
    pages: visited.size,
  });
  return assignments;
}

export async function getCopilotSeatAssignment(
  enterprise: SsoEnterprise,
  ghLogin: string,
): Promise<CopilotSeatSnapshot> {
  const username = ghLogin.trim();
  if (!username) throw new Error('ghLogin is required for Copilot seat lookup.');
  const url = enterpriseApiUrl(enterprise, `/members/${encodeURIComponent(username)}/copilot`);
  const { res, response } = await readSeats(enterprise, url, true);
  // A member lookup's 404 can also hide permission/configuration problems.
  const assignments = res.status === 404
    ? await listCopilotSeatAssignments(enterprise)
    : parseSeatListPage(response).assignments;
  return assignments.get(username.toLowerCase()) ?? { status: 'unassigned' };
}

/** `<apiBaseUrl>/enterprises/<slug><path>` of the enterprise (design §5.6). */
function enterpriseApiUrl(enterprise: SsoEnterprise, path: string): string {
  const { apiBaseUrl, slug } = enterprise.endpoints;
  if (!slug) throw new Error(`${enterprise.id}.github.slug is not configured.`);
  return `${apiBaseUrl}/enterprises/${encodeURIComponent(slug)}${path}`;
}

function seatHeaders(enterprise: SsoEnterprise): Record<string, string> {
  return {
    Authorization: `Bearer ${requireSsoSecret(enterprise, 'seatPat')}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}

async function readSeats(
  enterprise: SsoEnterprise,
  url: string,
  allowNotFound = false,
): Promise<{ res: Response; response: unknown }> {
  const res = await externalFetch(url, { headers: seatHeaders(enterprise) });
  const response = await readJsonOrText(res);
  if (!res.ok && !(allowNotFound && res.status === 404)) {
    const message = isRecord(response) && typeof response.message === 'string' ? response.message : res.statusText;
    throw new Error(`GitHub Copilot seat lookup failed: ${res.status} ${message}`);
  }
  return { res, response };
}

function nextPageUrl(res: Response, currentUrl: string, itemCount: number): string | undefined {
  const link = res.headers.get('link');
  if (link) return nextLinkUrl(link, currentUrl);
  if (itemCount < 100) return undefined;
  const url = new URL(currentUrl);
  url.searchParams.set('page', String(Number(url.searchParams.get('page') ?? 1) + 1));
  return url.href;
}

function nextLinkUrl(link: string, currentUrl: string): string | undefined {
  const next = link.split(',').find((part) => /;\s*rel="next"/.test(part));
  if (!next) return undefined;
  const target = next.match(/<([^>]+)>/)?.[1];
  if (!target) throw new Error('GitHub Copilot seat list returned an invalid pagination link.');
  const url = new URL(target, currentUrl);
  const current = new URL(currentUrl);
  if (url.origin !== current.origin || url.pathname !== current.pathname || url.username || url.password) {
    throw new Error('GitHub Copilot seat list returned an unexpected pagination URL.');
  }
  return url.href;
}

async function mutateCopilotSeat(
  enterprise: SsoEnterprise,
  operation: 'assign' | 'remove',
  ghLogin: string,
): Promise<CopilotSeatMutationResult> {
  const username = ghLogin.trim();
  if (!username) throw new Error('ghLogin is required for Copilot seat management.');
  const res = await externalFetch(enterpriseApiUrl(enterprise, '/copilot/billing/selected_users'), {
    method: operation === 'assign' ? 'POST' : 'DELETE',
    headers: { ...seatHeaders(enterprise), 'Content-Type': 'application/json' },
    body: JSON.stringify({ selected_usernames: [username] }),
  });
  const response = await readJsonOrText(res);
  if (!res.ok) throw mutationError(operation, username, res.status, response);
  assertSeatCount(operation, username, response);
  logger.info(operation, 'GitHub Copilot seat mutation completed', {
    enterpriseId: enterprise.id,
    operation,
    ghLogin: username,
    status: res.status,
  });
  return { ghLogin: username, operation, status: res.status, response };
}

function mutationError(operation: 'assign' | 'remove', username: string, status: number, response: unknown): Error {
  if (operation === 'remove' && isSeatNotAssignedResponse(status, response)) {
    return new CopilotSeatNotAssignedError(username, status, response);
  }
  return new Error(`GitHub Copilot seat ${operation} failed for "${username}": ${status} ${formatResponse(response)}`);
}

function assertSeatCount(operation: 'assign' | 'remove', username: string, response: unknown): void {
  const countField = operation === 'assign' ? 'seats_created' : 'seats_cancelled';
  const count = isRecord(response) ? response[countField] : undefined;
  if (typeof count === 'number' && Number.isInteger(count) && count >= 0) return;
  throw new Error(
    `GitHub accepted the Copilot seat ${operation} request for "${username}", but returned an invalid ${countField}. `
    + 'Import from GH to confirm the seat state.',
  );
}

async function readJsonOrText(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function formatResponse(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseSeatListPage(value: unknown): { itemCount: number; assignments: Map<string, CopilotSeatSnapshot> } {
  if (!isRecord(value) || !Array.isArray(value.seats)) {
    throw new Error('GitHub Copilot seat response does not include a seats array.');
  }
  const assignments = new Map<string, CopilotSeatSnapshot>();
  for (const seat of value.seats) {
    const direct = directSeat(seat);
    if (direct) mergeSeat(assignments, direct.login, direct.seat);
  }
  return { itemCount: value.seats.length, assignments };
}

/** A seat assigned directly to a user; organization and team seats are skipped. */
function directSeat(seat: unknown): { login: string; seat: CopilotSeatSnapshot } | undefined {
  if (!isRecord(seat)) throw new Error('GitHub Copilot seat response includes an invalid seat.');
  const organization = hasSeatSource(seat.organization);
  const team = hasSeatSource(seat.assigning_team);
  if (organization || team || seat.assignee === null) return undefined;
  if (!isRecord(seat.assignee) || typeof seat.assignee.login !== 'string' || !seat.assignee.login.trim()) {
    throw new Error('GitHub direct Copilot seat response includes an invalid assignee.');
  }
  const login = seat.assignee.login.trim().toLowerCase();
  const date = seat.pending_cancellation_date;
  if (date !== null && !isCancellationDate(date)) {
    throw new Error(
      `GitHub direct Copilot seat for "${login}" has a missing or invalid pending_cancellation_date; `
      + 'expected null or YYYY-MM-DD.',
    );
  }
  const snapshot: CopilotSeatSnapshot = date === null
    ? { status: 'assigned' }
    : { status: 'pending_cancellation', pendingCancellationDate: date };
  return { login, seat: snapshot };
}

function hasSeatSource(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (!isRecord(value) || typeof value.id !== 'number' || !Number.isInteger(value.id) || value.id <= 0) {
    throw new Error('GitHub Copilot seat response includes an invalid organization or assigning_team.');
  }
  return true;
}

function mergeSeat(assignments: Map<string, CopilotSeatSnapshot>, login: string, seat: CopilotSeatSnapshot): void {
  const existing = assignments.get(login);
  const differs = existing?.status !== seat.status
    || existing?.pendingCancellationDate !== seat.pendingCancellationDate;
  if (existing && differs) {
    throw new Error(`GitHub returned conflicting direct Copilot seats for "${login}".`);
  }
  assignments.set(login, seat);
}

export function isCancellationDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSeatNotAssignedResponse(status: number, response: unknown): boolean {
  if (status !== 422) return false;
  const message = formatResponse(response).toLowerCase();
  if (!message.includes('seat')) return false;
  return (
    // GitHub reports both "Seat assignment for user X ..." and "One or more seat assignments ...".
    /\buser is not assigned to a seat\b/.test(message)
    || /\b(?:does|do) not have\b/.test(message)
    || /\bwithout (?:a )?(?:github )?copilot seat\b/.test(message)
    || /\bno (?:github )?copilot seat\b/.test(message)
    || /\bnot (?:currently )?assigned\b[^.]{0,80}\b(?:a )?(?:github )?copilot seat\b/.test(message)
    || /\b(?:github )?copilot seat\b[^.]{0,80}\bnot (?:assigned|found)\b/.test(message)
  );
}
