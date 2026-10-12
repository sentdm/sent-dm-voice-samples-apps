import { test } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { answerCallQuestion, verifySentSignature, type CallQuestion } from "../server/security"

const secret = `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`
const sign = (body: string, stamp = Math.floor(Date.now() / 1000), id = "wh_1") => ({
  "x-webhook-id": id,
  "x-webhook-timestamp": String(stamp),
  "x-webhook-signature": `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${stamp}.${body}`).digest("base64")}`,
})

test("accepts a valid Sent signature and rejects tampering or old timestamps", () => {
  const body = '{"field":"message"}'
  assert.equal(verifySentSignature(sign(body), Buffer.from(body), secret), true)
  assert.equal(verifySentSignature(sign(body), Buffer.from('{"field":"other"}'), secret), false)
  assert.equal(verifySentSignature(sign(body, Math.floor(Date.now() / 1000) - 600), Buffer.from(body), secret), false)
  assert.equal(verifySentSignature({}, Buffer.from(body), secret), false)
})

const number = "+16285550199"
const identity = "sent-chat-abc"
const base: CallQuestion = { type: "call.request", version: "1", callId: "c1", number, timestamp: "" }
const inbound: CallQuestion = { ...base, direction: "inbound", from: { kind: "number", number: "+14155550142" }, to: { kind: "number", number } }
const outbound: CallQuestion = { ...base, direction: "outbound", from: { kind: "user", identity }, to: { kind: "number", number: "+14155550142" } }

test("rings the phone tab for inbound calls, or answers busy", () => {
  assert.deepEqual(answerCallQuestion(inbound, { number, identity, ready: true, lineBusy: false }), { action: { action: "connectToUser", identity } })
  assert.deepEqual(answerCallQuestion(inbound, { number, identity, ready: true, lineBusy: true }), { action: { action: "reject", reason: "busy" } })
  assert.deepEqual(answerCallQuestion(inbound, { number, identity, ready: false, lineBusy: false }), { action: { action: "reject", reason: "busy" } })
})

test("dials only the pending number, from the phone tab, before it expires", () => {
  const pending = { to: "+14155550142", until: Date.now() + 10_000 }
  const answer = answerCallQuestion(outbound, { number, identity, ready: true, lineBusy: false, pending })
  assert.equal(answer.action.action, "connectToNumber")
  const declined = { action: { action: "reject", reason: "declined" } }
  assert.deepEqual(answerCallQuestion(outbound, { number, identity, ready: true, lineBusy: false }), declined)
  assert.deepEqual(answerCallQuestion({ ...outbound, to: { kind: "number", number: "+19005550100" } }, { number, identity, ready: true, lineBusy: false, pending }), declined)
  assert.deepEqual(answerCallQuestion({ ...outbound, from: { kind: "user", identity: "someone-else" } }, { number, identity, ready: true, lineBusy: false, pending }), declined)
  assert.deepEqual(answerCallQuestion(outbound, { number, identity, ready: true, lineBusy: false, pending: { ...pending, until: Date.now() - 1 } }), declined)
  assert.deepEqual(answerCallQuestion({ ...outbound, number: "+10000000000" }, { number, identity, ready: true, lineBusy: false, pending }), declined)
})
