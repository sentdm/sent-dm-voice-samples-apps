import type { AgentSettings, CallItem, Conversation } from "./types"
import { contactPlace, contactZone, localTime } from "./format"

export type CallCheck = {
  id: "consent" | "hours" | "policy" | "line"
  ok: boolean
  label: string
  detail: string
}

/** Minutes since midnight in the contact's time zone. */
function minutesInZone(timeZone: string, at: number) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return get("hour") * 60 + get("minute")
}

function toMinutes(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}

export function activeCall(conversation: Conversation): CallItem | undefined {
  for (let i = conversation.items.length - 1; i >= 0; i--) {
    const item = conversation.items[i]
    if (item.kind === "call" && (item.state === "ringing" || item.state === "live")) return item
  }
  return undefined
}

export type Caller = "agent" | "human"

/**
 * Every check must pass before anyone dials. A call goes out only after the
 * contact asks for one or agrees to one, whether the agent or a person calls.
 * The policy check applies to the agent only; it then decides whether the
 * agent dials on its own ("auto") or asks a person first ("ask").
 */
export function callChecks(conversation: Conversation, settings: AgentSettings, now: number, caller: Caller = "agent", lineBusy = false): CallCheck[] {
  const { contact } = conversation
  const minutes = minutesInZone(contactZone(contact), now)
  const inHours = minutes >= toMinutes(settings.callingHours.start) && minutes < toMinutes(settings.callingHours.end)
  const busy = activeCall(conversation)
  // The browser tab is one phone line: a call with anyone else also blocks this one.
  const busyElsewhere = !busy && lineBusy

  const checks: CallCheck[] = [
    {
      id: "consent",
      ok: contact.callConsent.granted,
      label: contact.callConsent.granted ? "Agreed to a call" : "Hasn't asked for a call",
      detail: contact.callConsent.source ?? "Calls go out only after the contact asks for one or agrees to one.",
    },
    {
      id: "hours",
      ok: inHours,
      label: inHours ? "Within calling hours" : "Outside calling hours",
      detail: `It is ${localTime(contactZone(contact), now)} in ${contactPlace(contact)}. Calls allowed ${settings.callingHours.start}–${settings.callingHours.end}.`,
    },
    {
      id: "policy",
      ok: settings.callPolicy !== "never",
      label: POLICY_LABEL[settings.callPolicy],
      detail: POLICY_DETAIL[settings.callPolicy],
    },
    {
      id: "line",
      ok: !busy && !busyElsewhere,
      label: busy ? "Call in progress" : busyElsewhere ? "Line busy" : "Line free",
      detail: busy ? "End the current call first." : busyElsewhere ? "Another call is in progress. The app handles one call at a time." : "No other call in progress.",
    },
  ]
  return caller === "agent" ? checks : checks.filter((check) => check.id !== "policy")
}

export function canCall(conversation: Conversation, settings: AgentSettings, now: number, caller: Caller, lineBusy = false) {
  return callChecks(conversation, settings, now, caller, lineBusy).every((check) => check.ok)
}

export type CallDecision =
  | { kind: "dial" }
  | { kind: "ask" }
  | { kind: "decline"; failed: CallCheck[] }

/** What the agent does after it decides a call would help. */
export function decideCall(conversation: Conversation, settings: AgentSettings, now: number, lineBusy = false): CallDecision {
  const failed = callChecks(conversation, settings, now, "agent", lineBusy).filter((check) => !check.ok)
  if (failed.length > 0) return { kind: "decline", failed }
  return settings.callPolicy === "auto" ? { kind: "dial" } : { kind: "ask" }
}

/** The agent's reply when it may not call. The first failed check wins. */
export function declineMessage(failed: CallCheck[], settings: AgentSettings) {
  switch (failed[0]?.id) {
    case "policy":
      return "I can't place calls from here, but I'm happy to help in chat, or I can bring in a colleague."
    case "hours":
      return `Happy to talk! It's outside our calling hours right now, so I can call you from ${settings.callingHours.start} your time. Does that work?`
    case "consent":
      return "I can call you if you'd like. Just reply YES to confirm that an automated assistant may call this number."
    default:
      return "We're already on a call. I'll follow up here as soon as it ends."
  }
}

export const POLICY_LABEL: Record<AgentSettings["callPolicy"], string> = {
  never: "Calls turned off",
  ask: "Asks you first",
  auto: "Calls on its own",
}

export const POLICY_DETAIL: Record<AgentSettings["callPolicy"], string> = {
  never: "The agent stays in text and offers a person instead.",
  ask: "The agent suggests a call. You approve it or place it yourself.",
  auto: "The agent calls when every check passes, and logs why.",
}
