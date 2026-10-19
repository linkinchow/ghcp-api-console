// Preloaded into every service of the screenshot environment (node --import).
// Resolves only the fixed local service names and *.ghe.com mock hosts to 127.0.0.1 and refuses every other
// host name, so no process of this environment can reach real GitHub, GHE.com, Copilot or any model.
// It also forces every TCP listener onto 127.0.0.1, so nothing is reachable from the network.
import dns from 'node:dns';
import net from 'node:net';

const LOCAL = new Set(['proxy', 'mock', 'sso', 'login', 'console', 'localhost']);
const WILDCARD = new Set(['0.0.0.0', '::', '::0', '']);
const allowed = (host) => LOCAL.has(host) || host.endsWith('.ghe.com');

function lookup(host, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const name = String(host).toLowerCase();
  const family = net.isIP(name);
  if (family) {
    const all = typeof options === 'object' && options?.all;
    if (all) return process.nextTick(callback, null, [{ address: name, family }]);
    return process.nextTick(callback, null, name, family);
  }
  if (allowed(name)) {
    const all = typeof options === 'object' && options?.all;
    if (all) return process.nextTick(callback, null, [{ address: '127.0.0.1', family: 4 }]);
    return process.nextTick(callback, null, '127.0.0.1', 4);
  }
  const error = Object.assign(new Error(`admin-manual env: blocked host ${name}`), { code: 'ENOTFOUND', hostname: name });
  return process.nextTick(callback, error);
}

dns.lookup = lookup;

const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function loopbackOnly(...args) {
  const [first] = args;
  if (first !== null && typeof first === 'object' && !Array.isArray(first) && 'port' in first) {
    if (first.host === undefined || WILDCARD.has(String(first.host))) args[0] = { ...first, host: '127.0.0.1' };
  } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    if (typeof args[1] === 'string') {
      if (WILDCARD.has(args[1])) args[1] = '127.0.0.1';
    } else {
      args.splice(1, 0, '127.0.0.1');
    }
  }
  return listen.apply(this, args);
};
dns.promises.lookup = (host, options = {}) => new Promise((resolve, reject) => {
  lookup(host, options, (error, address, family) => {
    if (error) reject(error);
    else resolve(Array.isArray(address) ? address : { address, family });
  });
});
