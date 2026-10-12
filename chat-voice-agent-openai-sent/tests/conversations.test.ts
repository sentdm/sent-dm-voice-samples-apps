import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Runtime } from "../server/runtime"
import { Conversations } from "../server/conversations"
import { Calls } from "../server/calls"

async function setup() {
  const runtime = new Runtime({ dataDir: await mkdtemp(path.join(tmpdir(), "sent-chat-test-")) })
  await runtime.init()
  const conversations = new Conversations(runtime)
  conversations.calls = new Calls(runtime, conversations)
  return { runtime, conversations, close: () => runtime.close() }
}

const received = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  field: "message",
  event: "message.received",
  payload: { message_id: id, inbound_number: "+14155550142", outbound_number: "+16285550199", channel: "whatsapp", text, received_at: new Date().toISOString(), ...extra },
})

test("an inbound text creates one conversation per contact, once", async () => {
  const { runtime, conversations, close } = await setup()
  conversations.handleWebhook("evt_1", received("msg_1", "Hi, is my order on its way?"))
  conversations.handleWebhook("evt_1", received("msg_1", "Hi, is my order on its way?"))
  conversations.handleWebhook("evt_2", received("msg_1", "Hi, is my order on its way?"))
  conversations.handleWebhook("evt_3", received("msg_2", "Also, can you call me?", { channel: "sms" }))
  assert.equal(runtime.store.conversations.length, 1)
  const [c] = runtime.store.conversations
  assert.equal(c.items.length, 2)
  assert.deepEqual(c.contact.channels, ["whatsapp", "sms"])
  assert.equal(c.lastChannel, "sms")
  assert.equal(c.unread, 2)
  await close()
})

test("STOP opts the contact out", async () => {
  const { runtime, conversations, close } = await setup()
  conversations.handleWebhook("evt_1", received("msg_1", "STOP"))
  const [c] = runtime.store.conversations
  assert.equal(c.contact.optedOut, true)
  assert.equal(c.items.at(-1)?.kind, "event")
  conversations.handleWebhook("evt_2", received("msg_2", "start"))
  assert.equal(c.contact.optedOut, false)
  await close()
})

test("delivery statuses only move forward, and failures keep Sent's reason", async () => {
  const { runtime, conversations, close } = await setup()
  const c = runtime.store.forPhone("+14155550142", "sms")
  c.items.push({ kind: "message", id: "m1", at: Date.now(), author: "agent", channel: "sms", text: "On its way!", status: "sending", sentId: "sent_1" })
  const status = (s: string, extra: Record<string, unknown> = {}) => conversations.handleWebhook(undefined, { field: "message", event: `message.${s.toLowerCase()}`, payload: { message_id: "sent_1", message_status: s, ...extra } })
  status("DELIVERED")
  status("SENT")
  const message = c.items[0]
  assert.equal(message.kind === "message" && message.status, "delivered")
  status("BLOCKED", { reason: "A template is required for this contact.", reason_code: "CONVERSATION_TEMPLATE_REQUIRED" })
  assert.equal(message.kind === "message" && message.status, "failed")
  assert.equal(message.kind === "message" && message.error, "A template is required for this contact.")
  await close()
})

test("Sent's call.failed reason replaces a vague end, for example a country Sent doesn't call", async () => {
  const { runtime, conversations, close } = await setup()
  const c = runtime.store.forPhone("+38344000043", "sms")
  c.items.push({ kind: "call", id: "call_local", at: Date.now(), direction: "outbound", state: "ringing", handledBy: "agent", transcript: [] })
  conversations.handleWebhook("evt_call", { field: "call", event: "call.failed", payload: { call_id: "call_from_sent", reason: "destination_blocked" } })
  const call = c.items[0]
  assert.equal(call.kind === "call" && call.state, "ended")
  assert.match(call.kind === "call" ? (call.summary ?? "") : "", /doesn't allow calls to this country/)
  assert.notEqual(call.kind === "call" && call.outcome, undefined)
  await close()
})

test("conversations saved before the rename keep their last channel", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises")
  const dir = await mkdtemp(path.join(tmpdir(), "sent-chat-legacy-"))
  const saved = [{ id: "c1", contact: { id: "p", phone: "+14155550142", channels: ["whatsapp"], callConsent: { granted: false }, tags: [] }, owner: "agent", status: "open", replyChannel: "whatsapp", unread: 0, items: [], toolLog: [] }]
  await writeFile(path.join(dir, "conversations.json"), JSON.stringify(saved))
  const runtime = new Runtime({ dataDir: dir })
  await runtime.init()
  assert.equal(runtime.store.conversations[0].lastChannel, "whatsapp")
  assert.equal("replyChannel" in runtime.store.conversations[0], false)
  await runtime.close()
})
