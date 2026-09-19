import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here=fileURLToPath(new URL('.',import.meta.url));
const ids=['a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000002'];
const preload=String.raw`
const ids=['a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000002'];
const markers={};let inference=0;
const allowed=new Set(['http://proxy-lb:3000','http://proxy-1:3000','http://proxy-2:3000','http://provider:8000']);
globalThis.fetch=async(input,init={})=>{
  const url=new URL(String(input));if(!allowed.has(url.origin))throw new Error('test_external_route_rejected');
  if(url.pathname==='/fixture/snapshot')return Response.json({enterprises:ids.map((enterpriseId,i)=>({enterpriseId,counts:{'scim-create':0,'seat-assign':0},markers:i?{}:markers}))});
  if(url.pathname==='/api/management/pool/settings')return Response.json({version:1,idle_target:0,paused:0,lease_seconds:60});
  if(url.pathname.endsWith('/diagnostics/local'))return Response.json({localScheduler:{state:url.hostname==='proxy-1'?'owner':'standby'}});
  if(/^\/api\/profiles\/[^/]+\/user-pool$/.test(url.pathname))return Response.json({counts:{total:2},accounts:[{identity:'member-a',state:'ready'},{identity:'member-b',state:'ready'}],leases:[]});
  if(url.pathname==='/chat/completions'&&init.method==='POST'){
    const body=JSON.parse(init.body),marker=body.messages[0].content;
    if(++inference>1)throw new Error('test_inference_cap');
    markers[marker]={inference:1};return Response.json({choices:[{message:{content:'synthetic-ok'}}]});
  }
  throw new Error('test_unexpected_route');
};
`;

function fixture(directory){
  const registryFile=join(directory,'registry.json');
  const profiles=ids.map((id,i)=>({id,revision:1,slug:`phase5-${i?'b':'a'}`,shortcode:i?'p5bb':'p5aa',accountDomain:`pool-${i?'b':'a'}.invalid`,
    routes:{proxyInternalUrl:'http://proxy-lb:3000',ssoInternalUrl:'http://sso:7001',loginInternalUrl:'http://login:7003',ssoPublicUrl:'http://sso:7001'},
    sso:{githubApiBaseUrl:`http://provider:8000/github/${id}`,scimBaseUrl:`http://provider:8000/scim/v2/enterprises/phase5-${i?'b':'a'}`,loginUrl:`http://sso:7001${i?`/profiles/${id}`:''}/login`},
    login:{allowedLoginUrls:[`http://sso:7001${i?`/profiles/${id}`:''}/login`]}}));
  writeFileSync(registryFile,JSON.stringify({version:3,legacyEnterpriseId:ids[0],profiles}));
  const state={fixtureVersion:1,syntheticOnly:true,mode:'init',runId:'entry-unit',project:'ghcp-enterprise-phase5-entry-unit',legacyEnterpriseId:ids[0],enterpriseIds:ids,registryFile,
    origins:{proxy:'http://proxy-lb:3000',proxyReplicas:['http://proxy-1:3000','http://proxy-2:3000'],sso:'http://sso:7001',login:'http://login:7003',console:'http://console:7004',provider:'http://provider:8000'},
    credentials:{internalApiToken:'synthetic-internal-secret-only',apiKey:'synthetic-inference-api-key',fixtureToken:'synthetic-fixture-secret-only',enterprises:Object.fromEntries(ids.map(id=>[id,{scimToken:'synthetic-scim-secret',githubPat:'synthetic-seat-secret',defaultPassword:'synthetic-password'}]))}};
  const stateFile=join(directory,'state.json');writeFileSync(stateFile,JSON.stringify(state));
  const preloadFile=join(directory,'preload.mjs');writeFileSync(preloadFile,preload);
  return {stateFile,preloadFile};
}

for(const entry of ['fullstack.ts','stable-window.ts'])test(`${entry} stable CLI finishes module evaluation and writes bounded report`,()=>{
  const directory=mkdtempSync(join(tmpdir(),'phase5-stable-entry-'));
  try{
    const {stateFile,preloadFile}=fixture(directory),output=join(directory,'stable.json');
    const child=spawnSync(process.execPath,['--import','tsx','--import',pathToFileURL(preloadFile).href,resolve(here,entry),
      '--mode','stable','--state',stateFile,'--output',output,'--duration-ms','1000','--max-inference-requests','1'],
      {cwd:resolve(here,'../..'),env:{...process.env,PHASE5_SYNTHETIC_ONLY:'1'},encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
    assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);assert.equal(child.stderr.includes('unsettled top-level await'),false);
    const report=JSON.parse(readFileSync(output,'utf8'));assert.equal(report.mode,'stable');assert.equal(report.completed,true);assert.equal(report.status,'PASS');
    assert.equal(report.checks.length,2);assert.equal(report.checks.at(-1).details.requests,1);assert.equal(report.checks.at(-1).details.success,1);
    assert.ok(report.requestCount<=20);assert.ok(!JSON.stringify(report).includes('synthetic-internal-secret-only'));
  }finally{rmSync(directory,{recursive:true,force:true});}
});
