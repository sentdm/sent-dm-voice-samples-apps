import { existsSync } from "node:fs";
import { Resolver } from "node:dns/promises";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { bin, install, Tunnel } from "cloudflared";
import { setTunnelInfo, tunnelInfo } from "./state";

/**
 * Sent only calls public URLs, so the server opens a Cloudflare quick tunnel to itself when it
 * starts (see instrumentation.ts). Sent's questions and webhooks arrive through it, and a second
 * device opens the phone through it. A quick tunnel gets a new URL on every start.
 */

const CONNECT_TIMEOUT_MS = 35_000;
const REACHABLE_TIMEOUT_MS = 45_000;
// Answers 200 without a configuration, and warms the callback route for the first question.
const PROBE_PATH = "/api/voice/callback";

/** Opens the tunnel once per server process. Progress and the URL go to the runtime state. */
export function openTunnel(port: number): void {
  if (tunnelInfo().state !== "off") return;
  setTunnelInfo({ state: "opening", url: null, error: null });
  start(port).catch((error: Error) =>
    setTunnelInfo({ state: "failed", url: null, error: error.message })
  );
}

async function start(port: number): Promise<void> {
  if (!existsSync(bin)) await install(bin);
  const tunnel = Tunnel.quick(`http://127.0.0.1:${port}`, {
    protocol: "http2",
    "no-autoupdate": true,
  });
  process.once("exit", () => tunnel.stop());

  const url = await new Promise<string>((resolve, reject) => {
    let url = "";
    let connected = false;
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            "The public tunnel did not connect within 35 seconds. Check internet and firewall access to Cloudflare."
          )
        ),
      CONNECT_TIMEOUT_MS
    );
    const ready = () => {
      if (!url || !connected) return;
      clearTimeout(timer);
      resolve(url);
    };
    tunnel.on("url", (value) => {
      url = value;
      ready();
    });
    // cloudflared reports each of its connections; the first one is enough.
    tunnel.once("connected", () => {
      connected = true;
      ready();
    });
    tunnel.on("error", reject);
    tunnel.once("exit", (code) =>
      reject(
        new Error(`The public tunnel stopped (${code}) before it connected.`)
      )
    );
  });

  tunnel.on("exit", (code) =>
    setTunnelInfo({
      state: "failed",
      url: null,
      error: `The public tunnel stopped (${code}). Restart the app to open a new one.`,
    })
  );
  await waitUntilReachable(url);
  setTunnelInfo({ state: "open", url, error: null });
}

/**
 * Resolves once the tunnel serves this app. A quick-tunnel hostname appears in DNS a few seconds
 * after cloudflared reports "connected", and an early NXDOMAIN would stay in the system resolver's
 * cache for 60 seconds. So this asks Cloudflare's public resolver and connects to that address.
 */
async function waitUntilReachable(url: string): Promise<void> {
  const target = new URL(PROBE_PATH, url);
  const resolver = new Resolver();
  resolver.setServers(["1.1.1.1", "1.0.0.1"]);
  const deadline = Date.now() + REACHABLE_TIMEOUT_MS;
  let address: string | undefined;
  let last = "";
  while (Date.now() < deadline) {
    try {
      address ??= (await resolver.resolve4(target.hostname))[0];
      const resolved = address;
      const lookup: LookupFunction = (_host, options, callback) =>
        options.all
          ? callback(null, [{ address: resolved, family: 4 }])
          : callback(null, resolved, 4);
      const status = await new Promise<number>((resolve, reject) => {
        const request = https.get(target, { lookup, timeout: 5_000 }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        request.on("timeout", () => request.destroy(new Error("timed out")));
        request.on("error", reject);
      });
      if (status === 200) return;
      last = `HTTP ${status}`;
    } catch (error) {
      last = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
    }
    await sleep(1_500);
  }
  throw new Error(
    `The public tunnel did not become reachable within 45 seconds (last: ${last}). Check access to Cloudflare.`
  );
}
