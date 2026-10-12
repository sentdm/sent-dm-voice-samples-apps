import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { after } from "node:test"
import { createSentApi } from "../server/sent"

const test_cleanup: Array<() => void> = []
after(() => test_cleanup.forEach((close) => close()))

/**
 * Regression: texts to a Kosovo number failed with DELIVERY_003 ("no sender set up for this
 * destination") because the app pinned channels.sms.from to the account's US 10DLC number,
 * which is also its voice number. The app sends only the recipient and the content, and
 * Sent's routing picks the channel and the sender for each contact.
 */
async function fakeSent() {
  const bodies: Array<Record<string, unknown>> = []
  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      bodies.push(JSON.parse(raw))
      res.writeHead(202, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ success: true, data: { status: "QUEUED", recipients: [{ message_id: "m1", to: "+38344000043", channel: "sms", body: "Hey, you have a meeting in a bit." }] } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies, close: () => server.close() }
}

test("texts and templates leave the channel and the sender to Sent's routing", async () => {
  const sent = await fakeSent()
  test_cleanup.push(sent.close)
  const api = createSentApi("test-key-0000000000", sent.baseURL)
  const to = "+38344000043"
  await api.sendText({ to, text: "Hi there", idempotencyKey: "a" })
  await api.sendTemplate({ to, templateId: "tpl", parameters: { meetingDetails: "10:00" }, idempotencyKey: "b" })
  for (const body of sent.bodies) {
    assert.equal(body.channels, undefined, "a pinned sender can't serve every destination")
    assert.equal(body.channel, undefined, "Sent's routing picks the channel")
    assert.deepEqual(body.to, [to])
  }
})

test("a channel the agent chose is sent as `channel`; a sender (`channels`) never is", async () => {
  const sent = await fakeSent()
  test_cleanup.push(sent.close)
  const api = createSentApi("test-key-0000000000", sent.baseURL)
  await api.sendText({ to: "+38344000043", text: "Continuing on WhatsApp", channel: "whatsapp", idempotencyKey: "c" })
  await api.sendTemplate({ to: "+38344000043", templateId: "tpl", parameters: {}, channel: "sms", idempotencyKey: "d" })
  assert.deepEqual(sent.bodies.map((body) => body.channel), [["whatsapp"], ["sms"]])
  assert.deepEqual(sent.bodies.map((body) => body.channels), [undefined, undefined])
})
