import { createReadStream } from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { createRequire } from "node:module"
import path from "node:path"
import { WebSocketServer } from "ws"
import { Runtime } from "./runtime"
import { Conversations } from "./conversations"
import { Calls } from "./calls"
import { Campaigns } from "./campaigns"
import { createGateway } from "./gateway"
import { createApi, isLocalHost } from "./api"
import { equalSecret } from "./security"
import { sentErrorMessage } from "./sent"
import { describeTunnel, tunnelConfigFromEnv } from "./tunnel"

async function main() {
  // Optional ./.env; variables already set in the shell win.
  try {
    process.loadEnvFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const production = process.argv.includes("--production")
  if (production) (process.env as Record<string, string>).NODE_ENV = "production"
  const port = Number(process.env.PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PORT must be an integer from 1024 to 65535.")

  // Read once, then remove: cloudflared inherits the environment and must never get the keys.
  // tunnelConfigFromEnv() removes NGROK_AUTHTOKEN the same way.
  const envSentKey = process.env.SENT_DM_API_KEY?.trim()
  const envOpenaiKey = process.env.OPENAI_API_KEY?.trim()
  const apiToken = process.env.APP_API_TOKEN?.trim()
  delete process.env.SENT_DM_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.APP_API_TOKEN
  const tunnel = tunnelConfigFromEnv()
  if (apiToken && apiToken.length < 24) throw new Error("APP_API_TOKEN must be at least 24 characters. Generate one with: openssl rand -hex 24")

  const runtime = new Runtime({ dataDir: path.resolve(".sent-agent"), tunnel })
  await runtime.init()
  const conversations = new Conversations(runtime)
  const calls = new Calls(runtime, conversations)
  conversations.calls = calls
  const campaigns = new Campaigns(runtime, conversations, runtime.files)
  await campaigns.load()
  runtime.onConnected = () => {
    conversations.importHistory().then(
      (count) => count && runtime.notice("info", `Loaded ${count} conversation${count === 1 ? "" : "s"} from your Sent message history.`),
      (error) => runtime.notice("error", `Couldn't load your Sent message history: ${sentErrorMessage(error)}`),
    )
  }

  const gateway = createGateway(runtime, conversations, calls)
  await new Promise<void>((resolve, reject) => {
    gateway.once("error", reject)
    gateway.listen(0, "127.0.0.1", resolve)
  })
  runtime.gatewayPort = (gateway.address() as AddressInfo).port

  if (envSentKey && envOpenaiKey) {
    console.log("Checking SENT_DM_API_KEY and OPENAI_API_KEY…")
    await runtime.connect(envSentKey, envOpenaiKey, "env").then(
      () => console.log("Environment keys work."),
      (error) => console.warn(`Environment keys were not used: ${(error as Error).message} Enter keys in the app instead.`),
    )
  } else if (envSentKey || envOpenaiKey) {
    console.warn(`Ignoring environment keys: ${envSentKey ? "OPENAI_API_KEY" : "SENT_DM_API_KEY"} is not set. Enter both keys in the app.`)
  }

  const { default: next } = await import("next")
  const app = next({ dev: !production, dir: process.cwd(), hostname: "localhost", port, turbopack: true })
  const handle = app.getRequestHandler()
  await app.prepare()
  const nextUpgrade = app.getUpgradeHandler()

  const api = createApi(runtime, conversations, calls, campaigns, { port: () => port, apiToken })
  // The browser voice SDK's service worker, served from the package so it always matches the SDK version.
  const serviceWorker = createRequire(import.meta.url).resolve("@sentdm/voice/sw.js")

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/"
    if (url.startsWith("/api/")) return void api(req, res)
    if (url === "/sw.js") {
      res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" })
      return void createReadStream(serviceWorker).pipe(res)
    }
    return void handle(req, res)
  })

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 })
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    if (url.pathname !== "/ws" && url.pathname !== "/bridge") return void nextUpgrade(req, socket, head)
    const host = req.headers.host
    const allowed = isLocalHost(host, port) && req.headers.origin === `http://${host}` && equalSecret(url.searchParams.get("token") ?? "", runtime.csrf)
    if (!allowed) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n")
      socket.destroy()
      return
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", () => {})
      if (url.pathname === "/bridge") return calls.attachBridge(ws, url.searchParams.get("callId") ?? "")
      const clientId = url.searchParams.get("clientId") ?? ""
      if (!/^[\w-]{8,64}$/.test(clientId)) return ws.close(1008, "Missing tab id.")
      runtime.addSocket(ws, clientId)
      ws.on("close", () => runtime.removeSocket(ws))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
  console.log(`\nSent chat + voice agent\nOpen http://localhost:${port}\n${describeTunnel(tunnel)}\nKeys stay in this process. Keep the phone tab open and the computer awake while the agent is on.${apiToken ? "\nCampaign API: on, with APP_API_TOKEN." : ""}\n`)

  let exiting = false
  const shutdown = async () => {
    if (exiting) return
    exiting = true
    console.log("Stopping and restoring your Sent settings…")
    const timeout = setTimeout(() => process.exit(1), 20_000)
    await runtime.close()
    await campaigns.flush().catch(() => {})
    for (const ws of sockets.clients) ws.terminate()
    server.close()
    gateway.close()
    clearTimeout(timeout)
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
