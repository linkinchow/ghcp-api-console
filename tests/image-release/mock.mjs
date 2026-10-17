import http from 'node:http';

const OUTPUT_CONFIG_BETA = 'mid-conversation-output-config-2026-07-01';
const MAX_REQUEST_BYTES = 200_000;
const requests = [];

const MODELS = {
  data: [
    {
      id: 'claude-opus-5.5',
      supported_endpoints: ['/v1/messages'],
      capabilities: { limits: { max_context_window_tokens: 200000, max_output_tokens: 8192 } },
    },
  ],
};

const STREAM_BODY = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_release","model":"claude-opus-5.5","usage":{"input_tokens":1}}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

const MESSAGE_BODY = {
  id: 'msg_release',
  model: 'claude-opus-5.5',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'RELEASE_MOCK_OK' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
};

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function readBoundedBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_REQUEST_BYTES) throw new Error('bounded request required');
  }
  return JSON.parse(raw);
}

async function handleMessages(req, res) {
  const body = await readBoundedBody(req);
  const item = {
    beta: req.headers['anthropic-beta'],
    version: req.headers['anthropic-version'],
    oauthMatches: req.headers.authorization === 'Bearer release-fixture-oauth',
    messages: body.messages,
    model: body.model,
    stream: body.stream,
  };
  requests.push(item);

  // Mirrors the upstream rejection when message-level output_config arrives without the beta header.
  const hasMessageOutputConfig = (body.messages || []).some((message) => Object.hasOwn(message, 'output_config'));
  if (hasMessageOutputConfig && !item.beta?.includes(OUTPUT_CONFIG_BETA)) {
    const error = { type: 'invalid_request_error', message: 'messages.1.output_config: Extra inputs are not permitted' };
    return json(res, { type: 'error', error }, 400);
  }

  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(STREAM_BODY);
    return;
  }
  return json(res, MESSAGE_BODY);
}

http
  .createServer(async (req, res) => {
    if (req.url === '/healthz') return json(res, { fixture: true });
    if (req.url === '/evidence') return json(res, { requests });
    if (req.url === '/models') return json(res, MODELS);
    if (req.url === '/v1/messages' && req.method === 'POST') return handleMessages(req, res);
    json(res, { error: 'fixture_destination_not_allowed' }, 403);
  })
  .listen(8002, '0.0.0.0');
