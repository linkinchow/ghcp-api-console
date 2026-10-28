// Screenshot environment only. Listens on 127.0.0.1:<EDGE_PORT> (default 80) in front of
// tests/docker-user-pool/mock-services.mjs and adds the two GitHub endpoints that fixture lacks:
//   - GET <api>/enterprises/<slug>/settings/billing/usage/summary  (AI Credits page, synthetic numbers)
//   - GET /user and GET /models for one synthetic Models-admin token  (Models page)
// Every other request is forwarded unchanged (Host header included) to the fixture, which routes GHE.com
// tenants by Host. Zero dependencies, synthetic data only, never reaches the internet.
import http from 'node:http';

const PORT = Number(process.env.EDGE_PORT ?? 80);
const UPSTREAM_PORT = Number(process.env.EDGE_UPSTREAM_PORT ?? 8002);
const SEAT_PATS = new Set((process.env.EDGE_SEAT_PATS ?? '').split(',').filter(Boolean));
const MODELS_ADMIN_TOKEN = process.env.EDGE_MODELS_ADMIN_TOKEN ?? '';
const MODELS_ADMIN_LOGIN = process.env.EDGE_MODELS_ADMIN_LOGIN ?? 'example-admin';

const USAGE = new Map([
  // year-month offset from the current month -> grossQuantity of copilot_ai_unit
  [-1, 18342.5],
  [0, 7421.25],
]);

const MODELS = [
  model('claude-opus-5.2', 'Claude Opus 5.2', 'Anthropic', ['/v1/messages', '/chat/completions'], 200000, 64000),
  model('claude-sonnet-5', 'Claude Sonnet 5', 'Anthropic', ['/v1/messages', '/chat/completions'], 200000, 64000),
  model('claude-haiku-4.5', 'Claude Haiku 4.5', 'Anthropic', ['/v1/messages', '/chat/completions'], 200000, 32000),
  model('gpt-5.1', 'GPT-5.1', 'OpenAI', ['/chat/completions', '/responses'], 400000, 128000),
  model('gpt-5-mini', 'GPT-5 mini', 'OpenAI', ['/chat/completions', '/responses'], 264000, 64000),
  model('text-embedding-3-small', 'Embedding V3 small', 'OpenAI', [], undefined, undefined, 'embeddings'),
];

function model(id, name, vendor, endpoints, context, output, type = 'chat') {
  return {
    id, name, vendor, object: 'model', version: id, preview: false, model_picker_enabled: type === 'chat',
    supported_endpoints: endpoints,
    capabilities: {
      family: id, type, object: 'model_capabilities', tokenizer: 'o200k_base',
      limits: context === undefined ? {} : { max_context_window_tokens: context, max_output_tokens: output },
      supports: type === 'chat' ? { streaming: true, tool_calls: true, parallel_tool_calls: true, vision: true } : {},
    },
    policy: { state: 'enabled' },
  };
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function bearer(req) {
  const auth = req.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
}

function usage(req, res, url) {
  if (!SEAT_PATS.has(bearer(req) ?? '')) return json(res, 401, { message: 'Bad credentials' });
  const year = Number(url.searchParams.get('year'));
  const month = Number(url.searchParams.get('month'));
  const now = new Date();
  const offset = (year - now.getUTCFullYear()) * 12 + (month - (now.getUTCMonth() + 1));
  const quantity = USAGE.get(offset) ?? 0;
  return json(res, 200, {
    timePeriod: { year, month },
    usageItems: [{ product: 'copilot', sku: 'copilot_ai_unit', unitType: 'ai-credits', grossQuantity: quantity }],
  });
}

function forward(req, res) {
  const upstream = http.request({
    host: '127.0.0.1', port: UPSTREAM_PORT, method: req.method, path: req.url, headers: req.headers,
  }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) json(res, 502, { message: 'edge upstream unavailable' }); else res.destroy(); });
  req.pipe(upstream);
}

http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://edge.invalid');
  if (req.method === 'GET' && /^\/enterprises\/[^/]+\/settings\/billing\/usage\/summary$/.test(url.pathname)) {
    return usage(req, res, url);
  }
  if (MODELS_ADMIN_TOKEN && bearer(req) === MODELS_ADMIN_TOKEN) {
    if (req.method === 'GET' && url.pathname === '/user') {
      return json(res, 200, { login: MODELS_ADMIN_LOGIN, id: 4242, type: 'User' });
    }
    if (req.method === 'GET' && url.pathname === '/models') return json(res, 200, { object: 'list', data: MODELS });
    return json(res, 404, { message: 'Not Found' });
  }
  return forward(req, res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`edge mock listening on 127.0.0.1:${PORT} -> 127.0.0.1:${UPSTREAM_PORT}`);
});
