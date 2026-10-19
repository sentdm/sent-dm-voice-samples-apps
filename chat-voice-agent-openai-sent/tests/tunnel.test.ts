import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { describeTunnel, tunnelConfigFromEnv } from "../server/tunnel"

/** Runs `body` with a home folder that holds only what the test writes, so the real ngrok config stays out. */
async function withHome(body: (home: string) => void | Promise<void>) {
  const home = await mkdtemp(path.join(os.tmpdir(), "tunnel-home-"))
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
  Object.assign(process.env, { HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "AppData", "Local"), XDG_CONFIG_HOME: path.join(home, ".config") })
  try { await body(home); } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    await rm(home, { recursive: true, force: true })
  }
}

test("ngrok is the default tunnel; TUNNEL_PROVIDER switches to Cloudflare and rejects unknown values", () => withHome(() => {
  assert.equal(tunnelConfigFromEnv({}).provider, "ngrok")
  assert.equal(tunnelConfigFromEnv({ TUNNEL_PROVIDER: " " }).provider, "ngrok")
  assert.equal(tunnelConfigFromEnv({ TUNNEL_PROVIDER: "Cloudflare" }).provider, "cloudflare")
  assert.throws(() => tunnelConfigFromEnv({ TUNNEL_PROVIDER: "localtunnel" }), /TUNNEL_PROVIDER must be ngrok or cloudflare/)
}))

test("NGROK_AUTHTOKEN is read once and removed from the environment, so cloudflared never inherits it", () => withHome(() => {
  const env: Record<string, string | undefined> = { NGROK_AUTHTOKEN: " token-from-env ", NGROK_DOMAIN: " demo.ngrok-free.app " }
  assert.deepEqual(tunnelConfigFromEnv(env), { provider: "ngrok", ngrokAuthtoken: "token-from-env", ngrokDomain: "demo.ngrok-free.app" })
  assert.equal("NGROK_AUTHTOKEN" in env, false)
  const cloudflare: Record<string, string | undefined> = { TUNNEL_PROVIDER: "cloudflare", NGROK_AUTHTOKEN: "token-from-env" }
  tunnelConfigFromEnv(cloudflare)
  assert.equal("NGROK_AUTHTOKEN" in cloudflare, false)
}))

test("without NGROK_AUTHTOKEN, ngrok uses the token saved by `ngrok config add-authtoken`", () => withHome(async home => {
  assert.equal(tunnelConfigFromEnv({}).ngrokAuthtoken, undefined)
  assert.match(describeTunnel(tunnelConfigFromEnv({})), /no authtoken is set.*NGROK_AUTHTOKEN.*TUNNEL_PROVIDER=cloudflare/)
  await mkdir(path.join(home, ".ngrok2"))
  await writeFile(path.join(home, ".ngrok2", "ngrok.yml"), `version: "3"\nagent:\n    authtoken: "saved-token" # from the CLI\n`)
  assert.equal(tunnelConfigFromEnv({}).ngrokAuthtoken, "saved-token")
  assert.equal(tunnelConfigFromEnv({ NGROK_AUTHTOKEN: "env-wins" }).ngrokAuthtoken, "env-wins")
  assert.equal(tunnelConfigFromEnv({ TUNNEL_PROVIDER: "cloudflare" }).ngrokAuthtoken, undefined, "Cloudflare never reads the ngrok config")
}))
