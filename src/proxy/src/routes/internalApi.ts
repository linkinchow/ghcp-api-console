import { Router, type Request, type Response } from 'express';
import { apiError, ENTERPRISE_V4_CAPABILITY, parseAuthorizationBinding, EnterpriseContractError, type AuthorizationBinding } from '@ghcp/shared';
import { loadProxyEnterpriseRegistry, requestEnterpriseProfile, requireEnterpriseRequest } from '../enterprise.js';
import { clearModelsCache } from '../copilot/copilotClient.js';
import { deleteAccountsBySsoUser, getAccount, toAccountDto } from '../db/accountsRepo.js';
import { getStorage, initializeStorage } from '../db/connection.js';
import { AccountScopeError } from '../db/storageTypes.js';
import { completeVerifiedAuthorization } from '../accounts/authorization.js';
import { getUserPool } from '../userPool/runtime.js';

export const internalApiRouter = Router();
internalApiRouter.use(requireEnterpriseRequest);
const scoped='/profiles/:enterpriseId';
internalApiRouter.get(['/enterprise',`${scoped}/enterprise`],async(req,res)=>{
  const profile=requestEnterpriseProfile(req);
  res.setHeader('Cache-Control','no-store');
  res.json({enterpriseId:profile.id,id:profile.id,slug:profile.slug,shortcode:profile.shortcode,
    accountDomain:profile.accountDomain,revision:profile.revision,enterpriseRevision:profile.revision,
    legacyEnterpriseId:loadProxyEnterpriseRegistry().legacyEnterpriseId,
    capability:ENTERPRISE_V4_CAPABILITY,schemaVersion:4,contractVersion:2});
});

// Dangerous contract-1 callbacks are rejected, not silently promoted to a fresh
// binding by reading the current account (which would defeat incarnation fencing).
internalApiRouter.put('/accounts/:identity/copilot-oauth-token',(_req,res)=>{
  res.status(426).json(apiError('authorization_binding_required','Use the scoped contract-2 authorization attempt endpoint.'));
});
internalApiRouter.post('/accounts/:identity/mark-copilot-oauth-failed',(_req,res)=>{
  res.status(426).json(apiError('authorization_binding_required','Use the scoped contract-2 authorization attempt endpoint.'));
});

const attemptPath=`${scoped}/accounts/:identity/authorization-attempts/:oauthAttemptId`;
internalApiRouter.get(attemptPath,async(req,res)=>{
  try {
    const profile=requestEnterpriseProfile(req);await initializeStorage();
    const attempt=await getStorage().getAuthorizationAttempt(profile.id,String(req.params.identity),req.params.oauthAttemptId);
    if (!attempt) {
      res.status(404).json(apiError('authorization_attempt_not_found','Authorization attempt was not found.'));return;
    }
    assertTupleSources(req,attempt.binding);
    // Terminal ledger evidence belongs to the immutable old binding, even after
    // deletion/recreation. Reading it never grants permission for stale callbacks.
    if (attempt.status==='active') {
      const account=await getAccount(String(req.params.identity),profile.id);
      if (!account || account.accountIncarnation!==attempt.binding.accountIncarnation) {
        res.status(404).json(apiError('authorization_attempt_not_found','Authorization attempt was not found.'));return;
      }
    }
    res.setHeader('Cache-Control','no-store');res.json({binding:attempt.binding,status:attempt.status});
  } catch(error) {sendAuthorizationError(res,error);}
});

