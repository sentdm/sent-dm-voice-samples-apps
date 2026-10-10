import http from 'node:http';
import { openTunnel } from '../src/tunnel.js';
const gateway = http.createServer((req, res) => { res.statusCode = req.url === '/health' ? 200 : 404; res.end(req.url === '/health' ? '{"ok":true}' : 'Not found'); });
await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
let tunnel: Awaited<ReturnType<typeof openTunnel>> | undefined;
try {
  const port = (gateway.address() as import('node:net').AddressInfo).port;
  console.log('Opening temporary callback-only tunnel for smoke test.');
  tunnel = await openTunnel(port, message => console.error('Tunnel error:', message));
  const health = await fetch(tunnel.url + '/health', { signal: AbortSignal.timeout(12000) });
  const blocked = await fetch(tunnel.url + '/api/state', { signal: AbortSignal.timeout(12000) });
  if (health.status !== 200 || blocked.status !== 404) throw new Error(`Unexpected responses health=${health.status}, management=${blocked.status}`);
  console.log('Public tunnel smoke passed: /health=200, /api/state=404. Closing tunnel.');
} finally {
  tunnel?.stop();
  await new Promise<void>(resolve => gateway.close(() => resolve()));
}
