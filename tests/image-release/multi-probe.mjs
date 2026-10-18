// In-network HTTP probe of the multi-enterprise qualification. Runs inside the qualification's mock container
// (`docker compose exec -T mock node /fixtures/multi-probe.mjs <base64url JSON>`), so it reaches SSO and Login,
// which are never published. Fixed targets only; redirects are reported, never followed. Prints one JSON line.
const TARGETS = Object.freeze({
  proxy: 'http://proxy:3000',
  proxy2: 'http://proxy2:3000',
  sso: 'http://sso:7001',
  login: 'http://login:7003',
  console: 'http://console:7004',
  mock: 'http://127.0.0.1:8002',
});
const HEADERS = new Set(['cookie', 'x-internal-token', 'authorization', 'x-user-identity', 'content-type',
  'anthropic-version', 'anthropic-beta', 'x-claude-code-optimized', 'origin', 'accept', 'sec-fetch-site']);
const MAX_TEXT = 256 * 1024;

function decode(encoded) {
  const value = JSON.parse(Buffer.from(String(encoded), 'base64url').toString('utf8'));
  if (!value || !Array.isArray(value.requests) || value.requests.length < 1 || value.requests.length > 40) {
    throw new Error('invalid_probe');
  }
  return value.requests;
}

function headersOf(request) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (!HEADERS.has(name.toLowerCase()) || typeof value !== 'string') throw new Error('header_not_allowed');
    headers[name] = value;
  }
  return headers;
}

async function send(request) {
  const origin = TARGETS[request.target];
  if (!origin || typeof request.path !== 'string' || !request.path.startsWith('/') || request.path.startsWith('//')) {
    throw new Error('invalid_target');
  }
  const method = request.method ?? 'GET';
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('invalid_method');
  const headers = headersOf(request);
  let body;
  if (request.form) {
    body = new URLSearchParams(request.form).toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (request.body !== undefined) {
    body = JSON.stringify(request.body);
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(origin + request.path, {
    method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(request.timeoutMs ?? 30000),
  });
  const text = (await response.text()).slice(0, MAX_TEXT);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // HTML, XML or SSE.
  }
  return {
    status: response.status,
    headers: {
      location: response.headers.get('location'),
      'content-type': response.headers.get('content-type'),
      deprecation: response.headers.get('deprecation'),
      'set-cookie': response.headers.getSetCookie(),
    },
    json,
    text: json === null ? text : undefined,
  };
}

try {
  const results = [];
  for (const request of decode(process.argv[2])) {
    try {
      results.push(await send(request));
    } catch (error) {
      results.push({ status: 0, error: /^[a-z_]+$/.test(error?.message ?? '') ? error.message : 'transport_error' });
    }
  }
  console.log(JSON.stringify({ probe: true, results }));
} catch {
  console.log(JSON.stringify({ probe: true, error: 'invalid_probe' }));
  process.exitCode = 1;
}
