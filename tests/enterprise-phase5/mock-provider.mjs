import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MODEL_ID = 'phase5-synthetic';
export const MAX_DELAY_MS = 25_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BINDING_KEYS = ['enterpriseId','enterpriseRevision','identity','accountIncarnation','oauthAttemptId','expectedGhLogin','expectedGithubUserId'];
const CHANNELS = ['scim-create','scim-update','scim-delete','seat','authorize','user','models','inference'];
const MODES = ['ok','delay','lost-ack','terminal-unknown','429','401','500'];
const equal = (a,b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const fail = (status,code) => { throw Object.assign(new Error(code),{status,code}); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** CLI guard: this test-only process cannot be pointed at a production provider. */
export function loadFixtureConfig(file = process.env.PHASE5_STATE_FILE ?? `${process.env.PHASE5_FIXTURE_DIR ?? '/fixture'}/state.json`, env = process.env) {
  if (env.PHASE5_SYNTHETIC_ONLY !== '1') throw new Error('phase5_synthetic_guard_required');
  const state = JSON.parse(readFileSync(file,'utf8'));
  if (state.fixtureVersion !== 1 || state.syntheticOnly !== true || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(state.runId)
      || state.project !== `ghcp-enterprise-phase5-${state.runId}` || !Array.isArray(state.enterpriseIds) || state.enterpriseIds.length < 1
      || new Set(state.enterpriseIds).size !== state.enterpriseIds.length || !state.enterpriseIds.every(id => UUID.test(id))) throw new Error('phase5_state_invalid');
  const origins = {provider:'http://provider:8000',sso:'http://sso:7001',login:'http://login:7003',proxy:'http://proxy-lb:3000',console:'http://console:7004'};
  for (const [key,origin] of Object.entries(origins)) if (state.origins?.[key] !== origin) throw new Error('phase5_origin_invalid');
  if (!Array.isArray(state.origins.proxyReplicas) || state.origins.proxyReplicas.length < 2 || state.origins.proxyReplicas.length > 3
    || !state.origins.proxyReplicas.every((origin,i) => origin === `http://proxy-${i+1}:3000`)) throw new Error('phase5_replicas_invalid');
  for (const key of ['internalApiToken','fixtureToken','apiKey']) if (typeof state.credentials?.[key] !== 'string' || state.credentials[key].length < 20) throw new Error('phase5_credentials_invalid');
  const registry = JSON.parse(readFileSync(state.registryFile,'utf8'));
  if (registry.version !== 3 || registry.legacyEnterpriseId !== state.legacyEnterpriseId || registry.profiles.length !== state.enterpriseIds.length
    || new Set(registry.profiles.map(p => p.id)).size !== registry.profiles.length
    || new Set(registry.profiles.map(p => p.slug)).size !== registry.profiles.length) throw new Error('phase5_registry_invalid');
  for (const p of registry.profiles) {
    const secret = state.credentials.enterprises?.[p.id];
    if (!state.enterpriseIds.includes(p.id) || !/^[a-z0-9-]+$/.test(p.slug) || !/^[a-z0-9]+$/.test(p.shortcode)
      || !p.accountDomain.endsWith('.invalid') || p.sso.githubApiBaseUrl !== `${origins.provider}/github/${p.id}`
      || p.sso.scimBaseUrl !== `${origins.provider}/scim/v2/enterprises/${p.slug}`
      || ![secret?.scimToken,secret?.githubPat,secret?.defaultPassword ?? state.credentials.defaultPassword].every(v => typeof v === 'string' && v.length >= 12)) throw new Error('phase5_profile_invalid');
    for (const key of ['proxyInternalUrl','ssoInternalUrl','loginInternalUrl','ssoPublicUrl']) {
      const expected = key.startsWith('proxy') ? origins.proxy : key.startsWith('login') ? origins.login : origins.sso;
      if (p.routes[key] !== expected) throw new Error('phase5_registry_route_invalid');
    }
    const prefix = p.id === state.legacyEnterpriseId ? '' : `/profiles/${p.id}`;
    if (p.sso.loginUrl !== `${origins.sso}${prefix}/login` || !p.login.allowedLoginUrls.every(u => u === p.sso.loginUrl)) throw new Error('phase5_login_route_invalid');
  }
  return {state,registry};
}

/** No HTTP forwarding, shell execution, database writes or external network access. */
export function createMockProvider({state,registry}) {
  if (state.syntheticOnly !== true || state.fixtureVersion !== 1) throw new Error('phase5_state_invalid');
  const namespaces = new Map(registry.profiles.map(profile => [profile.id,{
    profile, secrets:state.credentials.enterprises[profile.id], users:new Map(), seats:new Set(), tokens:new Map(), attempts:new Map(),
    faults:new Map(), counts:{}, members:{}, markers:{}, calls:[], nextId:1,
  }]));
  const count = (ns,key,subject,marker) => {
    ns.counts[key] = (ns.counts[key] ?? 0)+1;
    if (subject) { ns.members[subject] ??= {}; ns.members[subject][key] = (ns.members[subject][key] ?? 0)+1; }
    if (marker) { ns.markers[marker] ??= {}; ns.markers[marker][key] = (ns.markers[marker][key] ?? 0)+1; }
    if (ns.calls.length < 2000) ns.calls.push({operation:key,subject:subject ?? null,marker:marker ?? null});
  };
  const auth = (req,secret) => { if (!equal(req.headers.authorization,`Bearer ${secret}`)) fail(401,'fixture_credential_rejected'); };
  function takeFault(ns,channel) {
    const f = ns.faults.get(channel);
    if (!f || f.remaining <= 0 || f.expiresAt < Date.now()) return {mode:'ok',delayMs:0};
    f.remaining--; return f;
  }
  async function before(req,res,ns,channel) {
    const f = takeFault(ns,channel);
    if (f.mode === 'delay' || f.mode === 'terminal-unknown') {
      await delay(f.delayMs,req,res);
      if (res.destroyed) return null;
    }
    if (['429','401','500','terminal-unknown'].includes(f.mode)) {
      json(res,f.mode === 'terminal-unknown' ? 503 : Number(f.mode),{error:{type:'synthetic_fault',code:`fixture_${f.mode}`}}, {'retry-after':'1'}); return null;
    }
    return f;
  }
  const respond = (res,f,status,body) => f.mode === 'lost-ack' ? res.destroy() : json(res,status,body);
  function bearerSubject(req,id) {
    const token = req.headers.authorization?.replace(/^Bearer /,'');
    const candidates = id ? [namespaces.get(id)].filter(Boolean) : [...namespaces.values()];
    for (const ns of candidates) {
      const subject = ns.tokens.get(token);
      if (subject && ns.users.get(subject.scimId)?.active && ns.seats.has(subject.login)) return {ns,subject};
    }
    fail(401,'synthetic_oauth_rejected');
  }
  const server = http.createServer(async (req,res) => {
    try {
      const url = new URL(req.url,'http://fixture.invalid'), path = url.pathname;
      if (path === '/healthz' && req.method === 'GET') { json(res,200,{status:'ok',syntheticOnly:true,fixtureVersion:1}); return; }
      if (path.startsWith('/fixture/')) {
        auth(req,state.credentials.fixtureToken);
        if (path === '/fixture/snapshot' && req.method === 'GET') {
          json(res,200,{syntheticOnly:true,runId:state.runId,enterprises:[...namespaces.values()].map(ns => ({
            enterpriseId:ns.profile.id,scimUsers:ns.users.size,seats:ns.seats.size,issuedTokens:ns.tokens.size,
            counts:ns.counts,members:ns.members,markers:ns.markers,calls:ns.calls,
            subjects:[...ns.users.values()].map(u => ({ssoUser:u.userName,ghLogin:u.githubLogin,active:u.active,seated:ns.seats.has(u.githubLogin)})),
            faults:[...ns.faults].map(([channel,f]) => ({channel,mode:f.mode,remaining:f.remaining,expiresAt:f.expiresAt})),
          }))}); return;
        }
        const body = await readJson(req);
        if (path === '/fixture/control' && req.method === 'POST') {
          if (!record(body) || Object.keys(body).some(k => !['enterpriseId','channel','mode','count','delayMs','ttlMs'].includes(k))) fail(400,'invalid_control');
          const ns = namespaces.get(body.enterpriseId);
          const count = body.count ?? 1, delayMs = body.delayMs ?? 1000, ttlMs = body.ttlMs ?? 60_000;
          if (!ns || !CHANNELS.includes(body.channel) || !MODES.includes(body.mode) || !Number.isInteger(count) || count < 1 || count > 1000
            || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS || !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 600_000) fail(400,'invalid_control');
          ns.faults.set(body.channel,{mode:body.mode,remaining:count,delayMs,expiresAt:Date.now()+ttlMs});
          json(res,200,{accepted:true}); return;
        }
        if (path === '/fixture/authorize' && req.method === 'POST') {
          if (!record(body) || Object.keys(body).some(k => !['binding','ssoUser','ssoPassword'].includes(k))) fail(400,'invalid_authorization');
          const b = body.binding, ns = namespaces.get(b?.enterpriseId);
          if (!ns || !record(b) || Object.keys(b).some(k => !BINDING_KEYS.includes(k)) || !UUID.test(b.accountIncarnation) || !UUID.test(b.oauthAttemptId)
            || b.enterpriseRevision !== ns.profile.revision || typeof b.identity !== 'string' || !b.identity || b.identity.length > 255
            || typeof b.expectedGhLogin !== 'string' || typeof body.ssoUser !== 'string' || b.identity !== body.ssoUser) fail(400,'invalid_authorization_binding');
          const user = [...ns.users.values()].find(u => u.userName === body.ssoUser);
          if (!user || !user.active || user.githubLogin !== b.expectedGhLogin || !ns.seats.has(user.githubLogin)
            || (b.expectedGithubUserId !== undefined && b.expectedGithubUserId !== String(user.numericId))
            || !equal(body.ssoPassword,ns.secrets.defaultPassword ?? state.credentials.defaultPassword)) fail(403,'authorization_subject_rejected');
          const key = JSON.stringify(BINDING_KEYS.map(k => b[k] ?? null));
          const existing = ns.attempts.get(b.oauthAttemptId);
          if (existing && existing.key !== key) fail(409,'authorization_binding_conflict');
          count(ns,'authorize',user.githubLogin);
          const f = await before(req,res,ns,'authorize'); if (!f) return;
          const token = existing?.token ?? `phase5_${randomUUID().replaceAll('-','')}`;
          ns.attempts.set(b.oauthAttemptId,{key,token});
          ns.tokens.set(token,{login:user.githubLogin,id:user.numericId,scimId:user.id,binding:{...b}});
          respond(res,f,200,{token}); return;
        }
        fail(404,'fixture_route_not_found');
      }
      const scim = /^\/scim\/v2\/enterprises\/([^/]+)\/Users(?:\/([^/]+))?$/.exec(path);
      if (scim) {
        const ns = [...namespaces.values()].find(n => n.profile.slug === scim[1]);
        if (!ns) fail(404,'enterprise_not_found'); auth(req,ns.secrets.scimToken);
        const id = scim[2] ? decodeURIComponent(scim[2]) : undefined;
        if (req.method === 'GET') {
          count(ns,'scim-read');
          if (id) { const user = ns.users.get(id); if (!user) fail(404,'user_not_found'); json(res,200,user); return; }
          let users = [...ns.users.values()];
          const filter = url.searchParams.get('filter');
          if (filter) { const m = /^userName eq ("(?:[^"\\]|\\.)*")$/.exec(filter); if (!m) fail(400,'filter_invalid'); const name = JSON.parse(m[1]); users=users.filter(u => u.userName.toLowerCase() === name.toLowerCase()); }
          const startIndex = Math.max(1,Number(url.searchParams.get('startIndex') ?? 1)), countPage = Math.min(100,Math.max(1,Number(url.searchParams.get('count') ?? 100)));
          json(res,200,{schemas:['urn:ietf:params:scim:api:messages:2.0:ListResponse'],totalResults:users.length,startIndex,itemsPerPage:countPage,Resources:users.slice(startIndex-1,startIndex-1+countPage)}); return;
        }
        const channel = req.method === 'POST' ? 'scim-create' : req.method === 'DELETE' ? 'scim-delete' : 'scim-update';
        const body = req.method === 'DELETE' ? {} : await readJson(req);
        if (!['POST','PUT','PATCH','DELETE'].includes(req.method)) fail(405,'method_not_allowed');
        count(ns,channel);
        const f = await before(req,res,ns,channel); if (!f) return;
        if (req.method === 'POST' && !id) {
          if (typeof body.userName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,99}$/.test(body.userName)) fail(400,'invalid_username');
          if ([...ns.users.values()].some(u => u.userName.toLowerCase() === body.userName.toLowerCase())) fail(409,'user_exists');
          const local = body.userName.split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,39-ns.profile.shortcode.length-1).replace(/-+$/g,'');
          const user = {...body,id:`${ns.profile.id}-${ns.nextId}`,numericId:ns.nextId++,githubLogin:`${local}_${ns.profile.shortcode}`,active:body.active !== false};
          ns.users.set(user.id,user); respond(res,f,201,user); return;
        }
        const user = ns.users.get(id); if (!user) fail(404,'user_not_found');
        if (req.method === 'DELETE') { ns.users.delete(id); ns.seats.delete(user.githubLogin); respond(res,f,204,undefined); return; }
          if (req.method !== 'PUT' && req.method !== 'PATCH') fail(405,'method_not_allowed');
          if (req.method === 'PUT') {
            if (body.userName !== user.userName) fail(409,'subject_reassignment_forbidden');
            const fixed={id:user.id,numericId:user.numericId,githubLogin:user.githubLogin};Object.assign(user,body,fixed);
          }
        if (req.method === 'PATCH') {
          if (!Array.isArray(body.Operations) || !body.Operations.every(o => String(o.op).toLowerCase() === 'replace' && o.path === 'active' && typeof o.value === 'boolean')) fail(400,'invalid_patch');
          for (const o of body.Operations) user.active=o.value;
        }
        respond(res,f,200,user); return;
      }
      const gh = /^\/github\/([^/]+)(\/.*)$/.exec(path);
      if (gh) {
        const ns = namespaces.get(gh[1]); if (!ns) fail(404,'enterprise_not_found');
        if (gh[2] === '/user' && req.method === 'GET') {
          const {subject} = bearerSubject(req,ns.profile.id); count(ns,'verify-user',subject.login);
          const f = await before(req,res,ns,'user'); if (!f) return;
          respond(res,f,200,{login:subject.login,id:subject.id,type:'User'}); return;
        }
        auth(req,ns.secrets.githubPat);
        const base = `/enterprises/${ns.profile.slug}`;
        if (gh[2] === `${base}/copilot/billing/seats` && req.method === 'GET') {
          count(ns,'seat-list'); const all=[...ns.seats],page=Number(url.searchParams.get('page') ?? 1);
          json(res,200,{total_seats:all.length,seats:all.slice((page-1)*100,page*100).map(login => ({assignee:{login}}))}); return;
        }
        if (gh[2] === `${base}/copilot/billing/selected_users` && ['POST','DELETE'].includes(req.method)) {
          const body=await readJson(req), users=body.selected_usernames;
          if (!Array.isArray(users) || users.length !== 1 || ![...ns.users.values()].some(u => u.githubLogin === users[0] && u.active)) fail(404,'subject_not_found');
          count(ns,req.method === 'POST' ? 'seat-assign' : 'seat-remove',users[0]);
          const f = await before(req,res,ns,'seat'); if (!f) return;
          if (req.method === 'POST') ns.seats.add(users[0]); else ns.seats.delete(users[0]);
          respond(res,f,200,{seats_created:req.method === 'POST' ? 1 : 0,seats_cancelled:req.method === 'DELETE' ? 1 : 0}); return;
        }
        if (gh[2] === `${base}/settings/billing/usage/summary` && req.method === 'GET') { json(res,200,{usageItems:[]}); return; }
        fail(404,'github_route_not_found');
      }
      if (['/models','/v1/models','/v1/messages','/v1/messages/count_tokens','/chat/completions','/responses'].includes(path)) {
        const {ns,subject} = bearerSubject(req);
        const isCatalog = ['/models','/v1/models'].includes(path), body = isCatalog ? {} : await readJson(req);
        if (req.method !== (isCatalog ? 'GET' : 'POST')) fail(405,'method_not_allowed');
        const markerText = JSON.stringify(body).match(/phase5-request:[a-zA-Z0-9_-]{1,100}/)?.[0];
        count(ns,isCatalog ? 'catalog' : 'inference',subject.login,markerText);
        const f = await before(req,res,ns,isCatalog ? 'models' : 'inference'); if (!f) return;
        if (f.mode === 'lost-ack') { res.destroy(); return; }
        if (isCatalog) { json(res,200,{object:'list',data:[{id:MODEL_ID,name:'Synthetic Phase 5',object:'model',vendor:'Synthetic',model_picker_enabled:true,supported_endpoints:['/chat/completions','/v1/messages','/responses'],capabilities:{type:'chat',family:'synthetic',limits:{max_prompt_tokens:8192,max_output_tokens:256}}}]}); return; }
        if (body.model !== MODEL_ID) fail(400,'synthetic_model_required');
        if (path.endsWith('/count_tokens')) { json(res,200,{input_tokens:8}); return; }
        const id=`synthetic-${randomUUID()}`, text='synthetic-ok';
        if (body.stream === true) {
          res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
          const event=(name,data)=>res.write(`${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
          if (path === '/v1/messages') {
            event('message_start',{type:'message_start',message:{id,type:'message',role:'assistant',model:MODEL_ID,content:[],stop_reason:null,usage:{input_tokens:8,output_tokens:0}}});
            event('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}});
            event('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text}});
            event('content_block_stop',{type:'content_block_stop',index:0});
            event('message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:2}});
            event('message_stop',{type:'message_stop'});
          } else if (path === '/responses') {
            event('response.created',{type:'response.created',response:{id,status:'in_progress',model:MODEL_ID,output:[]}});
            event('response.output_text.delta',{type:'response.output_text.delta',response_id:id,output_index:0,content_index:0,delta:text});
            event('response.completed',{type:'response.completed',response:{id,status:'completed',model:MODEL_ID,output:[],usage:{input_tokens:8,output_tokens:2,total_tokens:10}}});
          } else {
            event('',{id,object:'chat.completion.chunk',model:MODEL_ID,choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]});
            event('',{id,object:'chat.completion.chunk',model:MODEL_ID,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:8,completion_tokens:2,total_tokens:10}}); res.write('data: [DONE]\n\n');
          }
          res.end(); return;
        }
        if (path === '/v1/messages') json(res,200,{id,type:'message',role:'assistant',model:MODEL_ID,content:[{type:'text',text}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:8,output_tokens:2}});
        else if (path === '/responses') json(res,200,{id,object:'response',status:'completed',model:MODEL_ID,output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}],usage:{input_tokens:8,output_tokens:2,total_tokens:10}});
        else json(res,200,{id,object:'chat.completion',created:Math.floor(Date.now()/1000),model:MODEL_ID,choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:8,completion_tokens:2,total_tokens:10}});
        return;
      }
      fail(404,'route_not_found');
    } catch (error) {
      if (!res.destroyed && !res.headersSent) json(res,error.status ?? 500,{error:{code:error.code ?? 'fixture_internal_error'}});
      else res.destroy();
    }
  });
  server.requestTimeout=30_000; server.headersTimeout=10_000;
  return server;
}
async function readJson(req) {
  let size=0; const chunks=[];
  for await (const chunk of req) { size+=chunk.length; if (size>1024*1024) fail(413,'body_too_large'); chunks.push(chunk); }
  try { const body=JSON.parse(Buffer.concat(chunks).toString() || '{}'); if (!record(body)) fail(400,'invalid_json'); return body; }
  catch { fail(400,'invalid_json'); }
}
function json(res,status,body,headers={}) { res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',...headers}); res.end(body===undefined?undefined:JSON.stringify(body)); }
function delay(ms,req,res) {
  return new Promise(resolve => {
    const done=()=>{clearTimeout(timer);res.off('close',done);req.off('aborted',done);resolve();};
    const timer=setTimeout(done,ms); res.once('close',done);req.once('aborted',done);
    if (res.destroyed || req.aborted) done();
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config=loadFixtureConfig();
  const server=createMockProvider(config);
  server.listen(8000,'0.0.0.0',()=>console.log('phase5 synthetic provider ready'));
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{server.close();server.closeAllConnections();});
}
