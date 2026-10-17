const MAX_USER_RESPONSE_BYTES = 64 * 1024;
const GITHUB_LOGIN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const GITHUB_USER_ID = /^[1-9]\d{0,19}$/;

export interface GithubSubject {
  login: string;
  /** Numeric GitHub user ID as a decimal string. */
  id: string;
}

export type GithubSubjectErrorCode = 'github_subject_unavailable' | 'github_subject_invalid';

export class GithubSubjectError extends Error {
  constructor(readonly code: GithubSubjectErrorCode) {
    super(code);
    this.name = 'GithubSubjectError';
  }
}

/**
 * Asks GitHub who owns `token` (GET /user). Used to prove a configured credential belongs to the
 * expected account before it is used. Responses are size-bounded and never echoed back.
 */
export async function verifyGithubSubject(
  apiBaseUrl: string,
  token: string,
  signal: AbortSignal = AbortSignal.timeout(15_000),
  fetcher: typeof fetch = fetch,
): Promise<GithubSubject> {
  let response: Response;
  try {
    response = await fetcher(`${apiBaseUrl.replace(/\/+$/, '')}/user`, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'ghcp-proxy',
      },
    });
  } catch {
    throw new GithubSubjectError('github_subject_unavailable');
  }

  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (!response.ok || declaredLength > MAX_USER_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new GithubSubjectError('github_subject_unavailable');
  }

  try {
    const body = await readBounded(response, MAX_USER_RESPONSE_BYTES);
    return parseSubject(JSON.parse(body));
  } catch {
    throw new GithubSubjectError('github_subject_invalid');
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('missing body');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) throw new Error('response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseSubject(value: unknown): GithubSubject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
  const { login, id } = value as { login?: unknown; id?: unknown };
  if (typeof login !== 'string' || !GITHUB_LOGIN.test(login)) throw new Error('invalid login');
  const userId = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id)
    : typeof id === 'string' && GITHUB_USER_ID.test(id) ? id
    : undefined;
  if (!userId) throw new Error('invalid id');
  return { login, id: userId };
}
