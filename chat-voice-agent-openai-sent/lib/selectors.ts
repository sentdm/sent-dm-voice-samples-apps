import type { Conversation, InboxFilter, ThreadItem } from "./types"
import { activeCall } from "./policy"
import { CHANNEL_LABEL } from "./format"

function itemTime(item: ThreadItem) {
  if (item.kind === "call") return item.transcript.at(-1)?.at ?? item.endedAt ?? item.answeredAt ?? item.at
  return item.at
}

export function lastActivity(c: Conversation) {
  return c.items.reduce((latest, item) => Math.max(latest, itemTime(item)), 0)
}

/** True when a person should look at this conversation now. */
export function needsYou(c: Conversation) {
  if (c.status === "resolved") return false
  if (c.status === "needs_human") return true
  if (c.items.some((i) => i.kind === "proposal" && i.status === "pending")) return true
  const call = activeCall(c)
  if (call?.direction === "inbound" && call.state === "ringing") return true
  const last = c.items.filter((i) => i.kind === "message").at(-1)
  return c.owner === "human" && last?.kind === "message" && last.author === "contact"
}

/**
 * Whether a conversation matches a search: the phone number by its digits
 * (so "+383 44 876" and "876143" both find +38344876143), the contact's
 * name or tags (campaign names are tags), or the text of any message.
 */
export function matchesSearch(c: Conversation, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const digits = q.replace(/\D/g, "")
  if (digits.length >= 2 && c.contact.phone.replace(/\D/g, "").includes(digits)) return true
  if (c.contact.name?.toLowerCase().includes(q)) return true
  if (c.contact.tags.some((tag) => tag.toLowerCase().includes(q))) return true
  return c.items.some((i) => i.kind === "message" && i.text.toLowerCase().includes(q))
}

/**
 * Live and ringing calls first, then what needs a person, then most recent.
 * A search looks through every conversation, whatever the tab.
 */
export function inbox(conversations: Conversation[], filter: InboxFilter, query = "") {
  const visible = conversations.filter((c) => {
    if (query.trim()) return matchesSearch(c, query)
    if (filter === "resolved") return c.status === "resolved"
    if (filter === "needs_you") return needsYou(c)
    return c.status !== "resolved"
  })
  const rank = (c: Conversation) => (activeCall(c) ? 2 : needsYou(c) ? 1 : 0)
  return visible.sort((a, b) => rank(b) - rank(a) || lastActivity(b) - lastActivity(a))
}

export function preview(c: Conversation): { text: string; icon: "call" | "message" | "event" } {
  for (let i = c.items.length - 1; i >= 0; i--) {
    const item = c.items[i]
    switch (item.kind) {
      case "call": {
        const line = item.transcript.at(-1)
        if (item.state === "live") return { text: line?.text ?? "On a call", icon: "call" }
        if (item.state === "ringing") return { text: item.direction === "inbound" ? "Incoming call" : "Calling…", icon: "call" }
        if (item.state === "missed") return { text: "Missed call", icon: "call" }
        return { text: item.summary ?? "Call ended", icon: "call" }
      }
      case "message": {
        // Imported history wasn't written here, so it gets no author prefix.
        const who = item.fromHistory ? "" : item.author === "agent" ? "Agent: " : item.author === "human" ? "You: " : ""
        return { text: `${who}${item.text}`, icon: "message" }
      }
      case "proposal":
        if (item.status === "pending") {
          return { text: item.action === "call" ? `Agent wants to call: ${item.reason}` : `Agent needs you: ${item.reason}`, icon: "event" }
        }
        break
      case "event":
        break
    }
  }
  return { text: "No messages yet", icon: "event" }
}

export function channelOf(item: ThreadItem): string | null {
  // Until Sent reports the channel its routing picked, the message stays in the current lane.
  if (item.kind === "message") return item.routing ? null : CHANNEL_LABEL[item.channel]
  if (item.kind === "call") return "Voice"
  return null
}
