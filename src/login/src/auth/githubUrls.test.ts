import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deviceFlowEndpoints,
  isGheComSignInPage,
  isGitHubDeviceAccountSelectionUrl,
  isGitHubSsoInterstitial,
  isGitHubUrl,
  resolveGithubDeployment,
} from './githubUrls.js';

test('defaults to github.com without an enterprise SSO entry page', () => {
  const github = resolveGithubDeployment(undefined, undefined);
  assert.deepEqual(github, { baseUrl: 'https://github.com', host: 'github.com', isGheCom: false });
  assert.deepEqual(deviceFlowEndpoints(github), {
    deviceCode: 'https://github.com/login/device/code',
    accessToken: 'https://github.com/login/oauth/access_token',
  });
});

test('derives GHE.com device flow endpoints and the enterprise SSO URL from config', () => {
  const github = resolveGithubDeployment(' https://Sample-Ent.ghe.com/ ', ' sample-ent ');
  assert.deepEqual(github, {
    baseUrl: 'https://sample-ent.ghe.com',
    host: 'sample-ent.ghe.com',
    isGheCom: true,
    enterpriseSsoUrl: 'https://sample-ent.ghe.com/enterprises/sample-ent/sso',
  });
  assert.deepEqual(deviceFlowEndpoints(github), {
    deviceCode: 'https://sample-ent.ghe.com/login/device/code',
    accessToken: 'https://sample-ent.ghe.com/login/oauth/access_token',
  });
});

test('rejects GHE.com without ENTERPRISE_SLUG and non-origin base URLs', () => {
  assert.throws(() => resolveGithubDeployment('https://sample-ent.ghe.com', ''), /ENTERPRISE_SLUG is required/);
  assert.throws(() => resolveGithubDeployment('https://sample-ent.ghe.com/enterprises/sample-ent', 'sample-ent'), /Use an origin/);
  assert.throws(() => resolveGithubDeployment('sample-ent.ghe.com', 'sample-ent'), /Invalid GITHUB_BASE_URL/);
  assert.throws(() => resolveGithubDeployment('ftp://github.com', undefined), /Use an origin/);
});

test('keeps github.com host matching unchanged', () => {
  const github = resolveGithubDeployment('https://github.com', undefined);
  assert.equal(isGitHubUrl('https://github.com/login/device', github), true);
  assert.equal(isGitHubUrl('https://api.github.com/user', github), true);
  assert.equal(isGitHubUrl('https://sample-ent.ghe.com/login/device', github), false);
  assert.equal(isGitHubUrl('https://auth.ghe.com/', github), false);
  assert.equal(isGitHubUrl('https://evilgithub.com/', github), false);
  assert.equal(isGitHubSsoInterstitial('https://github.com/enterprises/acme/sso', github), true);
  assert.equal(isGheComSignInPage('https://github.com/login', github), false);
});

test('matches the configured GHE.com host, its subdomains and auth.ghe.com', () => {
  const github = resolveGithubDeployment('https://sample-ent.ghe.com', 'sample-ent');
  assert.equal(isGitHubUrl('https://sample-ent.ghe.com/login/device', github), true);
  assert.equal(isGitHubUrl('https://api.sample-ent.ghe.com/user', github), true);
  assert.equal(isGitHubUrl('https://auth.ghe.com/login', github), true);
  assert.equal(isGitHubUrl('https://other-ent.ghe.com/login', github), false);
  assert.equal(isGitHubUrl('https://github.com/login', github), false);
  assert.equal(isGitHubUrl('http://10.0.0.4:7001/login', github), false);
  assert.equal(isGitHubUrl('not a url', github), false);

  assert.equal(isGitHubSsoInterstitial('https://sample-ent.ghe.com/enterprises/sample-ent/sso?return_to=%2Flogin%2Fdevice', github), true);
  assert.equal(isGitHubSsoInterstitial('http://10.0.0.4:7001/sso?SAMLRequest=x', github), false);
  assert.equal(isGitHubDeviceAccountSelectionUrl('https://sample-ent.ghe.com/login/device/select_account', github), true);

  assert.equal(isGheComSignInPage('https://sample-ent.ghe.com/login?return_to=%2Flogin%2Fdevice', github), true);
  assert.equal(isGheComSignInPage('https://sample-ent.ghe.com/session', github), true);
  assert.equal(isGheComSignInPage('https://sample-ent.ghe.com/login/device', github), false);
  assert.equal(isGheComSignInPage('https://sample-ent.ghe.com/login/oauth/authorize', github), false);
});
