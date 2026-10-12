import type { Channel, Conversation } from "./types"

/** Sent sends free-form text once the contact has replied, or within 7 days of a template. */
export const TEMPLATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** WhatsApp allows free-form text only within 24 hours of the contact's last WhatsApp message. */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000

export function whatsappWindowOpen(conversation: Conversation, now: number) {
  const last = conversation.items.findLast((i) => i.kind === "message" && i.author === "contact" && i.channel === "whatsapp")
  return !!last && now - last.at < WHATSAPP_WINDOW_MS
}

/**
 * Why Sent would not deliver free-form text to this contact now, or null when
 * it would. Without a channel, Sent's routing picks one, and its rule is the
 * SMS rule: it routes free text to WhatsApp only inside WhatsApp's 24-hour
 * window and falls back to RCS or SMS otherwise. A message pinned to WhatsApp
 * also needs that window. Sent accepts a blocked send and reports BLOCKED or
 * FAILED later, so the app checks first and offers a template instead.
 */
export function freeTextBlocked(conversation: Conversation, now: number, channel?: Channel): string | null {
  if (channel === "whatsapp" && !whatsappWindowOpen(conversation, now)) {
    return "WhatsApp allows free text only within 24 hours of the contact's last WhatsApp message."
  }
  const replied = conversation.items.some((i) => i.kind === "message" && i.author === "contact")
  if (replied) return null
  const lastTemplate = conversation.items.findLast((i) => i.kind === "message" && i.author !== "contact" && i.template && i.status !== "failed")
  if (lastTemplate && now - lastTemplate.at < TEMPLATE_WINDOW_MS) return null
  return "This contact hasn't replied yet. Sent sends free text only after a reply, or within 7 days of a template."
}
