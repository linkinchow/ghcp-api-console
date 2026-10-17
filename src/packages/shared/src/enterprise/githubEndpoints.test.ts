import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  deviceFlowEndpoints,
  githubEndpoints,
  isGheComSignInPage,
  isGitHubDeviceAccountSelectionUrl,
  isGitHubSsoInterstitial,
  isGitHubUrl,
  resolveGithubDeployment,
} from './githubEndpoints.js';

const GITHUB_WEB = 'https://github.com';
const REPO_SRC = fileURLToPath(new URL('../../../../', import.meta.url));

test('derives every §6 endpoint for a github.com profile from its base URL and slug', () => {
  const endpoints = githubEndpoints({ github: { baseUrl: `${GITHUB_WEB}/`, slug: 'acme', shortcode: 'octo' } });
  assert.deepEqual({ ...endpoints }, {
    baseUrl: GITHUB_WEB,
    host: 'github.com',
    isGheCom: false,
    enterpriseSsoUrl: undefined,
    slug: 'acme',
    shortcode: 'octo',
    deviceFlow: {
      deviceCode: `${GITHUB_WEB}/login/device/code`,
      accessToken: `${GITHUB_WEB}/login/oauth/access_token`,
    },
    deviceVerificationUrl: `${GITHUB_WEB}/login/device`,
    apiBaseUrl: 'https://api.github.com',
    copilotApiBaseUrl: 'https://api.githubcopilot.com',
    spEntityId: `${GITHUB_WEB}/enterprises/acme`,
    spAcsUrl: `${GITHUB_WEB}/enterprises/acme/saml/consume`,
    scimBaseUrl: 'https://api.github.com/scim/v2/enterprises/acme',
  });
});

test('derives every §6 endpoint for a GHE.com profile and drops its shortcode', () => {
  const profile = { github: { baseUrl: 'https://Contoso.ghe.com', slug: 'contoso', shortcode: 'octo' } };
  const endpoints = githubEndpoints(profile);
  assert.deepEqual({ ...endpoints }, {
    baseUrl: 'https://contoso.ghe.com',
    host: 'contoso.ghe.com',
    isGheCom: true,
    enterpriseSsoUrl: 'https://contoso.ghe.com/enterprises/contoso/sso',
    slug: 'contoso',
    shortcode: '',
    deviceFlow: {
      deviceCode: 'https://contoso.ghe.com/login/device/code',
      accessToken: 'https://contoso.ghe.com/login/oauth/access_token',
    },
    deviceVerificationUrl: 'https://contoso.ghe.com/login/device',
    apiBaseUrl: 'https://api.contoso.ghe.com',
    copilotApiBaseUrl: 'https://copilot-api.contoso.ghe.com',
    spEntityId: 'https://contoso.ghe.com/enterprises/contoso',
    spAcsUrl: 'https://contoso.ghe.com/enterprises/contoso/saml/consume',
    scimBaseUrl: 'https://api.contoso.ghe.com/scim/v2/enterprises/contoso',
  });
});

test('keeps configured API, SAML and SCIM URLs over the derived defaults', () => {
  const endpoints = githubEndpoints({
    github: {
      baseUrl: 'http://fixture.ghe.com:8002',
      apiBaseUrl: 'http://mock-api:8002/',
      copilotApiBaseUrl: ' http://mock-copilot:8002 ',
      slug: 'local-test',
    },
    sso: {
      spEntityId: 'http://mock-sp/entity',
      spAcsUrl: 'http://mock-sp/acs',
      scimBaseUrl: 'http://mock-api:8002/scim/v2/enterprises/local-test/',
    },
  });
  assert.equal(endpoints.apiBaseUrl, 'http://mock-api:8002');
  assert.equal(endpoints.copilotApiBaseUrl, 'http://mock-copilot:8002');
  assert.equal(endpoints.spEntityId, 'http://mock-sp/entity');
  assert.equal(endpoints.spAcsUrl, 'http://mock-sp/acs');
  assert.equal(endpoints.scimBaseUrl, 'http://mock-api:8002/scim/v2/enterprises/local-test');
});

test('derives GHE.com API hosts with the web origin scheme and port', () => {
  const endpoints = githubEndpoints({ github: { baseUrl: 'http://fixture.ghe.com:8002', slug: 'local-test' } });
  assert.equal(endpoints.apiBaseUrl, 'http://api.fixture.ghe.com:8002');
  assert.equal(endpoints.copilotApiBaseUrl, 'http://copilot-api.fixture.ghe.com:8002');
  assert.equal(endpoints.scimBaseUrl, 'http://api.fixture.ghe.com:8002/scim/v2/enterprises/local-test');
});

test('derives SCIM from a configured API base URL', () => {
  const endpoints = githubEndpoints({ github: { baseUrl: GITHUB_WEB, apiBaseUrl: 'http://mock:8002', slug: 'acme' } });
  assert.equal(endpoints.scimBaseUrl, 'http://mock:8002/scim/v2/enterprises/acme');
});

test('leaves slug-derived endpoints and the shortcode empty when not configured', () => {
  const endpoints = githubEndpoints({ github: { baseUrl: 'http://mock-github:8002' } });
  assert.equal(endpoints.slug, undefined);
  assert.equal(endpoints.shortcode, '');
  assert.equal(endpoints.spEntityId, undefined);
  assert.equal(endpoints.spAcsUrl, undefined);
  assert.equal(endpoints.scimBaseUrl, undefined);
  assert.equal(endpoints.apiBaseUrl, 'https://api.github.com');
  assert.equal(endpoints.deviceVerificationUrl, 'http://mock-github:8002/login/device');
});

