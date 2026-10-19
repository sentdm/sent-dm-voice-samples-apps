import http from 'node:http';
import { describeTunnel, openTunnel, tunnelConfigFromEnv } from '../src/tunnel.js';
// The same settings as the app: TUNNEL_PROVIDER, NGROK_AUTHTOKEN and NGROK_DOMAIN from the shell or ./.env.
try { process.loadEnvFile(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
const config = tunnelConfigFromEnv();
const gateway = http.createServer((req, res) => { res.statusCode = req.url === '/health' ? 200 : 404; res.end(req.url === '/health' ? '{"ok":true}' : 'Not found'); });
await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
let tunnel: Awaited<ReturnType<typeof openTunnel>> | undefined;
try {
  const port = (gateway.address() as import('node:net').AddressInfo).port;
  console.log(`${describeTunnel(config)}\nOpening temporary callback-only tunnel for smoke test.`);
  // Twice, like Start, Stop, Start: the second ngrok endpoint must reuse the first one's agent session.
  for (const round of [1, 2]) {
    tunnel = await openTunnel(port, message => console.error('Tunnel error:', message), config);
    const health = await fetch(tunnel.url + '/health', { signal: AbortSignal.timeout(12000) });
    const blocked = await fetch(tunnel.url + '/api/state', { signal: AbortSignal.timeout(12000) });
    if (health.status !== 200 || blocked.status !== 404) throw new Error(`Unexpected responses health=${health.status}, management=${blocked.status}`);
    console.log(`Round ${round}: public tunnel smoke passed: /health=200, /api/state=404. Closing tunnel.`);
    tunnel.stop(); tunnel = undefined;
  }
} finally {
  tunnel?.stop();
  await new Promise<void>(resolve => gateway.close(() => resolve()));
}
