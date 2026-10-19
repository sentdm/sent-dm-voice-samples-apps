import { existsSync, readFileSync } from 'node:fs';
import { Resolver } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { LookupFunction } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { SessionBuilder, type Session } from '@ngrok/ngrok';
import { bin, install, Tunnel } from 'cloudflared';
export interface TunnelHandle { url: string; stop(): void; }
export type TunnelProvider = 'ngrok' | 'cloudflare';
export interface TunnelConfig { provider: TunnelProvider; ngrokAuthtoken?: string; ngrokDomain?: string; }

const NGROK_TOKEN_HINT = 'Set NGROK_AUTHTOKEN (free account: https://dashboard.ngrok.com/get-started/your-authtoken), or set TUNNEL_PROVIDER=cloudflare.';
const NGROK_TOKEN_REJECTED = 'ngrok rejected the authtoken. Check NGROK_AUTHTOKEN, or the token saved with `ngrok config add-authtoken`.';
const NGROK_ERRORS: Record<string, string> = {
  ERR_NGROK_105: NGROK_TOKEN_REJECTED,
  ERR_NGROK_107: NGROK_TOKEN_REJECTED,
  ERR_NGROK_108: 'Your ngrok account already has 3 agent sessions online, the free-plan limit. Stop another ngrok agent or app (https://dashboard.ngrok.com/agents), or set TUNNEL_PROVIDER=cloudflare.',
  ERR_NGROK_334: 'NGROK_DOMAIN is already online in another ngrok agent. Stop that agent, or remove NGROK_DOMAIN.',
};

/**
 * Reads the tunnel settings once at startup: TUNNEL_PROVIDER (ngrok, the default, or cloudflare), NGROK_AUTHTOKEN and
 * NGROK_DOMAIN. Without NGROK_AUTHTOKEN, ngrok uses the token the ngrok agent saved (`ngrok config add-authtoken`).
 * The token is then removed from the environment, so cloudflared never inherits it.
 */
export function tunnelConfigFromEnv(env: Record<string, string | undefined> = process.env): TunnelConfig {
  const provider = (env.TUNNEL_PROVIDER?.trim() || 'ngrok').toLowerCase();
  if (provider !== 'ngrok' && provider !== 'cloudflare') throw new Error('TUNNEL_PROVIDER must be ngrok or cloudflare.');
  const ngrokAuthtoken = env.NGROK_AUTHTOKEN?.trim() || (provider === 'ngrok' ? savedNgrokAuthtoken() : undefined);
  delete env.NGROK_AUTHTOKEN;
  return { provider, ngrokAuthtoken, ngrokDomain: env.NGROK_DOMAIN?.trim() || undefined };
}

/** One line for the startup log. */
export function describeTunnel(config: TunnelConfig): string {
  if (config.provider === 'cloudflare') return 'Callback tunnel: Cloudflare quick tunnel.';
  if (!config.ngrokAuthtoken) return `Callback tunnel: ngrok, but no authtoken is set, so Start will fail. ${NGROK_TOKEN_HINT}`;
  return `Callback tunnel: ngrok${config.ngrokDomain ? ` on ${config.ngrokDomain}` : ''}.`;
}

