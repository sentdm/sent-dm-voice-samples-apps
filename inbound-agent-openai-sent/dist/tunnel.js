import { existsSync } from 'node:fs';
import { Resolver } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { bin, install, Tunnel } from 'cloudflared';
/**
 * Resolves once `<url>/health` answers 200. A quick-tunnel hostname appears in DNS a few seconds after cloudflared
 * reports "connected", and an early NXDOMAIN would stay in the OS resolver's cache for 60 s (trycloudflare.com's
 * negative TTL). So this asks Cloudflare's public resolver directly and connects to the address it returns.
 */
async function waitUntilReachable(url, timeoutMs = 45_000) {
    const target = new URL('/health', url);
    const resolver = new Resolver();
    resolver.setServers(['1.1.1.1', '1.0.0.1']);
    const deadline = Date.now() + timeoutMs;
    let address, last = '';
    while (Date.now() < deadline) {
        try {
            address ??= (await resolver.resolve4(target.hostname))[0];
            const resolved = address;
            const lookup = (_host, options, callback) => options.all ? callback(null, [{ address: resolved, family: 4 }]) : callback(null, resolved, 4);
            const status = await new Promise((resolve, reject) => {
                const request = (target.protocol === 'https:' ? https : http).get(target, { lookup, timeout: 5_000 }, response => { response.resume(); resolve(response.statusCode ?? 0); });
                request.on('timeout', () => request.destroy(new Error('timed out')));
                request.on('error', reject);
            });
            if (status === 200)
                return;
            last = `HTTP ${status}`;
        }
        catch (e) {
            last = e.code ?? e.message;
        }
        await sleep(1_500);
    }
    throw new Error(`The public callback tunnel did not become reachable within ${timeoutMs / 1000} s (last: ${last}). Check access to Cloudflare.`);
}
/** Opens a quick tunnel to the local port and resolves only once its public URL actually serves /health. */
export async function openTunnel(port, onFailure) {
    if (!existsSync(bin))
        await install(bin);
    const tunnel = Tunnel.quick(`http://127.0.0.1:${port}`, { protocol: 'http2', 'no-autoupdate': true });
    let stopping = false;
    return new Promise((resolve, reject) => {
        let url = '', connected = false, checking = false, settled = false;
        const finish = () => {
            // cloudflared reports each of its connections; the reachability check must start only once.
            if (!url || !connected || checking || settled)
                return;
            checking = true;
            clearTimeout(timer);
            waitUntilReachable(url).then(() => {
                if (settled)
                    return;
                settled = true;
                resolve({ url, stop: () => { stopping = true; tunnel.stop(); } });
            }, fail);
        };
        const fail = (error) => {
            if (stopping)
                return;
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                stopping = true;
                tunnel.stop();
                reject(error);
            }
            else
                onFailure(error.message);
        };
        const timer = setTimeout(() => fail(new Error('Callback tunnel did not connect within 35 seconds. Check internet/firewall access to Cloudflare.')), 35_000);
        tunnel.on('url', value => { url = value; finish(); });
        tunnel.on('connected', () => { connected = true; finish(); });
        tunnel.on('error', fail);
        tunnel.on('exit', code => fail(new Error(`Callback tunnel stopped (${code}).`)));
    });
}
//# sourceMappingURL=tunnel.js.map