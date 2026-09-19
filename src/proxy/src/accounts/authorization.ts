import { bindingKey, parseAuthorizationBinding, type AuthorizationBinding, type EnterpriseProfileV3 } from '@ghcp/shared';
import { loadProxyEnterpriseProfile } from '../enterprise.js';
import { AccountScopeError, type AuthorizationResult, type ProxyStorage, type VerifiedGithubSubject } from '../db/storageTypes.js';
import { assertSameBinding, assertSubject } from '../db/authorizationLedger.js';

/** Token validation uses a deployment-pinned origin only; Login never supplies a URL or trusted subject. */
export async function verifyGithubSubject(profile: EnterpriseProfileV3,token: string,fetcher: typeof fetch=fetch,
  signal: AbortSignal=AbortSignal.timeout(15000)): Promise<VerifiedGithubSubject> {
  let response: Response;
  try {
    response=await abortable(fetcher(`${profile.sso.githubApiBaseUrl}/user`,{ method:'GET',redirect:'error',signal,
      headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'User-Agent':'ghcp-proxy-authorization'} }),signal);
  } catch { throw new AccountScopeError('github_subject_unavailable'); }
  if (!response.ok || response.redirected || Number(response.headers.get('content-length')??0)>65536) {
    void response.body?.cancel().catch(()=>{}); throw new AccountScopeError('github_subject_unavailable');
  }
  const reader=response.body?.getReader();
  if (!reader) throw new AccountScopeError('github_subject_invalid');
  const chunks:Uint8Array[]=[];let length=0;
  try {
    while (true) {
      signal.throwIfAborted(); const part=await abortable(reader.read(),signal); if (part.done) break;
      length+=part.value.length;if (length>65536) throw new Error('too_large'); chunks.push(part.value);
    }
    const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error();
    const {login,id}=value as {login?:unknown;id?:unknown};
    if (typeof login!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(login)) throw new Error();
    const githubId=typeof id==='number' && Number.isSafeInteger(id) && id>0 ? String(id) : typeof id==='string' && /^[1-9]\d{0,19}$/.test(id) ? id : undefined;
    if (!githubId) throw new Error();
    return {login,id:githubId};
  } catch { throw new AccountScopeError('github_subject_invalid'); }
  finally { void reader.cancel().catch(()=>{}); reader.releaseLock(); }
}

function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason??new Error('authorization_timeout'));
    signal.addEventListener('abort',abort,{once:true});
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

export async function completeVerifiedAuthorization(storage: ProxyStorage,value: AuthorizationBinding,token: string,
  dependencies: {profile?: EnterpriseProfileV3;fetch?: typeof fetch}={}): Promise<AuthorizationResult> {
  const binding=parseAuthorizationBinding(value);
  const profile=dependencies.profile??loadProxyEnterpriseProfile(binding.enterpriseId);
  if (profile.id!==binding.enterpriseId || profile.revision!==binding.enterpriseRevision) throw new AccountScopeError('enterprise_revision_mismatch');
  const attempt=await storage.getAuthorizationAttempt(binding.enterpriseId,binding.identity,binding.oauthAttemptId);
  assertSameBinding(attempt,binding);
  const account=await storage.getAccount(binding.identity,binding.enterpriseId);
  if (!account || account.accountIncarnation!==binding.accountIncarnation || account.ghLogin!==binding.expectedGhLogin) throw new AccountScopeError('stale_authorization_binding');
  if (attempt.status!=='active' && attempt.status!=='succeeded') throw new AccountScopeError('authorization_outcome_conflict');
  // Durable same-payload evidence makes lost-ACK retries independent of upstream
  // availability. The repository checks the private digest and incarnation again.
  if (attempt.status==='succeeded') {
    if (!attempt.resultSubject) throw new AccountScopeError('authorization_evidence_missing');
    return storage.completeAuthorizationAttempt(binding,token,attempt.resultSubject);
  }
  if (account.copilotOauthAttemptId!==binding.oauthAttemptId) throw new AccountScopeError('stale_authorization_binding');
  // No SQL lock spans external I/O. The complete operation rechecks full binding,
  // active ledger, incarnation and nonce atomically after this bounded request.
  const subject=await verifyGithubSubject(profile,token,dependencies.fetch);
  assertSubject(binding,subject);
  return storage.completeAuthorizationAttempt(binding,token,subject);
}
