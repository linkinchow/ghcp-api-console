import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { after } from 'node:test';
import Database from 'better-sqlite3';
import { parseEnterpriseRegistryV3, type EnterpriseProfileV3, type EnterpriseRegistryV3, type CreateLoginTaskV2 } from '@ghcp/shared';
import { initEnterpriseSqliteV3 } from '@ghcp/shared/enterpriseStorageV3';

export const SECOND_ENTERPRISE = '3e316a51-3f1f-43ce-909c-aac7e5e9d546';
export function loginRegistryFixture(): EnterpriseRegistryV3 {
  const id = 'a2793f03-dafd-4e59-89cf-587b1673d30b';
  const profiles = [id,SECOND_ENTERPRISE].map((enterpriseId,index) => {
    const root = 'https://sso.test',base = index ? `${root}/profiles/${enterpriseId}` : root;
    return {
      id:enterpriseId,slug:index ? 'second-enterprise' : 'test-enterprise',shortcode:index ? 'sec' : 'test',
      accountDomain:'pool.example.com',revision:1,maxAccounts:100,
      routes:{proxyInternalUrl:process.env.PROXY_BASE_URL ?? 'https://proxy.test',ssoInternalUrl:'http://sso.test:7001',loginInternalUrl:'http://login.test:7003',ssoPublicUrl:root},
      sso:{entityId:`${base}/metadata`,ssoUrl:`${base}/sso`,loginUrl:`${base}/login`,logoutUrl:`${base}/logout`,
        spEntityId:`https://github.com/enterprises/${index ? 'second-enterprise' : 'test-enterprise'}`,spAcsUrl:'https://github.com/saml/consume',
        scimBaseUrl:`https://api.github.com/scim/v2/enterprises/${index ? 'second-enterprise' : 'test-enterprise'}`,githubApiBaseUrl:'https://api.github.com',
        emailDomain:'example.com',userPrefix:'pool',signingCertRef:{env:'TEST_CERT'},signingKeyRef:{env:'TEST_KEY'},sessionSecretRef:{env:'TEST_SESSION'}},
      login:{provider:'custom',allowedLoginUrls:[`${base}/login`],selectors:{}},
    };
  });
  return parseEnterpriseRegistryV3({version:3,registryRevision:1,legacyEnterpriseId:id,profiles});
}
export function initLoginFixture(): EnterpriseProfileV3 {
  const directory = mkdtempSync(join(tmpdir(),'login-enterprise-v3-test-'));
  process.env.DOTENV_CONFIG_PATH = join(directory,'missing.env');
  const registry = loginRegistryFixture();
  const profile = registry.profiles.find(item => item.id === registry.legacyEnterpriseId)!;
  process.env.DB_PATH = join(directory,'login.sqlite');
  process.env.ENTERPRISE_REGISTRY_FILE = join(directory,'registry.json');
  process.env.LOG_DIR = join(directory,'logs');
  process.env.AUTH_DEBUG_ARTIFACT_DIR = join(directory,'artifacts');
  writeFileSync(process.env.ENTERPRISE_REGISTRY_FILE,JSON.stringify(registry));
  const db = new Database(process.env.DB_PATH);
  try { initEnterpriseSqliteV3(db,'login',registry); } finally { db.close(); }
  after(async () => {
    const {getDb} = await import('./connection.js');
    try { getDb().close(); } catch { /* Gate tests intentionally reject incomplete DBs. */ }
    rmSync(directory,{recursive:true,force:true});
  });
  return profile;
}
export function loginRequest(profile: Pick<EnterpriseProfileV3,'id'|'revision'>,overrides: Partial<CreateLoginTaskV2> = {}): CreateLoginTaskV2 {
  return {enterpriseId:profile.id,enterpriseRevision:profile.revision,identity:`identity-${randomUUID()}`,accountIncarnation:randomUUID(),
    oauthAttemptId:randomUUID(),expectedGhLogin:'same-name_test',expectedGithubUserId:'42',ssoUser:'same-name',ssoPassword:'synthetic-password',ssoType:'custom',...overrides};
}
