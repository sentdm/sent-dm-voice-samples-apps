import type { Channel, Contact } from "./types"

export const CHANNEL_LABEL: Record<Channel, string> = {
  sms: "SMS",
  whatsapp: "WhatsApp",
  rcs: "RCS",
}

/** +14155550142 → +1 415 555 0142. Other countries keep their E.164 form. */
export function formatPhone(e164: string) {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return us ? `+1 ${us[1]} ${us[2]} ${us[3]}` : e164
}

export function displayName(contact: Contact) {
  return contact.name ?? formatPhone(contact.phone)
}

export function firstName(contact: Contact) {
  return contact.name?.split(" ")[0] ?? formatPhone(contact.phone)
}

export function initials(contact: Contact) {
  if (!contact.name) return "#"
  return contact.name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" })

export function formatClock(at: number) {
  return clock.format(at)
}

/** Inbox timestamps: "now", "4m", "2h", then the weekday. */
export function formatAgo(at: number, now: number) {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return weekday.format(at)
}

export function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

export function dayLabel(at: number, now: number) {
  const day = new Date(at).toDateString()
  if (day === new Date(now).toDateString()) return "Today"
  if (day === new Date(now - 86_400_000).toDateString()) return "Yesterday"
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(at)
}

/** The zone of whoever runs the app. Contacts without a set zone use it. */
export function ownZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

export function contactZone(contact: Contact) {
  return contact.timeZone ?? ownZone()
}

/** "Chicago", or "your time zone" while the contact's zone is unknown. */
export function contactPlace(contact: Contact) {
  if (contact.city) return contact.city
  if (!contact.timeZone) return "your time zone"
  return contact.timeZone.split("/").pop()!.replace(/_/g, " ")
}

export function localTime(timeZone: string, at: number) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone }).format(at)
}
