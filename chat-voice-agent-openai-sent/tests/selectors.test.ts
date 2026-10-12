import { test } from "node:test"
import assert from "node:assert/strict"
import type { Conversation } from "../lib/types"
import { inbox, matchesSearch } from "../lib/selectors"

const conversation = (id: string, phone: string, extra: Partial<Conversation> = {}): Conversation => ({
  id,
  contact: { id: `p-${id}`, phone, channels: ["sms"], callConsent: { granted: false }, tags: [] },
  owner: "agent",
  status: "open",
  lastChannel: "sms",
  unread: 0,
  items: [],
  toolLog: [],
  ...extra,
})

test("search finds a number however it is typed", () => {
  const c = conversation("a", "+38344876143")
  for (const query of ["+38344876143", "+383 44 876 143", "(383) 44-876", "876143", "4487"]) assert.equal(matchesSearch(c, query), true, query)
  assert.equal(matchesSearch(c, "+1 415"), false)
  // A single digit is too short to mean a number.
  assert.equal(matchesSearch(c, "9"), false)
})

test("search finds names and message text, and looks past the tab", () => {
  const resolved = conversation("b", "+14155550142", {
    status: "resolved",
    contact: { id: "p-b", name: "Daniel Okafor", phone: "+14155550142", channels: ["sms"], callConsent: { granted: false }, tags: [] },
    items: [{ kind: "message", id: "m", at: 1, author: "contact", channel: "sms", text: "Any update on order A-20417?" }],
  })
  const open = conversation("c", "+38349168028")
  assert.equal(matchesSearch(resolved, "okafor"), true)
  assert.equal(matchesSearch(resolved, "a-20417"), true)
  assert.deepEqual(inbox([open, resolved], "open").map((c) => c.id), ["c"])
  assert.deepEqual(inbox([open, resolved], "open", "20417").map((c) => c.id), ["b"])
  assert.deepEqual(inbox([open, resolved], "open", "  ").map((c) => c.id), ["c"])
})
