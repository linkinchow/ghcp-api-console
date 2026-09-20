import assert from 'node:assert/strict';
import test from 'node:test';
import { loginWithDeviceFlow, sleep } from './deviceFlow.js';

test('uses the OpenCode OAuth client and headers while polling', async () => {
  const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const sleeps: number[] = [];
  const responses = [
    jsonResponse({
      device_code: 'device-code',
      user_code: 'user-code',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 1,
    }),
    jsonResponse({ error: 'authorization_pending' }),
    jsonResponse({ access_token: 'oauth-token', token_type: 'bearer', scope: 'read:user' }),
  ];
  let now = 0;
  let authorizedCode: string | undefined;

  const token = await loginWithDeviceFlow(
    {
      name: 'test',
      authorize: async (device) => {
        authorizedCode = device.user_code;
      },
    },
    {
      info: () => undefined,
      warn: () => undefined,
    },
    {
      fetch: async (input, init) => {
        requests.push({ input, init });
        return responses.shift()!;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      now: () => now,
    },
  );

  assert.equal(token, 'oauth-token');
  assert.equal(authorizedCode, 'user-code');
  assert.deepEqual(sleeps, [4_000, 4_000]);
  assert.equal(requests.length, 3);

  const deviceRequest = requests[0]!;
  assert.equal(String(deviceRequest.input), 'https://github.com/login/device/code');
  assert.deepEqual(JSON.parse(String(deviceRequest.init?.body)), {
    client_id: 'Ov23li8tweQw6odWQebz',
    scope: 'read:user',
  });
  assert.deepEqual(deviceRequest.init?.headers, {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'opencode/1.0.0',
  });

  const pollRequest = requests[1]!;
  assert.equal(String(pollRequest.input), 'https://github.com/login/oauth/access_token');
  assert.deepEqual(JSON.parse(String(pollRequest.init?.body)), {
    client_id: 'Ov23li8tweQw6odWQebz',
    device_code: 'device-code',
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
});

test('AbortSignal covers HTTP, strategy and sleep; late poll does not return credentials after abort',async () => {
  const controller = new AbortController();
  let fetches = 0,strategies = 0;
  await assert.rejects(loginWithDeviceFlow({name:'mock',authorize:async (_device,signal) => {strategies++;assert.equal(signal,controller.signal);}},
    {info:() => {},warn:() => {}},{
      fetch:async (_url,init) => {fetches++;assert.equal(init?.signal,controller.signal);assert.equal(init?.redirect,'error');return jsonResponse({device_code:'device',user_code:'user',verification_uri:'https://github.com/login/device',expires_in:900,interval:1});},
      sleep:async (_ms,signal) => {assert.equal(signal,controller.signal);controller.abort();},now:() => 0,
    },controller.signal));
  assert.equal(fetches,1);assert.equal(strategies,1);
  const sleeper = new AbortController(),pending = sleep(60_000,sleeper.signal);sleeper.abort();await assert.rejects(pending);
  let preabortedCalls = 0;
  await assert.rejects(loginWithDeviceFlow({name:'never',authorize:async () => {preabortedCalls++;}}, {info:() => {},warn:() => {}},
    {fetch:async () => {preabortedCalls++;return jsonResponse({});},sleep:async () => {},now:() => 0},controller.signal));
  assert.equal(preabortedCalls,0);
});

test('device response cannot redirect browser or leak upstream body into logs/errors',async () => {
  const logs:unknown[] = [];
  let launched = 0;
  await assert.rejects(loginWithDeviceFlow({name:'never',authorize:async () => {launched++;}}, {info:(...args) => {logs.push(args);},warn:(...args) => {logs.push(args);}},
    {fetch:async () => jsonResponse({device_code:'secret-device',user_code:'secret-user',verification_uri:'https://evil.test/login',expires_in:900,interval:1}),sleep:async () => {},now:() => 0}),/device_code_response_invalid/);
  assert.equal(launched,0);assert.ok(!JSON.stringify(logs).includes('secret-'));
});

test('device-code expiry includes browser authorization time and never starts an expired poll', async () => {
  let now = 0, calls = 0;
  await assert.rejects(loginWithDeviceFlow({name:'mock',authorize:async()=>{now=6000;}},
    {info:()=>{},warn:()=>{}},{
      fetch:async()=>{calls++;return jsonResponse({device_code:'device',user_code:'user',verification_uri:'https://github.com/login/device',expires_in:5,interval:1});},
      sleep:async ms=>{now+=ms;},now:()=>now,
    }), /device_flow_authorization_timed_out/);
  assert.equal(calls,1);
});

test('expiry during poll wait or token-body delivery cannot return a token', async () => {
  for (const mode of ['wait','body'] as const) {
    let now=0,calls=0;
    await assert.rejects(loginWithDeviceFlow({name:'mock',authorize:async()=>{}},{info:()=>{},warn:()=>{}},{
      fetch:async()=>{calls++;if(calls===1)return jsonResponse({device_code:'device',user_code:'user',verification_uri:'https://github.com/login/device',expires_in:5,interval:1});
        return {ok:true,json:async()=>{now=6000;return {access_token:'synthetic-late-token'};}} as Response;},
      sleep:async ms=>{now+=mode==='wait'?6000:ms;},now:()=>now,
    }),/device_flow_authorization_timed_out/);
    assert.equal(calls,mode==='wait'?1:2);
  }
});

test('actual in-flight polling and delayed token body both reject after cancellation', async () => {
  for(const phase of ['fetch','body'] as const){
    const controller=new AbortController();let calls=0,now=0;
    await assert.rejects(loginWithDeviceFlow({name:'mock',authorize:async()=>{}},{info:()=>{},warn:()=>{}},{
      fetch:async()=>{calls++;if(calls===1)return jsonResponse({device_code:'device',user_code:'user',verification_uri:'https://github.com/login/device',expires_in:900,interval:1});
        if(phase==='fetch')controller.abort();
        return {ok:true,json:async()=>{if(phase==='body')controller.abort();return{access_token:'synthetic-after-abort'};}} as Response;},
      sleep:async ms=>{now+=ms;},now:()=>now,
    },controller.signal));assert.equal(calls,2);
  }
});

test('slow_down adjusts polling while denial and malformed responses expose no provider detail',async()=>{
  let now=0,calls=0;const waits:number[]=[];
  const values=[{device_code:'d',user_code:'u',verification_uri:'https://github.com/login/device',expires_in:900,interval:1},{error:'slow_down',interval:7},{error:'slow_down'},{access_token:'synthetic'}];
  assert.equal(await loginWithDeviceFlow({name:'mock',authorize:async()=>{}},{info:()=>{},warn:()=>{}},{fetch:async()=>jsonResponse(values[calls++]),sleep:async ms=>{waits.push(ms);now+=ms;},now:()=>now}),'synthetic');
  assert.deepEqual(waits,[4000,10000,15000]);
  for(const response of [null,[],{error:'access_denied',error_description:'PRIVATE_DESCRIPTION'},{error:'expired_token'},{access_token:123}]){
    calls=0;now=0;
    await assert.rejects(loginWithDeviceFlow({name:'mock',authorize:async()=>{}},{info:()=>{},warn:()=>{}},{fetch:async()=>jsonResponse(calls++===0?values[0]:response),sleep:async ms=>{now+=ms;},now:()=>now}),/device_flow_authorization_failed/);
  }
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
