import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import type { AddressInfo } from "node:net"
import type { Conversation } from "../lib/types"
import { runTextAgent, type TextAgentTools } from "../server/text-agent"
import { DEFAULT_SETTINGS } from "../server/store"

/** A stand-in for the Responses API that answers each request with the next scripted output. */
async function fakeOpenAI(outputs: object[][]) {
  const requests: Array<{ tools?: Array<{ name: string }>; input: Array<{ type?: string; output?: string }> }> = []
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      requests.push(JSON.parse(body))
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ output: outputs.shift() ?? [] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => server.close() }
}

const conversation: Conversation = {
  id: "c",
  contact: { id: "p", phone: "+14155550142", channels: ["sms"], callConsent: { granted: false }, tags: [] },
  owner: "agent",
  status: "open",
  lastChannel: "sms",
  unread: 1,
  items: [{ kind: "message", id: "m1", at: Date.now(), author: "contact", channel: "sms", text: "Can someone call me about my order?" }],
  toolLog: [],
}
const settings = { ...DEFAULT_SETTINGS, businessName: "Example Store" }

function tools(calls: string[]): TextAgentTools {
  return {
    chooseChannel: async (channel, reason) => (calls.push(`channel:${channel}:${reason}`), { ok: true }),
    proposeCall: async (reason) => (calls.push(`propose:${reason}`), { result: "dialing" }),
    recordConsent: async (evidence) => (calls.push(`consent:${evidence}`), { ok: true }),
    requestHandover: async () => (calls.push("handover"), { ok: true }),
    sendTemplate: async (name) => (calls.push(`template:${name}`), { sent: true }),
  }
}

test("runs tools, returns their result to the model, and sends its final reply", async () => {
  const openai = await fakeOpenAI([
    [
      { type: "function_call", call_id: "a", name: "record_call_consent", arguments: JSON.stringify({ evidence: "Can someone call me" }) },
      { type: "function_call", call_id: "b", name: "propose_call", arguments: JSON.stringify({ reason: "Asked for a call.", signals: ["Asked for a call"] }) },
    ],
    [{ type: "message", content: [{ type: "output_text", text: "Calling you now from this number." }] }],
  ])
  const calls: string[] = []
  const reply = await runTextAgent(conversation, { kind: "message" }, { key: "sk-test", settings, tools: tools(calls), httpBase: openai.base, freeText: { allowed: true } })
  assert.equal(reply, "Calling you now from this number.")
  assert.deepEqual(calls, ["consent:Can someone call me", "propose:Asked for a call."])
  const outputs = openai.requests[1].input.filter((item) => item.type === "function_call_output")
  assert.deepEqual(outputs.map((item) => JSON.parse(item.output!)), [{ ok: true }, { result: "dialing" }])
  // send_template is offered only while free text is blocked.
  assert.equal(openai.requests[0].tools?.some((tool) => tool.name === "send_template"), false)
  openai.close()
})

test("NO_REPLY sends nothing, and a blocked conversation gets send_template", async () => {
  const openai = await fakeOpenAI([[{ type: "message", content: [{ type: "output_text", text: "NO_REPLY" }] }]])
  const reply = await runTextAgent(conversation, { kind: "missed_call" }, {
    key: "sk-test",
    settings,
    tools: tools([]),
    httpBase: openai.base,
    freeText: { blocked: "This contact hasn't replied yet.", templates: [{ id: "t", name: "Missed call follow-up", category: "UTILITY", channels: ["sms"], variables: ["business"] }] },
  })
  assert.equal(reply, null)
  assert.equal(openai.requests[0].tools?.some((tool) => tool.name === "send_template"), true)
  openai.close()
})

test("the agent may pin a channel for a reason; otherwise Sent's routing picks", async () => {
  const openai = await fakeOpenAI([
    [{ type: "function_call", call_id: "c", name: "choose_channel", arguments: JSON.stringify({ channel: "whatsapp", reason: "Asked to continue on WhatsApp" }) }],
    [{ type: "message", content: [{ type: "output_text", text: "Sure, let's continue here." }] }],
  ])
  const calls: string[] = []
  const reply = await runTextAgent(conversation, { kind: "message" }, { key: "sk-test", settings, tools: tools(calls), httpBase: openai.base, freeText: { allowed: true, channels: { used: ["sms", "whatsapp"], last: "whatsapp", whatsappOpen: true } } })
  assert.equal(reply, "Sure, let's continue here.")
  assert.deepEqual(calls, ["channel:whatsapp:Asked to continue on WhatsApp"])
  const prompt = JSON.stringify(openai.requests[0].input)
  assert.match(prompt, /routing picks the channel/)
  assert.match(prompt, /WhatsApp's 24-hour window is open/)
  openai.close()
})
