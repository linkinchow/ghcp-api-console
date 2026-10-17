// GHE.com (GitHub Enterprise Cloud with data residency) web pages and OAuth device flow for one
// enterprise, served from mock-services.mjs when MOCK_GHE_HOST is set. Local fixture only.
//
// The flow mirrors what the Login service automates on GHE.com:
//   POST /login/device/code -> enterprise SSO page -> SAML AuthnRequest to the real SSO service ->
//   SAML response POSTed back to the ACS -> device page -> user code -> authorize -> token poll.
// Issued tokens are added to the shared token table, so the mock Copilot upstream only accepts
// tokens that went through this flow. The SAML response is checked for the GHE.com audience,
// destination, request correlation and NameID; its signature is required but not verified.
import { randomBytes, randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

const DEVICE_CODE_TTL_SECONDS = 900;

export function createGheMock({ host, port, slug, idpSsoUrl, users, tokens }) {
  const baseUrl = `http://${host}:${port}`;
  const issuer = `${baseUrl}/enterprises/${slug}`;
  const acsUrl = `${issuer}/saml/consume`;
  const pendingAuthnRequests = new Set();
  const sessions = new Map(); // session cookie -> NameID
  const devices = new Map(); // device_code -> { userCode, clientId, authorizedBy?, token? }
  const evidence = { deviceCodeRequests: [], samlResponses: [], deviceCodesEntered: [], authorizations: [], tokensIssued: [], hosts: {} };

  function handles(req) {
    return hostnameOf(req) === host;
  }

  async function handle(req, res, url) {
    record(evidence.hosts, 'web');
    const path = url.pathname;
    if (req.method === 'POST' && path === '/login/device/code') return deviceCode(req, res);
    if (req.method === 'POST' && path === '/login/oauth/access_token') return accessToken(req, res);
    if (req.method === 'GET' && path === `/enterprises/${slug}/sso`) return enterpriseSsoPage(res, url);
    if (req.method === 'GET' && path === `/enterprises/${slug}/saml/initiate`) return samlInitiate(res, url);
    if (req.method === 'POST' && path === `/enterprises/${slug}/saml/consume`) return samlConsume(req, res);
    if (req.method === 'GET' && path === '/login') {
      return redirect(res, `/enterprises/${slug}/sso?return_to=${encodeURIComponent(url.searchParams.get('return_to') ?? '/')}`);
    }
    const signedInAs = sessionUser(req);
    if (req.method === 'GET' && path === '/login/device') {
      if (!signedInAs) return redirect(res, '/login?return_to=%2Flogin%2Fdevice');
      return html(res, `<h1>Device Activation</h1>
        <form method="post" action="/login/device"><input type="text" name="user_code"><button type="submit">Continue</button></form>`);
    }
    if (req.method === 'POST' && path === '/login/device' && signedInAs) return enterUserCode(req, res, signedInAs);
    if (req.method === 'POST' && path === '/login/oauth/authorize' && signedInAs) return authorize(req, res, signedInAs);
    if (req.method === 'GET' && path === '/') return html(res, '<h1>Enterprise dashboard</h1>');
    res.writeHead(404).end();
  }

  async function deviceCode(req, res) {
    const body = await readJson(req);
    const device = { userCode: userCode(), clientId: body.client_id, scope: body.scope };
    const code = randomUUID();
    devices.set(code, device);
    evidence.deviceCodeRequests.push({ clientId: body.client_id, scope: body.scope, accept: req.headers.accept ?? null });
    return json(res, 200, {
      device_code: code,
      user_code: device.userCode,
      verification_uri: `${baseUrl}/login/device`,
      expires_in: DEVICE_CODE_TTL_SECONDS,
      interval: 1,
    });
  }

  async function accessToken(req, res) {
    const body = await readJson(req);
    const device = devices.get(body.device_code);
    if (!device || body.client_id !== device.clientId) return json(res, 200, { error: 'incorrect_device_code' });
    if (!device.authorizedBy) return json(res, 200, { error: 'authorization_pending' });
    if (!device.token) {
      device.token = `ghe-fixture-oauth-${randomUUID()}`;
      const scimUser = [...users.values()].find((user) => user.userName === device.authorizedBy && user.active);
      tokens.set(device.token, { identity: device.authorizedBy, ghLogin: scimUser?.githubLogin });
      evidence.tokensIssued.push({ nameId: device.authorizedBy, ghLogin: scimUser?.githubLogin ?? null });
    }
    return json(res, 200, { access_token: device.token, token_type: 'bearer', scope: device.scope ?? '' });
  }

  function enterpriseSsoPage(res, url) {
    const returnTo = escapeHtml(url.searchParams.get('return_to') ?? '/');
    return html(res, `<h1>Single sign-on to ${slug}</h1>
      <form method="get" action="/enterprises/${slug}/saml/initiate">
        <input type="hidden" name="return_to" value="${returnTo}">
        <button type="submit">Continue</button>
      </form>`);
  }

  /** Sends an unsigned HTTP-Redirect AuthnRequest, as GitHub does, to the configured IdP. */
  function samlInitiate(res, url) {
    const id = `_${randomUUID()}`;
    pendingAuthnRequests.add(id);
    const request = [
      `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"`,
      ` ID="${id}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${idpSsoUrl}"`,
      ` AssertionConsumerServiceURL="${acsUrl}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">`,
      `<saml:Issuer>${issuer}</saml:Issuer>`,
      `<samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent" AllowCreate="true"/>`,
      `</samlp:AuthnRequest>`,
    ].join('');
    const encoded = deflateRawSync(Buffer.from(request)).toString('base64');
    const relayState = url.searchParams.get('return_to') ?? '/';
    return redirect(res, `${idpSsoUrl}?SAMLRequest=${encodeURIComponent(encoded)}&RelayState=${encodeURIComponent(relayState)}`);
  }

  async function samlConsume(req, res) {
    const form = await readForm(req);
    const xml = Buffer.from(form.get('SAMLResponse') ?? '', 'base64').toString('utf8');
    const response = {
      destination: attribute(xml, 'Response', 'Destination'),
      inResponseTo: attribute(xml, 'Response', 'InResponseTo'),
      audience: element(xml, 'Audience'),
      nameId: element(xml, 'NameID'),
      signed: /<(?:ds:)?Signature[\s>]/.test(xml),
    };
    const problems = [];
    if (response.destination !== acsUrl) problems.push('destination');
    if (!pendingAuthnRequests.delete(response.inResponseTo)) problems.push('in_response_to');
    if (response.audience !== issuer) problems.push('audience');
    if (!response.nameId) problems.push('name_id');
    if (!response.signed) problems.push('signature_missing');
    evidence.samlResponses.push({ ...response, accepted: problems.length === 0, problems });
    if (problems.length) return html(res, `<h1>SAML response rejected: ${problems.join(', ')}</h1>`, 403);
    const session = randomBytes(16).toString('hex');
    sessions.set(session, response.nameId);
    return redirect(res, form.get('RelayState') || '/', { 'Set-Cookie': `ghe_session=${session}; Path=/; HttpOnly` });
  }

  async function enterUserCode(req, res, signedInAs) {
    const code = (await readForm(req)).get('user_code');
    evidence.deviceCodesEntered.push({ nameId: signedInAs, matched: [...devices.values()].some((device) => device.userCode === code) });
    return html(res, `<h1>Authorize OpenCode</h1>
      <form method="post" action="/login/oauth/authorize">
        <input type="hidden" name="user_code" value="${escapeHtml(code ?? '')}">
        <button type="submit">Authorize opencode</button>
      </form>`);
  }

  async function authorize(req, res, signedInAs) {
    const code = (await readForm(req)).get('user_code');
    const device = [...devices.values()].find((entry) => entry.userCode === code && !entry.authorizedBy);
    if (device) device.authorizedBy = signedInAs;
    evidence.authorizations.push({ nameId: signedInAs, authorized: Boolean(device) });
    return html(res, '<h1>Congratulations, you are all set!</h1>');
  }

  function sessionUser(req) {
    const match = /(?:^|;\s*)ghe_session=([a-f0-9]+)/.exec(req.headers.cookie ?? '');
    return match ? sessions.get(match[1]) : undefined;
  }

  return { baseUrl, handles, handle, evidence, recordHost: (kind, req) => record(evidence.hosts, `${kind}:${hostnameOf(req)}`) };
}

function hostnameOf(req) {
  return (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
}

function record(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function userCode() {
  const part = () => randomBytes(2).toString('hex').toUpperCase();
  return `${part()}-${part()}`;
}

function attribute(xml, tag, name) {
  const match = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*\\s${name}="([^"]*)"`).exec(xml);
  return match?.[1];
}

function element(xml, tag) {
  const match = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([^<]*)</(?:\\w+:)?${tag}>`).exec(xml);
  return match?.[1]?.trim();
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw);
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

async function readForm(req) {
  return new URLSearchParams(await readBody(req));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function html(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><body>${body}</body></html>`);
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
}

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