test('returns a frozen object and rejects invalid profiles', () => {
  const endpoints = githubEndpoints({ github: { baseUrl: GITHUB_WEB, shortcode: 'octo' } });
  assert.equal(Object.isFrozen(endpoints), true);
  assert.equal(Object.isFrozen(endpoints.deviceFlow), true);
  assert.throws(() => githubEndpoints({ github: { baseUrl: ' ' } }), /github.baseUrl is required/);
  const gheWithoutSlug = { github: { baseUrl: 'https://contoso.ghe.com' } };
  assert.throws(() => githubEndpoints(gheWithoutSlug), /ENTERPRISE_SLUG is required/);
  assert.throws(() => githubEndpoints({ github: { baseUrl: `${GITHUB_WEB}/enterprises/acme` } }), /Use an origin/);
});

test('resolves the legacy deployment and device flow exactly as Login did', () => {
  const github = resolveGithubDeployment(undefined, undefined);
  assert.deepEqual(github, { baseUrl: GITHUB_WEB, host: 'github.com', isGheCom: false });
  assert.deepEqual(deviceFlowEndpoints(github), {
    deviceCode: `${GITHUB_WEB}/login/device/code`,
    accessToken: `${GITHUB_WEB}/login/oauth/access_token`,
  });
  const ghe = resolveGithubDeployment(' https://Sample-Ent.ghe.com/ ', ' sample-ent ');
  assert.equal(ghe.enterpriseSsoUrl, 'https://sample-ent.ghe.com/enterprises/sample-ent/sso');
  assert.throws(() => resolveGithubDeployment('https://sample-ent.ghe.com', ''), /ENTERPRISE_SLUG is required/);
  assert.throws(() => resolveGithubDeployment('sample-ent.ghe.com', 'x'), /Invalid GITHUB_BASE_URL/);
});

test('matches the github.com host and its subdomains only', () => {
  const github = githubEndpoints({ github: { baseUrl: GITHUB_WEB } });
  assert.equal(isGitHubUrl(`${GITHUB_WEB}/login/device`, github), true);
  assert.equal(isGitHubUrl('https://api.github.com/user', github), true);
  assert.equal(isGitHubUrl('https://sample-ent.ghe.com/login/device', github), false);
  assert.equal(isGitHubUrl('https://auth.ghe.com/', github), false);
  assert.equal(isGitHubUrl('https://evilgithub.com/', github), false);
  assert.equal(isGitHubSsoInterstitial(`${GITHUB_WEB}/enterprises/acme/sso`, github), true);
  assert.equal(isGitHubDeviceAccountSelectionUrl(`${GITHUB_WEB}/login/device/select_account`, github), true);
  assert.equal(isGheComSignInPage(`${GITHUB_WEB}/login`, github), false);
});

test('matches the GHE.com host, its subdomains and auth.ghe.com', () => {
  const github = githubEndpoints({ github: { baseUrl: 'https://sample-ent.ghe.com', slug: 'sample-ent' } });
  assert.equal(isGitHubUrl('https://sample-ent.ghe.com/login/device', github), true);
  assert.equal(isGitHubUrl('https://API.sample-ent.ghe.com/user', github), true);
  assert.equal(isGitHubUrl('https://auth.ghe.com/login', github), true);
  assert.equal(isGitHubUrl('https://other-ent.ghe.com/login', github), false);
  assert.equal(isGitHubUrl('https://evilsample-ent.ghe.com/login', github), false);
  assert.equal(isGitHubUrl(`${GITHUB_WEB}/login`, github), false);
  assert.equal(isGitHubUrl('http://10.0.0.4:7001/login', github), false);
  assert.equal(isGitHubUrl('not a url', github), false);
  const sso = 'https://sample-ent.ghe.com/enterprises/sample-ent/sso?return_to=%2Flogin%2Fdevice';
  assert.equal(isGitHubSsoInterstitial(sso, github), true);
  assert.equal(isGitHubSsoInterstitial('http://10.0.0.4:7001/sso?SAMLRequest=x', github), false);
  const selectAccount = 'https://sample-ent.ghe.com/login/device/select_account';
  assert.equal(isGitHubDeviceAccountSelectionUrl(selectAccount, github), true);
  assert.equal(isGheComSignInPage('https://sample-ent.ghe.com/login/?return_to=%2Flogin%2Fdevice', github), true);
  assert.equal(isGheComSignInPage('https://sample-ent.ghe.com/session', github), true);
  assert.equal(isGheComSignInPage('https://auth.ghe.com/login', github), true);
  assert.equal(isGheComSignInPage('https://sample-ent.ghe.com/login/device', github), false);
  assert.equal(isGheComSignInPage('https://sample-ent.ghe.com/login/oauth/authorize', github), false);
});

// The github.com web origin may only be named by default-derivation code (design §6 / §9.1).
const ALLOWED_GITHUB_WEB_FILES = new Set([
  // Baseline single-enterprise default for GITHUB_BASE_URL, consumed by the env-synthesised default enterprise.
  'packages/shared/src/github.ts',
]);

test('names the github.com web origin only in default derivation and tests', () => {
  assert.deepEqual(githubWebLiteralOffenders(), []);
});

function githubWebLiteralOffenders(): string[] {
  return sourceFiles(REPO_SRC)
    .map((file) => relative(REPO_SRC, file).split(sep).join('/'))
    .filter((file) => !file.endsWith('.test.ts') && !ALLOWED_GITHUB_WEB_FILES.has(file))
    .flatMap((file) => literalLines(file));
}

function literalLines(file: string): string[] {
  const lines = readFileSync(join(REPO_SRC, file), 'utf8').split('\n');
  return lines.flatMap((line, index) => (line.includes(GITHUB_WEB) ? [`${file}:${index + 1}`] : []));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}
