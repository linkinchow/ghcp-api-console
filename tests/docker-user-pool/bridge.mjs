import http from 'node:http';
const targets = new Map([['17300', 'http://proxy:3000'], ['17301', 'http://sso:7001'], ['17302', 'http://mock:8002'], ['17303', 'http://login:7003'], ['17304', 'http://console:7004']]);
if (process.env.POOL_SMOKE_GATEWAY === 'true') targets.set('17305', 'http://litellm:4000');
for (const [port, base] of targets) {
  http.createServer((req, res) => {
    const target = new URL(req.url, base);
    const upstream = http.request({ hostname: new URL(base).hostname, port: new URL(base).port, path: target.pathname + target.search, method: req.method, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Local smoke bridge unavailable'); });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }).listen(Number(port), '0.0.0.0');
}
console.log('Local smoke UI bridge ready');
