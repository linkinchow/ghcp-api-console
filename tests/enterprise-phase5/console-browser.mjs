import { chromium } from 'playwright';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN='http://console:7004';
const check=(value,code)=>{if(!value)throw new Error(`phase5_browser_${code}`);};
const safeError=error=>error instanceof Error && /^phase5_browser_[a-z0-9_]+$/.test(error.message)?error.message:'phase5_browser_check_failed';
function trustedPath(value,root) {
  check(typeof value==='string' && isAbsolute(value) && resolve(value)===value && !/[\x00-\x1f\x7f]/u.test(value),'absolute_path');
  const rel=relative(root,value);check(rel!=='' && !rel.startsWith('..') && !isAbsolute(rel),'path_boundary');
  for(let path=value;;path=dirname(path)){if(existsSync(path))check(!lstatSync(path).isSymbolicLink(),'symlink');if(path===dirname(path))break;}
  return value;
}
function writeExclusive(path,bytes) {const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
function stateInput(file) {
  check(process.env.PHASE5_SYNTHETIC_ONLY==='1','synthetic_guard');
  check(file==='/fixture/state.json','state_path');trustedPath(file,'/fixture');
  const state=JSON.parse(readFileSync(file,'utf8'));
  check(state.fixtureVersion===1 && state.syntheticOnly===true && /^[a-z0-9][a-z0-9-]{0,31}$/.test(state.runId) && state.project===`ghcp-enterprise-phase5-${state.runId}`,'state');
  check(state.origins?.console===ORIGIN && state.registryFile==='/fixture/registry.json' && state.paths?.results==='/results','fixed_origins');
  check(Array.isArray(state.enterpriseIds) && state.enterpriseIds.length===2 && state.enterpriseIds.every(id=>/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)),'enterprise_ids');
  check(typeof state.credentials?.consoleUsername==='string' && typeof state.credentials?.consolePassword==='string' && state.credentials.consolePassword.length>=24,'credentials');
  trustedPath(state.registryFile,'/fixture');
  const registry=JSON.parse(readFileSync(state.registryFile,'utf8'));
  check(registry.version===3 && registry.legacyEnterpriseId===state.legacyEnterpriseId && registry.profiles.length===2 && registry.profiles.every(p=>state.enterpriseIds.includes(p.id) && /^phase5-[ab]$/.test(p.slug)),'registry');
  return {state,registry};
}

