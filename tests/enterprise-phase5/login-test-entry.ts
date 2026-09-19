import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadFixtureConfig } from './mock-provider.mjs';
import type { RuntimeTaskPayload } from '../../src/login/src/tasks/runner.js';

/** Only this out-of-production entry replaces authorization; authority, queue, DB and callback remain real. */
export function createSyntheticAuthorizer(fixture: ReturnType<typeof loadFixtureConfig>) {
  const {state,registry} = fixture;
  return async (_options: unknown, payload: RuntimeTaskPayload, _logger: unknown, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted();
    const profile = registry.profiles.find((p: {id: string}) => p.id === payload.enterpriseId);
    if (!profile || profile.revision !== payload.enterpriseRevision || profile.sso.loginUrl !== payload.profile.sso.loginUrl
      || profile.sso.githubApiBaseUrl !== payload.profile.sso.githubApiBaseUrl) throw new Error('phase5_authorization_scope_invalid');
    const {enterpriseId,enterpriseRevision,identity,accountIncarnation,oauthAttemptId,expectedGhLogin,expectedGithubUserId} = payload;
    const binding = {enterpriseId,enterpriseRevision,identity,accountIncarnation,oauthAttemptId,expectedGhLogin,
      ...(expectedGithubUserId === undefined ? {} : {expectedGithubUserId})};
    const response = await fetch('http://provider:8000/fixture/authorize',{
      method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(30_000)]),
      headers:{authorization:`Bearer ${state.credentials.fixtureToken}`,'content-type':'application/json'},
      body:JSON.stringify({binding,ssoUser:payload.ssoUser,ssoPassword:payload.ssoPassword}),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`phase5_authorize_http_${response.status}`); }
    const body = await response.json() as {token?: unknown};
    if (typeof body.token !== 'string' || !/^phase5_[a-f0-9]{32}$/.test(body.token)) throw new Error('phase5_authorize_invalid_response');
    return body.token;
  };
}

export async function startSyntheticLogin(): Promise<void> {
  // Guard before importing production modules (which read environment and open SQLite lazily).
  const fixture=loadFixtureConfig();
  if (resolve(process.env.ENTERPRISE_REGISTRY_FILE ?? '') !== resolve(fixture.state.registryFile)) throw new Error('phase5_login_registry_mismatch');
  if (process.env.INTERNAL_API_TOKEN !== fixture.state.credentials.internalApiToken || process.env.PORT !== '7003'
    || process.env.DB_PATH !== '/data/login.sqlite' || process.env.PROXY_BASE_URL !== 'http://proxy-lb:3000'
    || process.env.LOG_DIR !== '/data/logs') throw new Error('phase5_login_environment_mismatch');
  const [{LoginQueue},{runLoginTask},{startServer}] = await Promise.all([
    import('../../src/login/src/tasks/queue.js'),import('../../src/login/src/tasks/runner.js'),import('../../src/login/src/server.js'),
  ]);
  const authorize=createSyntheticAuthorizer(fixture);
  const queue=new LoginQueue({runLoginTask:(task,payload,signal)=>runLoginTask(task,payload,signal,{authorize})});
  startServer(queue);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startSyntheticLogin();
}
