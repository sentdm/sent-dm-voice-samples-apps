import http from "node:http"
import type { Channel } from "@/lib/types"
import { equalSecret } from "./security"
import { readBody } from "./gateway"
import type { Runtime } from "./runtime"
import type { Conversations } from "./conversations"
import type { Calls } from "./calls"
import type { Campaigns } from "./campaigns"

type Body = Record<string, unknown>
type Handler = (body: Body, params: string[]) => unknown
/** method, path, handler, and whether other programs may call it with the API token. */
type Route = [string, RegExp, Handler, { external?: boolean; maxBytes?: number }?]

const text = (value: unknown) => (typeof value === "string" ? value : "")
const by = (value: unknown): "agent" | "human" => {
  if (value !== "agent" && value !== "human") throw new Error("Say who acts: agent or human.")
  return value
}
/** A channel a person chose, or undefined to let Sent's routing pick. */
const channel = (value: unknown): Channel | undefined => {
  if (value === undefined || value === null || value === "") return undefined
  if (value !== "sms" && value !== "whatsapp" && value !== "rcs") throw new Error("Choose SMS, WhatsApp, RCS, or let Sent pick.")
  return value
}
const clientId = (body: Body) => {
  if (typeof body.clientId !== "string" || !/^[\w-]{8,64}$/.test(body.clientId)) throw new Error("Missing tab id.")
  return body.clientId
}