export async function runConsoleBrowser({stateFile,output}) {
  const {state,registry}=stateInput(stateFile);
  trustedPath(output,'/results');check(basename(output).endsWith('.json') && !existsSync(output),'output_exists');
  check(realpathSync('/results')==='/results','results_root');
  const artifactDir=join('/results','private',basename(output,'.json')+'-screenshots');trustedPath(artifactDir,'/results');
  const privateDir=dirname(artifactDir);if(!existsSync(privateDir))mkdirSync(privateDir,{mode:0o700});
  check(!existsSync(artifactDir),'artifact_exists');mkdirSync(artifactDir,{mode:0o700});
  const started=Date.now(),checks=[],enterpriseResults=[];
  let browser,context,page,timedOut=false,stage='launch',loginAccepted=false,loginPosts=0,blockedRequests=0,pageErrors=0;
  const failedApi=[];
  const deadline=setTimeout(()=>{timedOut=true;void browser?.close().catch(()=>{});},60000);
  const checkStep=(value,code)=>{check(!timedOut,'deadline');check(value,code);checks.push(code);};
  async function jsonResponse(response) {checkStep(response.status()===200,'api_status');return response.json();}
  function responseFor(path,predicate=()=>true) {return page.waitForResponse(response=>{const u=new URL(response.url());return u.origin===ORIGIN && u.pathname===path && response.request().method()==='GET' && predicate(u);},{timeout:8000});}
  async function navigate(hash,responsePath) {
    const pending=responseFor(responsePath);
    await page.evaluate(value=>{window.location.hash=value;},hash);
    return jsonResponse(await pending);
  }
  async function textVisible(text,exact=true) {await page.getByText(text,{exact}).first().waitFor({state:'visible',timeout:8000});}
  async function screenshot(name) {
    const bytes=await page.screenshot({fullPage:true,timeout:5000});
    writeExclusive(join(artifactDir,name+'.png'),bytes);
  }
  async function standardPagination(data) {
    checkStep(Number.isSafeInteger(data.total) && data.total>=0 && Array.isArray(data.items),'page_shape');
    const pages=Math.max(1,Math.ceil(data.total/25));
    await textVisible(`Page ${data.page} of ${pages}, ${data.total} total`);
    checkStep(await page.getByRole('button',{name:'Previous',exact:true}).isDisabled()=== (data.page===1),'previous_button');
    checkStep(await page.getByRole('button',{name:'Next',exact:true}).isDisabled()=== (data.page>=pages),'next_button');
  }
  async function pageRows(data,key) {
    if(data.items.length)await page.locator('tbody tr').filter({hasText:String(data.items[0][key])}).first().waitFor({state:'visible',timeout:8000});
    for(const item of data.items)checkStep(await page.locator('tbody tr').filter({hasText:String(item[key])}).count()>0,'row_matches_api');
  }
  try {
    browser=await chromium.launch({headless:true,timeout:15000,args:['--disable-background-networking','--disable-component-update']});
    check(!timedOut,'deadline');
    context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block',acceptDownloads:false});
    // Route interception never supplies fixture responses: every allowed response is the real Console.
    await context.route('**/*',async route=>{
      const request=route.request();let url;
      try{url=new URL(request.url());}catch{blockedRequests++;await route.abort();return;}
      const method=request.method(),login=method==='POST' && url.pathname==='/api/console/login';
      if(url.origin!==ORIGIN || url.username || url.password || (!['GET','HEAD'].includes(method) && !login)) {
        blockedRequests++;await route.abort();return;
      }
      if(login){loginPosts++;if(loginPosts>1){blockedRequests++;await route.abort();return;}}
      await route.continue();
    });
    if(context.routeWebSocket)await context.routeWebSocket('**/*',socket=>{blockedRequests++;socket.close();});
    page=await context.newPage();page.setDefaultTimeout(8000);page.setDefaultNavigationTimeout(10000);
    page.on('pageerror',()=>{pageErrors++;});
    page.on('response',response=>{
      const url=new URL(response.url());
      if(url.origin===ORIGIN && url.pathname.startsWith('/api/') && response.status()>=400) {
        if(!loginAccepted && url.pathname==='/api/console/me' && response.status()===401)return;
        failedApi.push({status:response.status()});
      }
    });
    stage='login';
    await page.goto(ORIGIN+'/#enterprises',{waitUntil:'domcontentloaded'});
    await textVisible('Admin Login');
    await page.getByPlaceholder('Username',{exact:true}).fill(state.credentials.consoleUsername);
    await page.getByPlaceholder('Password',{exact:true}).fill(state.credentials.consolePassword);
    const globalPending=responseFor('/api/console/proxy/management/pool/summary');
    const discoveryPending=responseFor('/api/console/proxy/management/enterprises');
    const loginPending=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/console/login' && response.request().method()==='POST');
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await jsonResponse(await loginPending);loginAccepted=true;
    const [global,discovery]=await Promise.all([globalPending.then(jsonResponse),discoveryPending.then(jsonResponse)]);
    checkStep(discovery.enabled===true && discovery.enterprises.length===2 && state.enterpriseIds.every(id=>discovery.enterprises.some(e=>e.enterpriseId===id)),'discovery_scope');
    await page.getByLabel('Enterprise',{exact:true}).waitFor();
    checkStep((await page.getByLabel('Enterprise',{exact:true}).locator('option').allTextContents()).length===2,'enterprise_selector');
    stage='global';
    await textVisible('Global enterprise pool');
    const region=page.getByRole('region',{name:'Enterprise inventory policies'});
    await region.waitFor();
    for(const enterprise of global.enterprises) {
      const row=region.getByRole('row').filter({hasText:enterprise.slug});
      await row.getByText(`${Number(enterprise.counts.total).toLocaleString('en-US')} / ${Number(enterprise.maxAccounts).toLocaleString('en-US')}`,{exact:true}).waitFor();
    }
    checkStep(global.enterprises.length===2,'global_inventory_scope');
    const figure=label=>page.locator('dl > div').filter({has:page.locator('dt',{hasText:label})}).locator('dd');
    checkStep(Number((await figure('Global supply deficit').textContent()).replaceAll(',',''))===global.supply.deficit,'global_deficit');
    await screenshot('desktop-global');
    await page.setViewportSize({width:375,height:812});
    checkStep(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'mobile_global_no_page_overflow');
    await screenshot('mobile-global');
    await page.setViewportSize({width:1280,height:900});
    for(const profile of registry.profiles) {
      const id=profile.id,proxy=`/api/console/proxy/profiles/${id}`,sso=`/api/console/sso/profiles/${id}`;
      stage=`policy-${profile.slug}`;
      await page.getByLabel('Enterprise',{exact:true}).selectOption(id);
      const policy=await navigate('enterprise-policy',proxy+'/pool-policy');
      checkStep(policy.enterpriseId===id,'policy_scope');
      await page.getByLabel('Enterprise maximum accounts',{exact:true}).waitFor();
      checkStep(await page.getByLabel('Enterprise maximum accounts',{exact:true}).inputValue()===String(policy.maxAccounts),'policy_cap');
      const lifecycle=page.locator('dl > div').filter({has:page.locator('dt',{hasText:'Lifecycle'})}).locator('dd');
      checkStep((await lifecycle.textContent())?.trim()===policy.state,'policy_state');
      stage=`users-${profile.slug}`;
      const users=await navigate('users',sso+'/users');await standardPagination(users);await pageRows(users,'ssoUser');
      stage=`accounts-${profile.slug}`;
      const accounts=await navigate('accounts',proxy+'/accounts');await standardPagination(accounts);await pageRows(accounts,'identity');
      stage=`stats-${profile.slug}`;
      const statsPath=proxy+'/request-stats/page';
      const stats=await navigate('stats',statsPath);await standardPagination(stats);
      await textVisible(`${Number(stats.total).toLocaleString('en-US')} matching retained records.`,false);
      let pagination='not-needed-less-than-two-pages';
      if(stats.total>25) {
        const next=responseFor(statsPath,url=>url.searchParams.get('page')==='2');await page.getByRole('button',{name:'Next',exact:true}).click();
        const second=await jsonResponse(await next);checkStep(second.page===2,'stats_second_page');await standardPagination(second);pagination='second-page-verified';
      }
      const filtered=responseFor(statsPath,url=>url.searchParams.get('model')===`phase5-no-model-${state.runId}`);
      await page.getByLabel('Request model',{exact:true}).fill(`phase5-no-model-${state.runId}`);
      const filterResult=await jsonResponse(await filtered);checkStep(filterResult.total===0,'stats_filter_empty');await standardPagination(filterResult);
      stage=`pool-${profile.slug}`;
      const poolSummary=responseFor(proxy+'/user-pool/summary');
      const poolPage=await navigate('user-pool',proxy+'/user-pool/page/accounts');
      const pool=await jsonResponse(await poolSummary);checkStep(pool.enterpriseId===id,'pool_scope');
      await textVisible(`${Number(pool.counts.total).toLocaleString('en-US')} registered accounts`,false);
      await page.getByRole('region',{name:'Pool accounts'}).waitFor();
      await page.getByLabel('Refresh every 10s',{exact:true}).uncheck();
      await pageRows(poolPage,'identity');
      const expectedRange=poolPage.total?`1–${Math.min(25,poolPage.total)} of ${poolPage.total} matching records`:'No matching records';await textVisible(expectedRange);
      if(profile.id===state.legacyEnterpriseId) {
        await screenshot('desktop-pool');await page.setViewportSize({width:375,height:812});
        checkStep(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'mobile_pool_no_page_overflow');
        await screenshot('mobile-pool');await page.setViewportSize({width:1280,height:900});
      }
      enterpriseResults.push({enterpriseId:id,cap:policy.maxAccounts,policyState:policy.state,users:users.total,accounts:accounts.total,requestStats:stats.total,poolAccounts:pool.counts.total,pagination});
    }
    stage='final-audit';
    checkStep(loginPosts===1,'only_login_mutation');checkStep(blockedRequests===0,'no_forbidden_requests');checkStep(pageErrors===0,'no_page_errors');checkStep(failedApi.length===0,'no_failed_api');
    checkStep(Date.now()-started<60000,'within_deadline');
    const report={status:'PASS',syntheticOnly:true,runId:state.runId,mode:'readonly-browser',durationMs:Date.now()-started,assertions:checks.length,browserVersion:browser.version(),sourceBundleSha256:state.source?.bundleSha256,enterpriseResults,browserOrigin:ORIGIN,loginPosts,businessWrites:0,blockedRequests,pageErrors,failedApiCount:failedApi.length,screenshots:['desktop-global.png','mobile-global.png','desktop-pool.png','mobile-pool.png'],screenshotDirectory:'private/'+basename(artifactDir),qualification:'real Console UI/API; provider not contacted by browser; no real GitHub validation'};
    writeExclusive(output,JSON.stringify(report,null,2)+'\n');return report;
  } catch(error) {
    const report={status:'FAIL',syntheticOnly:true,runId:state.runId,mode:'readonly-browser',durationMs:Date.now()-started,stage,error:timedOut?'phase5_browser_deadline':safeError(error),completedAssertions:checks.length,loginPosts,businessWrites:0,blockedRequests,pageErrors,failedApiCount:failedApi.length};
    if(!existsSync(output))writeExclusive(output,JSON.stringify(report,null,2)+'\n');
    return report;
  } finally {clearTimeout(deadline);await context?.close().catch(()=>{});await browser?.close().catch(()=>{});}
}
async function main() {
  const args=process.argv.slice(2),flags={};
  while(args.length){const key=args.shift();check(['--state','--output'].includes(key) && !Object.hasOwn(flags,key),'flag');const value=args.shift();check(value&&!value.startsWith('--'),'flag_value');flags[key]=value;}
  const report=await runConsoleBrowser({stateFile:flags['--state'],output:flags['--output']});
  process.stdout.write(JSON.stringify({status:report.status,runId:report.runId,mode:report.mode,durationMs:report.durationMs,...(report.status==='FAIL'?{stage:report.stage,error:report.error}:{assertions:report.assertions})})+'\n');
  if(report.status!=='PASS')process.exitCode=1;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(JSON.stringify({status:'FAIL',error:safeError(error)})+'\n');process.exitCode=1;});
