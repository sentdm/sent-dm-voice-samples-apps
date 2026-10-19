import { existsSync, readFileSync } from "node:fs";
import { Resolver } from "node:dns/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { LookupFunction } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { SessionBuilder } from "@ngrok/ngrok";
import { bin, install, Tunnel } from "cloudflared";
import type { TunnelProvider } from "@/lib/shared/types";
import { setTunnelInfo, tunnelInfo } from "./state";

/**
 * Sent only calls public URLs, so the server opens a tunnel to itself when it starts (see
 * instrumentation.ts). Sent's questions and webhooks arrive through it, and a second device opens
 * the phone through it. TUNNEL_PROVIDER picks ngrok, the default, or a Cloudflare quick tunnel.
 * Both get a new URL on every start, unless NGROK_DOMAIN names a fixed ngrok domain.
 */

interface TunnelConfig {
  provider: TunnelProvider;
  ngrokAuthtoken?: string;
  ngrokDomain?: string;
}

const CONNECT_TIMEOUT_MS = 35_000;
const REACHABLE_TIMEOUT_MS = 45_000;
// Answers 200 without a configuration, and warms the callback route for the first question.
const PROBE_PATH = "/api/voice/callback";

const NGROK_TOKEN_HINT =
  "Set NGROK_AUTHTOKEN in .env (free account: https://dashboard.ngrok.com/get-started/your-authtoken), or set TUNNEL_PROVIDER=cloudflare.";
const NGROK_TOKEN_REJECTED =
  "ngrok rejected the authtoken. Check NGROK_AUTHTOKEN, or the token saved with `ngrok config add-authtoken`.";
const NGROK_ERRORS: Record<string, string> = {
  ERR_NGROK_105: NGROK_TOKEN_REJECTED,
  ERR_NGROK_107: NGROK_TOKEN_REJECTED,
  ERR_NGROK_108:
    "Your ngrok account already has 3 agent sessions online, the free-plan limit. Stop another ngrok agent or app (https://dashboard.ngrok.com/agents), or set TUNNEL_PROVIDER=cloudflare.",
  ERR_NGROK_334:
    "NGROK_DOMAIN is already online in another ngrok agent. Stop that agent, or remove NGROK_DOMAIN.",
};

/** Opens the tunnel once per server process. Progress and the URL go to the runtime state. */
export function openTunnel(port: number): void {
  if (tunnelInfo().state !== "off") return;
  let config: TunnelConfig;
  try {
    config = tunnelConfigFromEnv();
  } catch (error) {
    setTunnelInfo({
      state: "failed",
      provider: null,
      fixedUrl: false,
      url: null,
      error: (error as Error).message,
    });
    return;
  }
  const info = {
    provider: config.provider,
    fixedUrl: config.provider === "ngrok" && Boolean(config.ngrokDomain),
  };
  setTunnelInfo({ ...info, state: "opening", url: null, error: null });
  const url =
    config.provider === "ngrok"
      ? startNgrok(port, config)
      : startCloudflare(port);
  url.then(
    (url) => setTunnelInfo({ ...info, state: "open", url, error: null }),
    (error: Error) =>
      setTunnelInfo({
        ...info,
        state: "failed",
        url: null,
        error: error.message,
      })
  );
}

/**
 * Reads TUNNEL_PROVIDER, NGROK_AUTHTOKEN and NGROK_DOMAIN. Without NGROK_AUTHTOKEN, ngrok uses the
 * token the ngrok agent saved (`ngrok config add-authtoken`). The token is then removed from the
 * environment, so cloudflared never inherits it.
 */
function tunnelConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): TunnelConfig {
  const provider = (env.TUNNEL_PROVIDER?.trim() || "ngrok").toLowerCase();
  if (provider !== "ngrok" && provider !== "cloudflare") {
    throw new Error("TUNNEL_PROVIDER must be ngrok or cloudflare.");
  }
  const ngrokAuthtoken =
    env.NGROK_AUTHTOKEN?.trim() ||
    (provider === "ngrok" ? savedNgrokAuthtoken() : undefined);
  delete env.NGROK_AUTHTOKEN;
  return {
    provider,
    ngrokAuthtoken,
    ngrokDomain: env.NGROK_DOMAIN?.trim() || undefined,
  };
}