function callbackBinding(req:Request,keys:string[]):AuthorizationBinding {
  const body=req.body;
  if (!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(key=>!keys.includes(key))) throw new AccountScopeError('invalid_authorization_payload');
  const binding=parseAuthorizationBinding(body.binding),profile=requestEnterpriseProfile(req);
  if (binding.enterpriseId!==profile.id || binding.enterpriseRevision!==profile.revision) throw new AccountScopeError('enterprise_scope_mismatch');
  if (binding.identity!==String(req.params.identity) || binding.oauthAttemptId!==req.params.oauthAttemptId) throw new AccountScopeError('authorization_path_mismatch');
  assertTupleSources(req,binding);return binding;
}
function assertTupleSources(req:Request,binding:AuthorizationBinding):void {
  for (const source of [req.query,req.body]) {
    if (!source || typeof source!=='object') continue;
    for (const key of ['identity','accountIncarnation','oauthAttemptId','expectedGhLogin','expectedGithubUserId'] as const) {
      if (Object.hasOwn(source,key) && source[key]!==binding[key]) throw new AccountScopeError('authorization_path_mismatch');
    }
  }
  for (const [header,key] of [['x-account-incarnation','accountIncarnation'],['x-oauth-attempt-id','oauthAttemptId'],['x-user-identity','identity']] as const) {
    if (req.headers[header]!==undefined && req.headers[header]!==binding[key]) throw new AccountScopeError('authorization_path_mismatch');
  }
}
async function success(req:Request,res:Response):Promise<void> {
  try {
    const binding=callbackBinding(req,['binding','copilotOauthToken']),token=req.body.copilotOauthToken;
    if (typeof token!=='string' || !token || token!==token.trim() || token.length>16384 || /[\x00-\x20\x7f]/.test(token)) throw new AccountScopeError('invalid_oauth_token');
    await initializeStorage();
    const result=await completeVerifiedAuthorization(getStorage(),binding,token);
    clearModelsCache(binding.identity);res.setHeader('Cache-Control','no-store');res.json(result);
  } catch(error) {sendAuthorizationError(res,error);}
}
internalApiRouter.post(`${attemptPath}/success`,success);
internalApiRouter.put(`${attemptPath}/success`,success);
for (const [suffix,status] of [['failure','failed'],['fail','failed'],['cancel','cancelled']] as const) {
  internalApiRouter.post(`${attemptPath}/${suffix}`,async(req,res)=>{
    try {
      const binding=callbackBinding(req,status==='failed'?['binding','failureReason']:['binding']);
      await initializeStorage();
      const reason=req.body.failureReason;
      if (reason!==undefined && typeof reason!=='string') throw new AccountScopeError('invalid_authorization_failure_reason');
      const result=await getStorage().endAuthorizationAttempt(binding,status,reason);
      res.setHeader('Cache-Control','no-store');res.json(result);
    } catch(error) {sendAuthorizationError(res,error);}
  });
}

internalApiRouter.get(['/accounts/:identity/login-task-protection',`${scoped}/accounts/:identity/login-task-protection`],async(req,res)=>{
  const profile=requestEnterpriseProfile(req),account=await getAccount(String(req.params.identity),profile.id);
  const member=account ? await (await getUserPool())?.inventory(String(req.params.identity)) : undefined;
  const taskId=typeof req.query.taskId==='string'?req.query.taskId:undefined;
  const attempt=typeof req.query.oauthAttemptId==='string'?req.query.oauthAttemptId:undefined;
  if (req.query.accountIncarnation!==undefined && req.query.accountIncarnation!==account?.accountIncarnation) {
    res.status(409).json(apiError('stale_authorization_binding','Account incarnation differs.'));return;
  }
  const referenced=Boolean(member && !['warmup','ready'].includes(member.stage) && ((taskId && member.task_id===taskId)||(attempt && member.oauth_attempt_id===attempt)));
  res.setHeader('Cache-Control','no-store');res.json({enterpriseId:profile.id,enterpriseRevision:profile.revision,contractVersion:2,managed:Boolean(member),referenced});
});

internalApiRouter.get(['/accounts/by-sso-user/:ssoUser/pool-membership',`${scoped}/accounts/by-sso-user/:ssoUser/pool-membership`],async(req,res)=>{
  const profile=requestEnterpriseProfile(req);
  await initializeStorage();
  const managed=await (await getUserPool())?.managesSsoUser(String(req.params.ssoUser),profile.id)??false;
  res.setHeader('Cache-Control','no-store');res.json({enterpriseId:profile.id,enterpriseRevision:profile.revision,contractVersion:2,managed});
});
internalApiRouter.delete(['/accounts/by-sso-user/:ssoUser',`${scoped}/accounts/by-sso-user/:ssoUser`],async(req,res)=>{
  const profile=requestEnterpriseProfile(req),result=await deleteAccountsBySsoUser(String(req.params.ssoUser),profile.id);
  res.json({...result,enterpriseId:profile.id,enterpriseRevision:profile.revision,contractVersion:2});
});
internalApiRouter.get(`${scoped}/accounts/:identity`,async(req,res)=>{
  const profile=requestEnterpriseProfile(req),account=await getAccount(String(req.params.identity),profile.id);
  if (!account) {res.status(404).json(apiError('account_not_found','Proxy account was not found.'));return;}
  res.json(toAccountDto(account));
});
async function getStorageAfterInit() {await initializeStorage();return getStorage();}
function sendAuthorizationError(res:Response,error:unknown):void {
  if (error instanceof AccountScopeError || error instanceof EnterpriseContractError) {
    const status=error.code.startsWith('github_subject_')?502:error.code.startsWith('invalid_')||error.code.includes('path_mismatch')?400:409;
    res.status(status).json(apiError(error.code,'Authorization could not be applied.'));return;
  }
  res.status(503).json(apiError('authorization_unavailable','Authorization state is unavailable.'));
}
