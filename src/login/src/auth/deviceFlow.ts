import { config } from '../config.js';
import type { AccountLogger } from '../tasks/accountLogger.js';
import type { AuthStrategy } from './types.js';

type DeviceFlowLogger = Pick<AccountLogger,'info' | 'warn'>;
interface DeviceFlowRuntime {
  fetch: typeof globalThis.fetch;
  sleep(ms:number,signal?:AbortSignal):Promise<void>;
  now():number;
}
const defaultRuntime: DeviceFlowRuntime = {fetch:(...args) => globalThis.fetch(...args),sleep,now:Date.now};
export interface DeviceCodeResponse {device_code:string;user_code:string;verification_uri:string;expires_in:number;interval:number}
interface AccessTokenResponse {access_token?:string;token_type?:string;scope?:string;error?:string;interval?:number}

export async function loginWithDeviceFlow(strategy:AuthStrategy,logger:DeviceFlowLogger,runtime:DeviceFlowRuntime = defaultRuntime,
  signal?:AbortSignal):Promise<string> {
  signal?.throwIfAborted();
  const device = await requestDeviceCode(logger,runtime,signal);
  logger.info('device-flow','Received GitHub device code',{expiresIn:device.expires_in,interval:device.interval});
  signal?.throwIfAborted();
  await strategy.authorize(device,signal);
  signal?.throwIfAborted();
  return pollAccessToken(device,logger,runtime,signal);
}
async function requestDeviceCode(logger:DeviceFlowLogger,runtime:DeviceFlowRuntime,signal?:AbortSignal):Promise<DeviceCodeResponse> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal?.throwIfAborted();
    const res = await runtime.fetch(config.endpoints.deviceCode,{method:'POST',headers:deviceFlowHeaders(),
      body:JSON.stringify({client_id:config.githubOauthClientId,scope:config.githubOauthScope}),signal,redirect:'error'});
    if (res.ok) {
      const body = await res.json() as DeviceCodeResponse;
      if (!body || typeof body.device_code !== 'string' || !body.device_code || typeof body.user_code !== 'string' || !body.user_code
        || body.verification_uri !== 'https://github.com/login/device' || !Number.isFinite(body.expires_in) || body.expires_in < 1 || body.expires_in > 1800
        || !Number.isFinite(body.interval) || body.interval < 1 || body.interval > 120) throw new Error('device_code_response_invalid');
      logger.info('device-flow','Requested GitHub device code',{attempt});
      return body;
    }
    if (attempt < 3) {
      logger.warn('device-flow','Device code request failed; retrying',{attempt,status:res.status});
      await runtime.sleep(1000*attempt,signal);
    }
  }
  throw new Error('device_code_request_failed');
}
async function pollAccessToken(device:DeviceCodeResponse,logger:DeviceFlowLogger,runtime:DeviceFlowRuntime,signal?:AbortSignal):Promise<string> {
  const started = runtime.now();
  let interval = (Math.max(1,device.interval)+3)*1000;
  while (runtime.now()-started < device.expires_in*1000) {
    signal?.throwIfAborted();
    await runtime.sleep(interval,signal);
    signal?.throwIfAborted();
    const res = await runtime.fetch(config.endpoints.accessToken,{method:'POST',headers:deviceFlowHeaders(),
      body:JSON.stringify({client_id:config.githubOauthClientId,device_code:device.device_code,grant_type:'urn:ietf:params:oauth:grant-type:device_code'}),signal,redirect:'error'});
    if (!res.ok) throw new Error('access_token_poll_failed');
    const body = await res.json() as AccessTokenResponse;
    signal?.throwIfAborted();
    if (typeof body.access_token === 'string' && body.access_token) { logger.info('device-flow','GitHub OAuth authorization complete'); return body.access_token; }
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      interval = typeof body.interval === 'number' && Number.isFinite(body.interval) ? (Math.max(1,body.interval)+3)*1000 : interval+5000;
      logger.warn('device-flow','GitHub requested slower polling',{intervalMs:interval});
      continue;
    }
    throw new Error('device_flow_authorization_failed');
  }
  throw new Error('device_flow_authorization_timed_out');
}
export function sleep(ms:number,signal?:AbortSignal):Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve,reject) => {
    const stop = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('aborted')); };
    const timer = setTimeout(() => {signal?.removeEventListener('abort',stop); resolve();},ms);
    signal?.addEventListener('abort',stop,{once:true});
  });
}
function deviceFlowHeaders():Record<string,string> {return {Accept:'application/json','Content-Type':'application/json','User-Agent':config.opencodeUserAgent};}