/** The token in the ngrok agent's own config file, at the default location for this OS (agent v3, then v2). */
function savedNgrokAuthtoken(): string | undefined {
  const home = os.homedir();
  const files = [
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "ngrok", "ngrok.yml")
      : process.platform === "win32"
        ? path.join(
            process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
            "ngrok",
            "ngrok.yml"
          )
        : path.join(
            process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
            "ngrok",
            "ngrok.yml"
          ),
    path.join(home, ".ngrok2", "ngrok.yml"),
  ];
  for (const file of files) {
    try {
      const token = readFileSync(file, "utf8").match(
        /^\s*authtoken:\s*["']?([^\s"'#]+)/m
      )?.[1];
      if (token) return token;
    } catch {
      // No config file at this location.
    }
  }
  return undefined;
}

/** An in-process ngrok agent. It ends with the server process. */
async function startNgrok(port: number, config: TunnelConfig): Promise<string> {
  const authtoken = config.ngrokAuthtoken;
  if (!authtoken) {
    throw new Error(`ngrok needs an authtoken. ${NGROK_TOKEN_HINT}`);
  }
  const listener = await Promise.race([
    (async () => {
      const session = await new SessionBuilder().authtoken(authtoken).connect();
      const endpoint = session.httpEndpoint();
      if (config.ngrokDomain) endpoint.domain(config.ngrokDomain);
      return endpoint.listenAndForward(`http://127.0.0.1:${port}`);
    })().catch((error) => {
      throw ngrokError(error);
    }),
    sleep(CONNECT_TIMEOUT_MS, undefined, { ref: false }).then(() => {
      throw new Error(
        "ngrok did not connect within 35 seconds. Check internet and firewall access to ngrok."
      );
    }),
  ]);
  const url = listener.url()!;
  await waitUntilReachable(url, "ngrok");
  return url;
}

function ngrokError(error: unknown): Error {
  const { errorCode, message } = error as {
    errorCode?: string;
    message?: string;
  };
  const text =
    (errorCode && NGROK_ERRORS[errorCode]) ||
    `ngrok: ${String(message).split("\n")[0]}`;
  return new Error(errorCode ? `${text} (${errorCode})` : text);
}

async function startCloudflare(port: number): Promise<string> {
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
            "The public tunnel did not connect within 35 seconds. Check internet and firewall access to Cloudflare, or use ngrok instead."
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
      ...tunnelInfo(),
      state: "failed",
      url: null,
      error: `The public tunnel stopped (${code}). Restart the app to open a new one.`,
    })
  );
  await waitUntilReachable(url, "cloudflare");
  return url;
}

/**
 * Resolves once the tunnel serves this app. A quick-tunnel hostname appears in DNS a few seconds
 * after cloudflared reports "connected", and an early NXDOMAIN would stay in the system resolver's
 * cache for 60 seconds. So for Cloudflare this asks Cloudflare's public resolver and connects to
 * that address. ngrok hostnames resolve at once, but a new endpoint answers 404 for a moment.
 */
async function waitUntilReachable(
  url: string,
  provider: TunnelProvider
): Promise<void> {
  const target = new URL(PROBE_PATH, url);
  const resolver = new Resolver();
  resolver.setServers(["1.1.1.1", "1.0.0.1"]);
  const deadline = Date.now() + REACHABLE_TIMEOUT_MS;
  let address: string | undefined;
  let last = "";
  while (Date.now() < deadline) {
    try {
      let lookup: LookupFunction | undefined;
      if (provider === "cloudflare") {
        address ??= (await resolver.resolve4(target.hostname))[0];
        const resolved = address;
        lookup = (_host, options, callback) =>
          options.all
            ? callback(null, [{ address: resolved, family: 4 }])
            : callback(null, resolved, 4);
      }
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
    `The public tunnel did not become reachable within 45 seconds (last: ${last}). Check access to ${provider === "ngrok" ? "ngrok" : "Cloudflare"}.`
  );
}
