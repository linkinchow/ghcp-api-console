import assert from 'node:assert/strict';
import test from 'node:test';
import { GithubSubjectError, verifyGithubSubject } from './githubSubject.js';

const API = 'https://api.github.example.test';

function fetcher(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond(String(input), init);
  }) as typeof fetch;
  return { fn, calls };
}

function failsWith(code: GithubSubjectError['code']) {
  return (error: unknown) => error instanceof GithubSubjectError && error.code === code;
}

test('asks GitHub /user with the token and returns login and numeric ID', async () => {
  const { fn, calls } = fetcher(() => Response.json({ login: 'Admin_Synthetic', id: 101, email: 'ignored' }));
  assert.deepEqual(await verifyGithubSubject(`${API}/`, 'synthetic-token', undefined, fn), { login: 'Admin_Synthetic', id: '101' });
  assert.equal(calls[0]!.url, `${API}/user`);
  assert.equal(new Headers(calls[0]!.init?.headers).get('authorization'), 'Bearer synthetic-token');
  assert.equal(calls[0]!.init?.redirect, 'error');
});

test('HTTP and network failures are "unavailable"; malformed bodies are "invalid"', async () => {
  await assert.rejects(
    verifyGithubSubject(API, 'token', undefined, fetcher(() => new Response('denied', { status: 401 })).fn),
    failsWith('github_subject_unavailable'),
  );
  await assert.rejects(
    verifyGithubSubject(API, 'token', undefined, fetcher(() => { throw new Error('private network detail'); }).fn),
    failsWith('github_subject_unavailable'),
  );
  for (const body of ['not json', '[]', '{"login":"bad login","id":1}', '{"login":"ok","id":0}', '{"login":"ok"}']) {
    await assert.rejects(
      verifyGithubSubject(API, 'token', undefined, fetcher(() => new Response(body)).fn),
      failsWith('github_subject_invalid'),
    );
  }
});

test('oversized responses are refused without being read into memory', async () => {
  const declared = new Response('{}', { headers: { 'Content-Length': String(64 * 1024 + 1) } });
  await assert.rejects(verifyGithubSubject(API, 'token', undefined, fetcher(() => declared).fn), failsWith('github_subject_unavailable'));
  const streamed = new Response(JSON.stringify({ login: 'admin', id: 1, padding: 'x'.repeat(70 * 1024) }));
  await assert.rejects(verifyGithubSubject(API, 'token', undefined, fetcher(() => streamed).fn), failsWith('github_subject_invalid'));
});
