// Isolated Azure loader transport ONLY. Start explicitly on vm-ghcp-test-load:
// POOL_AZURE_SPLIT_FIXTURE=1 node azure-load-bridge.mjs --confirm-isolated-azure-fixture
// The service VM publishes its fixture bridge on 10.89.0.4 (never a public bind).
// This does not replace any runner's HTTP manifest, SQL marker or opt-in gates.
import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = 'ghcp-user-pool-mysql-test';
const LOADER_IP = '10.89.0.5';
const SERVICE_IP = '10.89.0.4';
// No arguments, environment variables, URLs or incoming bytes can change these.
export const FORWARDS = Object.freeze([18100, 18101, 18102, 18103, 18104, 18105, 18106, 18107, 33184]
  .map(port => Object.freeze({ listenHost: '127.0.0.1', port, targetHost: SERVICE_IP, targetPort: port })));
const check = (condition, label) => { if (!condition) throw new Error(label); };

export function checkOptIn(args, env, platform) {
  check(args.length === 1 && args[0] === '--confirm-isolated-azure-fixture'
    && env.POOL_AZURE_SPLIT_FIXTURE === '1', 'explicit_isolated_azure_confirmation_required');
  check(platform === 'linux', 'azure_loader_linux_required');
}

export function verifyLoader(metadata, marker, interfaces) {
  check(marker.split(/\r?\n/).filter(line => line.startsWith('purpose=')).length === 1
    && marker.split(/\r?\n/).includes('purpose=ghcp-user-pool-isolated-test'), 'wrong_azure_fixture_marker');
  check(metadata?.compute?.name === 'vm-ghcp-test-load'
    && metadata.compute.osType === 'Linux'
    && metadata.compute.resourceGroupName?.toLowerCase() === 'rg-ghcp-user-pool', 'wrong_azure_loader_identity');
  const addresses = metadata?.network?.interface?.flatMap(nic => nic.ipv4?.ipAddress ?? []) ?? [];
  check(addresses.some(address => address.privateIpAddress === LOADER_IP), 'wrong_azure_loader_private_ip');
  check(Object.values(interfaces).flatMap(addresses => addresses ?? [])
    .some(address => address.address === LOADER_IP && !address.internal), 'azure_loader_interface_missing');
}

function readMetadata() {
  // Direct link-local HTTP, not fetch/proxy environment variables, Azure CLI, MI
  // tokens or subscription APIs. No redirects and a bounded response/deadline.
  return new Promise((resolveMetadata, reject) => {
    const request = http.get({ hostname: '169.254.169.254', port: 80,
      path: '/metadata/instance?api-version=2021-02-01', headers: { Metadata: 'true' },
      agent: false, signal: AbortSignal.timeout(5000) }, response => {
      if (response.statusCode !== 200) { request.destroy(new Error('azure_metadata_status')); return; }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 64 * 1024) request.destroy(new Error('azure_metadata_size'));
        else chunks.push(chunk);
      });
      response.once('error', () => reject(new Error('azure_metadata_unavailable')));
      response.once('end', () => {
        try { resolveMetadata(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('azure_metadata_invalid')); }
      });
    });
    request.once('error', () => reject(new Error('azure_metadata_unavailable')));
  });
}

async function startBridge() {
  const servers = [];
  const sockets = new Set();
  let ready = false, closing = false;
  function shutdown() {
    if (closing) return;
    closing = true;
    ready = false;
    for (const server of servers) server.close();
    for (const socket of sockets) socket.destroy();
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  }
  try {
    for (const { listenHost, port, targetHost, targetPort } of FORWARDS) {
      const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true }, client => {
        if (!ready || sockets.size >= 1024) { client.destroy(); return; }
        // Pin the source NIC too; no hostnames, routing override or user target.
        const upstream = net.connect({ host: targetHost, port: targetPort, localAddress: LOADER_IP, allowHalfOpen: true });
        const destroy = () => { client.destroy(); upstream.destroy(); };
        sockets.add(client); sockets.add(upstream);
        for (const socket of [client, upstream]) {
          socket.on('error', destroy);
          socket.on('close', () => { sockets.delete(socket); destroy(); });
        }
        upstream.setTimeout(5000, destroy);
        upstream.once('connect', () => {
          upstream.setTimeout(120000);
          client.setTimeout(120000, destroy);
          // Raw, backpressured bytes preserve SSE, cancellation and MySQL. No
          // retry/replay; half-close permits the other direction to finish.
          client.pipe(upstream); upstream.pipe(client);
        });
      });
      servers.push(server);
      await new Promise((resolveListening, reject) => {
        server.once('error', reject);
        server.once('listening', () => { server.off('error', reject); resolveListening(); });
        server.listen({ host: listenHost, port, exclusive: true });
      });
      server.on('error', () => {
        console.error('FAIL isolated_azure_load_bridge_listener');
        process.exitCode = 1;
        shutdown();
      });
      check(!closing, 'azure_bridge_start_interrupted');
    }
    ready = true;
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    console.log(`AZURE_LOAD_BRIDGE_READY project=${PROJECT} ports=${FORWARDS.map(entry => entry.port).join(',')}`);
  } catch (error) { shutdown(); throw error; }
}

export async function main(args = process.argv.slice(2)) {
  try {
    // Refuse before reading files, metadata, connecting or opening listeners.
    checkOptIn(args, process.env, process.platform);
    const marker = await readFile('/etc/ghcp-test-environment', 'utf8');
    const metadata = await readMetadata();
    verifyLoader(metadata, marker, networkInterfaces());
    await startBridge();
    return 0;
  } catch {
    // Never print raw metadata, environment, addresses returned by a server,
    // network errors, credentials or filesystem content.
    console.error('FAIL isolated_azure_load_bridge');
    return 1;
  }
}

// Importing for offline tests performs no I/O and never starts a listener.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
