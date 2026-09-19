import { externalFetch } from '../clients/externalFetch.js';
import { ExternalOperationUncertainError } from '../users/operationFence.js';
import type { EnterpriseScope } from '@ghcp/shared';
import { loggerFor } from '@ghcp/shared';
import { getScopeProfile } from '../enterprise.js';
import { readEnterpriseSecret } from '@ghcp/shared/enterpriseRuntimeV3';

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

export async function assignCopilotSeat(ghLogin: string, scope: EnterpriseScope): Promise<CopilotSeatMutationResult> {
  return mutateCopilotSeat('assign', ghLogin, scope);
}

export async function removeCopilotSeat(ghLogin: string, scope: EnterpriseScope): Promise<CopilotSeatMutationResult> {
  return mutateCopilotSeat('remove', ghLogin, scope);
}

export async function listCopilotSeatAssignments(scope: EnterpriseScope): Promise<Set<string>> {
  if (!readEnterpriseSecret(getScopeProfile(scope).sso.seatPatRef)) throw new Error('GITHUB_COPILOT_SEAT_PAT is required to list Copilot seats.');
  const assignedGhLogins = new Set<string>();
  let page = 1;
  let seatsRead = 0;
  while (true) {
    const res = await externalFetch(`${copilotSeatsUrl(scope)}?per_page=100&page=${page}`, {
      redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
        Authorization: `Bearer ${readEnterpriseSecret(getScopeProfile(scope).sso.seatPatRef)}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
    });
    const response = await readJsonOrText(res);
    if (!res.ok) throw new Error(`GitHub Copilot seat list failed: ${res.status}`);
    const seatPage = parseSeatListPage(response);
    for (const ghLogin of seatPage.ghLogins) assignedGhLogins.add(ghLogin.toLowerCase());
    seatsRead += seatPage.itemCount;
    if (seatPage.itemCount < 100 || (seatPage.totalSeats !== undefined && seatsRead >= seatPage.totalSeats)) break;
    page += 1;
  }
  logger.info('list', 'Listed GitHub Copilot seat assignments', { assignedSeats: assignedGhLogins.size, pages: page, enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision });
  return assignedGhLogins;
}

async function mutateCopilotSeat(operation: 'assign' | 'remove', ghLogin: string, scope: EnterpriseScope): Promise<CopilotSeatMutationResult> {
  const username = ghLogin.trim();
  if (!username) throw new Error('ghLogin is required for Copilot seat management.');
  if (!readEnterpriseSecret(getScopeProfile(scope).sso.seatPatRef)) throw new Error('GITHUB_COPILOT_SEAT_PAT is required for Copilot seat management.');
  const method = operation === 'assign' ? 'POST' : 'DELETE';
  const res = await externalFetch(copilotSelectedUsersUrl(scope), {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${readEnterpriseSecret(getScopeProfile(scope).sso.seatPatRef)}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2026-03-10',
    },
    body: JSON.stringify({ selected_usernames: [username] }),
  });
  let response: unknown;
  try { response = await readJsonOrText(res); } catch { throw new ExternalOperationUncertainError(); }
  if (!res.ok) {
    if (operation === 'remove' && isSeatNotAssignedResponse(res.status, response)) {
      throw new CopilotSeatNotAssignedError(username, res.status, response);
    }
    throw new Error(`GitHub Copilot seat ${operation} failed for "${username}": ${res.status}`);
  }
  logger.info(operation, 'GitHub Copilot seat mutation completed', { operation, ghLogin: username, status: res.status, enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision });
  return { ghLogin: username, operation, status: res.status, response };
}

function copilotSelectedUsersUrl(scope: EnterpriseScope): string {
  return `${getScopeProfile(scope).sso.githubApiBaseUrl.replace(/\/+$/, '')}/enterprises/${encodeURIComponent(getScopeProfile(scope).slug)}/copilot/billing/selected_users`;
}

function copilotSeatsUrl(scope: EnterpriseScope): string {
  return `${getScopeProfile(scope).sso.githubApiBaseUrl.replace(/\/+$/, '')}/enterprises/${encodeURIComponent(getScopeProfile(scope).slug)}/copilot/billing/seats`;
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

function parseSeatListPage(value: unknown): { totalSeats?: number; itemCount: number; ghLogins: string[] } {
  if (!value || typeof value !== 'object') throw new Error('GitHub Copilot seat list returned an invalid response.');
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.seats)) throw new Error('GitHub Copilot seat list response does not include seats.');
  const ghLogins: string[] = [];
  for (const seat of body.seats) {
    if (!seat || typeof seat !== 'object') continue;
    const assignee = (seat as Record<string, unknown>).assignee;
    if (!assignee || typeof assignee !== 'object') continue;
    const login = (assignee as Record<string, unknown>).login;
    if (typeof login === 'string' && login.trim()) ghLogins.push(login.trim());
  }
  return {
    totalSeats: typeof body.total_seats === 'number' ? body.total_seats : undefined,
    itemCount: body.seats.length,
    ghLogins,
  };
}

function isSeatNotAssignedResponse(status: number, response: unknown): boolean {
  if (status !== 422) return false;
  const message = formatResponse(response).toLowerCase();
  if (!message.includes('seat')) return false;
  return (
    /\bseat assignment\b[^.]{0,120}\buser is not assigned to a seat\b/.test(message)
    || /\b(?:does|do) not have\b/.test(message)
    || /\bwithout (?:a )?(?:github )?copilot seat\b/.test(message)
    || /\bno (?:github )?copilot seat\b/.test(message)
    || /\bnot (?:currently )?assigned\b[^.]{0,80}\b(?:a )?(?:github )?copilot seat\b/.test(message)
    || /\b(?:github )?copilot seat\b[^.]{0,80}\bnot (?:assigned|found)\b/.test(message)
  );
}
