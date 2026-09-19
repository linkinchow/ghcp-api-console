import { JsonHttpClient, type CreateLoginTaskV2, type LoginTaskDto } from '@ghcp/shared';
import { loadProxyEnterpriseProfile } from '../enterprise.js';
import { config } from '../config.js';

export async function createLoginTask(request: CreateLoginTaskV2): Promise<LoginTaskDto> {
  const profile=loadProxyEnterpriseProfile(request.enterpriseId);
  if (profile.revision!==request.enterpriseRevision) throw new Error('enterprise_revision_mismatch');
  const client=new JsonHttpClient({baseUrl:profile.routes.loginInternalUrl,internalToken:config.internalApiToken});
  return client.request<LoginTaskDto>(`/api/profiles/${encodeURIComponent(profile.id)}/tasks`,{
    method:'POST',body:request,redirect:'error',
  });
}
