import { JsonHttpClient, type BatchResult, type EnsureSsoUserRequest, type EnsureSsoUserResponse, type SsoUserBatchRow, type SsoUserDto } from '@ghcp/shared';
import { config } from '../config.js';
import { loadProxyEnterpriseProfile } from '../enterprise.js';

function scopedClient(enterpriseId?:string) {
  const profile=loadProxyEnterpriseProfile(enterpriseId);
  return {profile,client:new JsonHttpClient({baseUrl:profile.routes.ssoInternalUrl,internalToken:config.internalApiToken}),
    path:`/api/profiles/${encodeURIComponent(profile.id)}`,
    headers:{'x-enterprise-id':profile.id,'x-enterprise-revision':String(profile.revision)}};
}
export async function ensureSsoUser(request: EnsureSsoUserRequest,enterpriseId?:string): Promise<EnsureSsoUserResponse> {
  const {client,path,headers}=scopedClient(enterpriseId);
  return client.request<EnsureSsoUserResponse>(`${path}/users/ensure`,{method:'POST',body:request,headers,redirect:'error'});
}
export async function getSsoUser(ssoUser:string,enterpriseId?:string):Promise<SsoUserDto> {
  const {client,path,headers}=scopedClient(enterpriseId);
  return client.request<SsoUserDto>(`${path}/users/${encodeURIComponent(ssoUser)}`,{headers,redirect:'error'});
}
export async function syncEmuUser(ssoUser:string,options:{assignCopilotSeat?:boolean;enterpriseId?:string}={}):Promise<SsoUserDto> {
  const {client,path,headers}=scopedClient(options.enterpriseId);
  const result=await client.request<BatchResult<SsoUserBatchRow>>(`${path}/users/batch`,{method:'POST',headers,redirect:'error',
    body:{operation:'sync_emu',ssoUsers:[ssoUser],...(options.assignCopilotSeat?{assignCopilotSeat:true}:{})}});
  const row=result.rows[0];
  if (!row || row.status==='failed' || !row.user) throw new Error('sso_sync_failed');
  return row.user;
}
