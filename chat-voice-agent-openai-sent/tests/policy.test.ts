import { test } from "node:test"
import assert from "node:assert/strict"
import type { Conversation, MessageItem } from "../lib/types"
import { callChecks, decideCall } from "../lib/policy"
import { freeTextBlocked } from "../lib/channels"
import { DEFAULT_SETTINGS } from "../server/store"

const HOUR = 3_600_000
// Noon in New York.
const noon = Date.parse("2026-10-12T16:00:00Z")

function conversation(overrides: Partial<Conversation> = {}, consent = true): Conversation {
  return {
    id: "c",
    contact: { id: "p", phone: "+14155550142", channels: ["sms"], timeZone: "America/New_York", callConsent: { granted: consent }, tags: [] },
    owner: "agent",
    status: "open",
    lastChannel: "sms",
    unread: 0,
    items: [],
    toolLog: [],
    ...overrides,
  }
}
const message = (at: number, author: MessageItem["author"], channel: MessageItem["channel"], extra: Partial<MessageItem> = {}): MessageItem => ({ kind: "message", id: `m${at}`, at, author, channel, text: "hi", ...extra })

test("the agent dials, asks, or declines from the checks and the policy", () => {
  const c = conversation()
  assert.equal(decideCall(c, { ...DEFAULT_SETTINGS, callPolicy: "auto" }, noon).kind, "dial")
  assert.equal(decideCall(c, { ...DEFAULT_SETTINGS, callPolicy: "ask" }, noon).kind, "ask")
  assert.equal(decideCall(c, { ...DEFAULT_SETTINGS, callPolicy: "never" }, noon).kind, "decline")
  assert.equal(decideCall(conversation({}, false), DEFAULT_SETTINGS, noon).kind, "decline")
  assert.equal(decideCall(c, DEFAULT_SETTINGS, noon, true).kind, "decline")
  // 11 PM in New York is outside 09:00–20:00.
  const late = decideCall(c, DEFAULT_SETTINGS, noon + 11 * HOUR)
  assert.equal(late.kind === "decline" && late.failed[0].id, "hours")
})

test("a person's calls skip the agent-only policy check", () => {
  const ids = callChecks(conversation(), { ...DEFAULT_SETTINGS, callPolicy: "never" }, noon, "human").map((check) => check.id)
  assert.deepEqual(ids, ["consent", "hours", "line"])
})

test("free text follows Sent's auto-routing rule", () => {
  const now = noon
  // The contact replied once, on any channel: Sent routes free text (to WhatsApp only inside its window).
  const replied = conversation({ items: [message(now - 30 * HOUR, "contact", "whatsapp")] })
  assert.equal(freeTextBlocked(replied, now), null)
  // Never replied: blocked, unless a template went out in the last 7 days.
  const silent = conversation({ items: [message(now - HOUR, "human", "sms", { fromHistory: true })] })
  assert.match(freeTextBlocked(silent, now) ?? "", /hasn't replied yet/)
  const templated = conversation({ items: [message(now - 2 * 24 * HOUR, "human", "sms", { template: "Reminder", status: "delivered" })] })
  assert.equal(freeTextBlocked(templated, now), null)
  const oldTemplate = conversation({ items: [message(now - 8 * 24 * HOUR, "human", "sms", { template: "Reminder", status: "delivered" })] })
  assert.notEqual(freeTextBlocked(oldTemplate, now), null)
  // Pinning WhatsApp needs its 24-hour window; Sent's routing would fall back on its own.
  assert.match(freeTextBlocked(replied, now, "whatsapp") ?? "", /24 hours/)
  const recentWhatsApp = conversation({ items: [message(now - 2 * HOUR, "contact", "whatsapp")] })
  assert.equal(freeTextBlocked(recentWhatsApp, now, "whatsapp"), null)
})