/** The token in the ngrok agent's own config file, at the default location for this OS (agent v3, then v2). */
function savedNgrokAuthtoken(): string | undefined {
  const home = os.homedir();
  const files = [
    process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'ngrok', 'ngrok.yml')
      : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'ngrok', 'ngrok.yml')
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'ngrok', 'ngrok.yml'),
    path.join(home, '.ngrok2', 'ngrok.yml'),
  ];
  for (const file of files) {
    try {
      const token = readFileSync(file, 'utf8').match(/^\s*authtoken:\s*["']?([^\s"'#]+)/m)?.[1];
      if (token) return token;
    } catch { /* No config file at this location. */ }
  }
  return undefined;
}

/**
 * Resolves once `<url>/health` answers 200. A quick-tunnel hostname appears in DNS a few seconds after cloudflared
 * reports "connected", and an early NXDOMAIN would stay in the OS resolver's cache for 60 s (trycloudflare.com's
 * negative TTL). So for Cloudflare this asks Cloudflare's public resolver directly and connects to the address it
 * returns. ngrok hostnames are wildcard DNS records that resolve at once, but a new endpoint answers 404 for a moment.
 */
async function waitUntilReachable(url: string, provider: TunnelProvider, timeoutMs = 45_000): Promise<void> {
  const target = new URL('/health', url);
  const resolver = new Resolver();
  resolver.setServers(['1.1.1.1', '1.0.0.1']);
  const deadline = Date.now() + timeoutMs;
  let address: string | undefined, last = '';
  while (Date.now() < deadline) {
    try {
      let lookup: LookupFunction | undefined;
      if (provider === 'cloudflare') {
        address ??= (await resolver.resolve4(target.hostname))[0];
        const resolved = address;
        lookup = (_host, options, callback) => options.all ? callback(null, [{ address: resolved, family: 4 }]) : callback(null, resolved, 4);
      }
      const status = await new Promise<number>((resolve, reject) => {
        const request = (target.protocol === 'https:' ? https : http).get(target, { lookup, timeout: 5_000 }, response => { response.resume(); resolve(response.statusCode ?? 0); });
        request.on('timeout', () => request.destroy(new Error('timed out')));
        request.on('error', reject);
      });
      if (status === 200) return;
      last = `HTTP ${status}`;
    } catch (e) { last = (e as NodeJS.ErrnoException).code ?? (e as Error).message; }
    await sleep(1_500);
  }
  throw new Error(`The public callback tunnel did not become reachable within ${timeoutMs / 1000} s (last: ${last}). Check access to ${provider === 'ngrok' ? 'ngrok' : 'Cloudflare'}.`);
}

/** Opens the configured tunnel to the local port and resolves only once its public URL actually serves /health. */
export async function openTunnel(port: number, onFailure: (message: string) => void, config: TunnelConfig): Promise<TunnelHandle> {
  return config.provider === 'ngrok' ? openNgrokTunnel(port, config) : openCloudflareTunnel(port, onFailure);
}

// One ngrok agent session per process, shared by every Start. A free account allows 3 sessions at once, and a closed
// session keeps its slot until the process exits, so a new session per Start would soon reach that limit.
let ngrokSession: Promise<Session> | undefined;

function ngrokError(e: unknown): Error {
  const { errorCode, message } = e as { errorCode?: string; message?: string };
  const text = (errorCode && NGROK_ERRORS[errorCode]) || `ngrok: ${String(message).split('\n')[0]}`;
  return new Error(errorCode ? `${text} (${errorCode})` : text);
}

async function openNgrokTunnel(port: number, config: TunnelConfig): Promise<TunnelHandle> {
  if (!config.ngrokAuthtoken) throw new Error(`ngrok needs an authtoken. ${NGROK_TOKEN_HINT}`);
  ngrokSession ??= new SessionBuilder().authtoken(config.ngrokAuthtoken).connect().catch(e => { ngrokSession = undefined; throw ngrokError(e); });
  const session = await Promise.race([ngrokSession, sleep(35_000, undefined, { ref: false }).then(() => {
    throw new Error('ngrok did not connect within 35 seconds. Check internet/firewall access to ngrok.');
  })]);
  const endpoint = session.httpEndpoint();
  if (config.ngrokDomain) endpoint.domain(config.ngrokDomain);
  const listener = await endpoint.listenAndForward(`http://127.0.0.1:${port}`).catch(e => { throw ngrokError(e); });
  const url = listener.url()!;
  // Closes only this endpoint; the session stays for the next Start.
  const stop = () => { listener.close().catch(() => {}); };
  try { await waitUntilReachable(url, 'ngrok'); } catch (e) { stop(); throw e; }
  return { url, stop };
}

async function openCloudflareTunnel(port: number, onFailure: (message: string) => void): Promise<TunnelHandle> {
  if (!existsSync(bin)) await install(bin);
  const tunnel = Tunnel.quick(`http://127.0.0.1:${port}`, { protocol: 'http2', 'no-autoupdate': true });
  let stopping = false;
  return new Promise((resolve, reject) => {
    let url = '', connected = false, checking = false, settled = false;
    const finish = () => {
      // cloudflared reports each of its connections; the reachability check must start only once.
      if (!url || !connected || checking || settled) return;
      checking = true; clearTimeout(timer);
      waitUntilReachable(url, 'cloudflare').then(() => {
        if (settled) return;
        settled = true;
        resolve({ url, stop: () => { stopping = true; tunnel.stop(); } });
      }, fail);
    };
    const fail = (error: Error) => {
      if (stopping) return;
      if (!settled) { settled = true; clearTimeout(timer); stopping = true; tunnel.stop(); reject(error); }
      else onFailure(error.message);
    };
    const timer = setTimeout(() => fail(new Error('Callback tunnel did not connect within 35 seconds. Check internet/firewall access to Cloudflare, or use ngrok instead.')), 35_000);
    tunnel.on('url', value => { url = value; finish(); });
    tunnel.on('connected', () => { connected = true; finish(); });
    tunnel.on('error', fail);
    tunnel.on('exit', code => fail(new Error(`Callback tunnel stopped (${code}).`)));
  });
}
