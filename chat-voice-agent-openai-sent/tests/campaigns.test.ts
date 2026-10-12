import { test, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Runtime } from "../server/runtime"
import { Conversations } from "../server/conversations"
import { Calls } from "../server/calls"
import { Campaigns } from "../server/campaigns"
import { createSentApi } from "../server/sent"
import { createApi } from "../server/api"

const cleanup: Array<() => unknown> = []
after(async () => {
  for (const close of cleanup) await close()
})

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => server.close())
  return (server.address() as AddressInfo).port
}

/** A running agent with a fake Sent API that accepts every send. */
async function setup() {
  const bodies: Array<Record<string, unknown>> = []
  const sentPort = await listen((req, res) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      const body = JSON.parse(raw)
      bodies.push(body)
      res.writeHead(202, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ success: true, data: { status: "QUEUED", recipients: [{ message_id: `m${bodies.length}`, to: body.to[0], body: "Hi, rendered." }] } }))
    })
  })
  const runtime = new Runtime({ dataDir: await mkdtemp(path.join(tmpdir(), "sent-campaign-test-")) })
  await runtime.init()
  cleanup.push(() => runtime.close())
  runtime.sent = createSentApi("test-key-0000000000", `http://127.0.0.1:${sentPort}`)
  runtime.openaiKey = "sk-test"
  runtime.phase = "ready"
  runtime.phone = { id: "tab-test-1", heartbeat: Date.now(), registered: true }
  runtime.templates = [{ id: "tpl_1", name: "Renewal reminder", category: "UTILITY", channels: ["sms", "whatsapp"], variables: ["name"] }]
  const conversations = new Conversations(runtime)
  const calls = new Calls(runtime, conversations)
  conversations.calls = calls
  const campaigns = new Campaigns(runtime, conversations, runtime.files)
  return { runtime, conversations, calls, campaigns, bodies }
}

async function finished(campaigns: Campaigns, id: string) {
  for (let i = 0; i < 100 && campaigns.get(id).status === "sending"; i++) await new Promise((resolve) => setTimeout(resolve, 20))
  return campaigns.summary(campaigns.get(id))
}

test("a campaign skips bad rows with a reason and sends the template to the rest", async () => {
  const { runtime, campaigns, bodies } = await setup()
  const summary = campaigns.create({
    name: "Renewals",
    template: "Renewal reminder",
    scenario: "Offer a quick call about the renewal. If they agree, call them.",
    recipients: [
      { phone: "+38344876143", name: "Betim", variables: { name: "Betim" } },
      { phone: "0038349168028", variables: { name: "Dante" } },
      { phone: "044 876 143", variables: { name: "No country code" } },
      { phone: "+38344876143", variables: { name: "Twice" } },
      { phone: "+14155550142", variables: {} },
    ],
  })
  assert.equal(summary.total, 5)
  const done = await finished(campaigns, summary.id)
  assert.equal(done.status, "done")
  assert.deepEqual([done.sent, done.skipped, done.failed], [2, 3, 0])
  const reasons = campaigns.get(summary.id).recipients.filter((r) => r.status === "skipped").map((r) => r.error)
  assert.deepEqual(reasons, ["Not in international format, for example +14155551234.", "Listed twice.", "No value for the template variable name."])
  // Each sent contact gets a conversation tagged with the campaign; the sender is never pinned.
  const betim = runtime.store.conversations.find((c) => c.contact.phone === "+38344876143")!
  assert.equal(betim.campaignId, summary.id)
  assert.equal(betim.contact.name, "Betim")
  assert.ok(betim.contact.tags.includes("Renewals"))
  assert.equal(runtime.store.conversations.some((c) => c.contact.phone === "+38349168028"), true)
  assert.deepEqual(bodies.map((b) => [b.channels, b.channel, (b.template as { id: string }).id]), [[undefined, undefined, "tpl_1"], [undefined, undefined, "tpl_1"]])
})

test("Only these numbers keeps a test campaign to your own phones", async () => {
  const { runtime, campaigns, bodies } = await setup()
  await runtime.store.saveSettings({ ...runtime.settings, onlyNumbers: ["+38344876143"] })
  const summary = campaigns.create({ template: "tpl_1", scenario: "Say hi.", recipients: [{ phone: "+38344876143", variables: { name: "Me" } }, { phone: "+38349168028", variables: { name: "Real customer" } }] })
  const done = await finished(campaigns, summary.id)
  assert.deepEqual([done.sent, done.skipped], [1, 1])
  assert.equal(bodies.length, 1)
})

test("other programs reach campaign routes only, and only with the API token", async () => {
  const { runtime, conversations, calls, campaigns } = await setup()
  let port = 0
  const token = "t".repeat(32)
  port = await listen(createApi(runtime, conversations, calls, campaigns, { port: () => port, apiToken: token }))
  const call = (method: string, route: string, auth?: string) =>
    fetch(`http://localhost:${port}${route}`, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined }).then((r) => r.status)
  assert.equal(await call("GET", "/api/campaigns", token), 200)
  assert.equal(await call("GET", "/api/campaigns"), 403)
  assert.equal(await call("GET", "/api/campaigns", "wrong-token-wrong-token-wrong"), 403)
  assert.equal(await call("POST", "/api/stop", token), 403)
})
