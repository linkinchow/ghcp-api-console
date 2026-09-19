import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Locator, Page } from 'playwright';
import type { RuntimeAuthConfig } from '../config.js';
import { HeadlessPlaywrightAuthStrategy, isAllowedLoginUrl } from './HeadlessPlaywrightAuthStrategy.js';
import { AccountLogger } from '../tasks/accountLogger.js';

const options:RuntimeAuthConfig = {ssoProvider:'azure',ssoUrl:'https://login.microsoftonline.com/enterprise-a/login',
  allowedLoginUrls:['https://login.microsoftonline.com/enterprise-a/login'],azureStaySignedIn:false,headless:true,
  debugArtifactsDir:'.test-artifacts',selectors:{},timeoutMs:1000,debugLogs:true,debugArtifacts:false};
const credentials = {githubUsername:'same_test',ssoUsername:'same',ssoPassword:'test-secret-do-not-log'};
const scope = {enterpriseId:'a2793f03-dafd-4e59-89cf-587b1673d30b',taskId:'2e316a51-3f1f-43ce-909c-aac7e5e9d546',oauthAttemptId:'3e316a51-3f1f-43ce-909c-aac7e5e9d546'};

test('exact origin/path allowlist blocks sibling prefix, child paths, Azure generic domain and encoded traversal',() => {
  const allowed = options.allowedLoginUrls!;
  assert.equal(isAllowedLoginUrl(allowed[0],allowed),true);
  assert.equal(isAllowedLoginUrl(`${allowed[0]}?transaction=opaque#fragment`,allowed),true);
  for (const value of [
    `${allowed[0]}2`,`${allowed[0]}/child`,`${allowed[0]}/`,
    'https://login.microsoftonline.com/enterprise-b/login','https://login.microsoftonline.com/common/login',
    'https://login.live.com/login','https://evil.login.microsoftonline.com/enterprise-a/login',
    'https://login.microsoftonline.com/enterprise-a/%2e%2e/enterprise-a/login',
    'https://login.microsoftonline.com/enterprise-a/../enterprise-a/login',
    'https://user:secret@login.microsoftonline.com/enterprise-a/login','http://login.microsoftonline.com/enterprise-a/login',
    'https://login.microsoftonline.com/enterprise-a%2flogin',
  ]) assert.equal(isAllowedLoginUrl(value,allowed),false,value);
});

test('credentials checked again after selector wait; same Azure hostname cannot authorize sibling profile',async () => {
  const dir = mkdtempSync(join(tmpdir(),'login-path-test-'));
  try {
    const logger = AccountLogger.createTask(dir,scope,true);
    const strategy = new HeadlessPlaywrightAuthStrategy(options,credentials,logger);
    type Internals = {
      fillFirst(page:Page,step:string,candidates:Array<{description:string;create(page:Page):Locator}>,value:string,label:string):Promise<void>;
      hasKnownProviderUrl(url:string):boolean;
    };
    const internals = strategy as unknown as Internals;
    assert.equal(internals.hasKnownProviderUrl('https://login.microsoftonline.com/enterprise-b/login'),false);
    let current = options.ssoUrl!,fills = 0;
    const locator = {waitFor:async () => {current = 'https://login.microsoftonline.com/enterprise-b/login';},fill:async () => {fills++;}} as unknown as Locator;
    const page = {url:() => current} as Page;
    await assert.rejects(internals.fillFirst(page,'sso-login',[{description:'password',create:() => locator}],credentials.ssoPassword,'SSO password'),/untrusted_sso_credential_url/);
    assert.equal(fills,0);
    assert.ok(!readFileSync(logger.path,'utf8').includes(credentials.ssoPassword));
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('mock browser drivers keep independent contexts and abort only the owning task browser',async () => {
  const dir = mkdtempSync(join(tmpdir(),'login-browser-test-'));
  const controllers = [new AbortController(),new AbortController()];
  const opened:Array<{closed:boolean;contexts:number;reject?:()=>void}> = [];
  const driver = {launch:async () => {
    const state:{closed:boolean;contexts:number;reject?:()=>void} = {closed:false,contexts:0};opened.push(state);
    return {
      close:async () => {state.closed = true;state.reject?.();},
      newContext:async () => {
        state.contexts++;
        return {addInitScript:async () => {},newPage:async () => ({setDefaultTimeout:() => {},setDefaultNavigationTimeout:() => {},on:() => {},
          url:() => 'https://github.com/login/device',goto:() => new Promise<void>((_resolve,reject) => {state.reject = () => reject(new Error('mock_page_closed'));})})};
      },
    };
  }} as unknown as ConstructorParameters<typeof HeadlessPlaywrightAuthStrategy>[3];
  try {
    const runs = controllers.map((controller,index) => {
      const logger = AccountLogger.createTask(dir,{...scope,taskId:index ? scope.oauthAttemptId : scope.taskId},true);
      return new HeadlessPlaywrightAuthStrategy(options,credentials,logger,driver).authorize({device_code:'mock',user_code:'mock',verification_uri:'https://github.com/login/device',expires_in:900,interval:1},controller.signal);
    });
    const outcomes = runs.map(run => run.then(() => 'completed',() => 'aborted'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(opened.length,2);assert.deepEqual(opened.map(item => item.contexts),[1,1]);
    controllers[0].abort();assert.equal(await outcomes[0],'aborted');
    assert.equal(opened[0].closed,true);assert.equal(opened[1].closed,false);
    controllers[1].abort();assert.equal(await outcomes[1],'aborted');
  } finally {controllers.forEach(controller => controller.abort());rmSync(dir,{recursive:true,force:true});}
});

test('same SSO name logs and safe artifacts are separated by enterprise/task/attempt',async () => {
  const dir = mkdtempSync(join(tmpdir(),'login-artifact-test-'));
  try {
    const first = AccountLogger.createTask(dir,scope,true);
    const secondScope = {...scope,enterpriseId:'4e316a51-3f1f-43ce-909c-aac7e5e9d546'};
    const second = AccountLogger.createTask(dir,secondScope,true);
    first.info('first','safe');second.info('second','safe');
    assert.notEqual(first.path,second.path);assert.ok(readFileSync(first.path,'utf8').includes('first'));assert.ok(!readFileSync(first.path,'utf8').includes('second'));
    const strategy = new HeadlessPlaywrightAuthStrategy({...options,debugArtifacts:true,debugArtifactsDir:dir,artifactScope:scope},credentials,first);
    const internal = strategy as unknown as {captureFailure(stage:string,page:Page|undefined,context:undefined,traceStarted:boolean):Promise<unknown>};
    await internal.captureFailure('mock-failure',{url:() => `https://sso.test/login?password=${credentials.ssoPassword}`,screenshot:async () => {throw new Error('must_not_capture_credentials');}} as unknown as Page,undefined,false);
    const files = readdirSync(join(dir,scope.enterpriseId,scope.taskId,scope.oauthAttemptId));
    assert.ok(files.some(name => name.endsWith('.json')));assert.ok(files.every(name => !/\.(zip|png)$/.test(name)));
    for (const file of files) assert.ok(!readFileSync(join(dir,scope.enterpriseId,scope.taskId,scope.oauthAttemptId,file),'utf8').includes(credentials.ssoPassword));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