/** The browser is allowed in only on the address it was served from. */
export function isLocalHost(host: string | undefined, port: number) {
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`
}

/**
 * The local management API. Only this computer can reach it: the server
 * listens on 127.0.0.1, the Host must be local, and every POST needs the same
 * origin and the CSRF token from GET /api/session.
 */
export function createApi(rt: Runtime, conversations: Conversations, calls: Calls, campaigns: Campaigns, options: { port: () => number; apiToken?: string }) {
  const conversation = (id: string) => rt.store.get(id)
  const external = { external: true }
  const routes: Route[] = [
    // Campaigns: the console uses these, and so can your own systems, with APP_API_TOKEN.
    ["GET", /^\/api\/campaigns$/, () => campaigns.summaries(), external],
    ["GET", /^\/api\/campaigns\/([\w-]+)$/, (_b, [id]) => ({ ...campaigns.summary(campaigns.get(id)), recipients: campaigns.get(id).recipients }), external],
    ["POST", /^\/api\/campaigns$/, (b) => campaigns.create(b), { external: true, maxBytes: 1024 * 1024 }],
    ["POST", /^\/api\/campaigns\/([\w-]+)\/stop$/, (_b, [id]) => campaigns.stop(id), external],
    ["POST", /^\/api\/campaigns\/([\w-]+)\/resume$/, (_b, [id]) => campaigns.resume(id), external],

    ["POST", /^\/api\/connect$/, (b) => rt.connect(b.sentKey, b.openaiKey, "dashboard")],
    ["POST", /^\/api\/settings$/, (b) => rt.saveSettings(b.settings)],
    ["POST", /^\/api\/start\/prepare$/, (b) => rt.prepare(clientId(b))],
    ["POST", /^\/api\/start\/activate$/, (b) => rt.activate(clientId(b))],
    ["POST", /^\/api\/voice-token$/, async (b) => ({ token: await rt.voiceToken(clientId(b)) })],
    ["POST", /^\/api\/heartbeat$/, (b) => rt.heartbeat(clientId(b), b.registered === true)],
    ["POST", /^\/api\/stop$/, () => rt.stop()],

    ["POST", /^\/api\/conversations\/([\w-]+)\/send$/, (b, [id]) => conversations.send(conversation(id), text(b.text), "human", channel(b.channel))],
    ["POST", /^\/api\/conversations\/([\w-]+)\/send-template$/, (b, [id]) => conversations.sendTemplate(conversation(id), b.templateId, b.parameters, "human", channel(b.channel))],
    ["POST", /^\/api\/conversations\/([\w-]+)\/take-over$/, (_b, [id]) => conversations.takeOver(conversation(id))],
    ["POST", /^\/api\/conversations\/([\w-]+)\/hand-back$/, (_b, [id]) => conversations.handBack(conversation(id))],
    ["POST", /^\/api\/conversations\/([\w-]+)\/resolve$/, (_b, [id]) => conversations.resolve(conversation(id))],
    ["POST", /^\/api\/conversations\/([\w-]+)\/reopen$/, (_b, [id]) => conversations.reopen(conversation(id))],
    ["POST", /^\/api\/conversations\/([\w-]+)\/read$/, (_b, [id]) => conversations.read(conversation(id))],
    ["POST", /^\/api\/conversations\/([\w-]+)\/consent$/, (b, [id]) => conversations.setConsent(conversation(id), b.granted === true)],
    ["POST", /^\/api\/conversations\/([\w-]+)\/time-zone$/, (b, [id]) => conversations.setTimeZone(conversation(id), b.timeZone)],
    ["POST", /^\/api\/conversations\/([\w-]+)\/call$/, (b, [id]) => calls.place(conversation(id), by(b.by), by(b.by) === "agent" ? "You asked the agent to call." : undefined)],
    ["POST", /^\/api\/conversations\/([\w-]+)\/proposals\/([\w-]+)\/approve$/, (b, [id, pid]) => conversations.approve(conversation(id), pid, by(b.by))],
    ["POST", /^\/api\/conversations\/([\w-]+)\/proposals\/([\w-]+)\/dismiss$/, (_b, [id, pid]) => conversations.dismiss(conversation(id), pid)],

    ["POST", /^\/api\/calls\/([\w-]+)\/state$/, (b, [id]) => calls.report(id, b.state, b.sentCallId, b.reason)],
    ["POST", /^\/api\/calls\/([\w-]+)\/answer$/, (b, [id]) => calls.answer(id, by(b.by))],
    ["POST", /^\/api\/calls\/([\w-]+)\/decline$/, (_b, [id]) => calls.decline(id)],
    ["POST", /^\/api\/calls\/([\w-]+)\/hang-up$/, (_b, [id]) => calls.hangUp(id)],
    ["POST", /^\/api\/calls\/([\w-]+)\/take-over$/, (_b, [id]) => calls.takeOver(id)],
    ["POST", /^\/api\/calls\/([\w-]+)\/listen$/, (b, [id]) => calls.listen(id, b.on === true)],
  ]

  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" })
      res.end(JSON.stringify(body))
    }
    const host = req.headers.host
    if (!isLocalHost(host, options.port())) return json(403, { error: "Local access only." })
    const path = new URL(req.url ?? "/", "http://localhost").pathname

    if (req.method === "GET" && path === "/api/session") return json(200, { csrfToken: rt.csrf })
    const route = routes.find(([method, pattern]) => method === req.method && pattern.test(path))
    if (!route) return json(404, { error: "Not found." })

    // Other programs on this computer may call campaign routes with the API token instead of the browser checks.
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]
    const tokenOk = !!route[3]?.external && !!options.apiToken && !!bearer && equalSecret(bearer, options.apiToken)
    if (!tokenOk) {
      const origin = req.headers.origin
      if (origin && origin !== `http://${host}`) return json(403, { error: "Same-origin requests only." })
      const token = req.headers["x-csrf-token"]
      if (typeof token !== "string" || !equalSecret(token, rt.csrf)) {
        return json(403, { error: route[3]?.external ? "Send Authorization: Bearer <APP_API_TOKEN>, or use the console." : "Invalid CSRF token. Reload the page." })
      }
    }
    try {
      const raw = await readBody(req, route[3]?.maxBytes ?? 32 * 1024)
      if (!raw) return json(413, { error: "Request too large." })
      const body = raw.length ? (JSON.parse(raw.toString()) as Body) : {}
      const params = route[1].exec(path)!.slice(1)
      const result = await route[2](body, params)
      json(200, result ?? { ok: true })
    } catch (error) {
      json(400, { error: rt.recordErrorQuietly(error) })
    }
  }
}
