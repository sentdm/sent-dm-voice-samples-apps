import { createHmac, timingSafeEqual } from "node:crypto"
import { toE164 } from "@/lib/phone"

export function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Checks a Sent signature. Voice callback questions and messaging webhooks are
 * signed the same way: HMAC-SHA256 over `{id}.{timestamp}.{body}` with the
 * base64 key in the `whsec_` secret, sent as `v1,<base64>`.
 */
export function verifySentSignature(headers: Record<string, unknown>, raw: Buffer, secret: string, now = Date.now()): boolean {
  const id = headers["x-webhook-id"]
  const stamp = headers["x-webhook-timestamp"]
  const signature = headers["x-webhook-signature"]
  if (typeof id !== "string" || typeof stamp !== "string" || typeof signature !== "string" || !/^\d+$/.test(stamp)) return false
  if (Math.abs(Math.floor(now / 1000) - Number(stamp)) > 300) return false
  if (!/^whsec_[A-Za-z0-9+/]+=*$/.test(secret)) return false
  const key = Buffer.from(secret.slice(6), "base64")
  const expected = createHmac("sha256", key).update(`${id}.${stamp}.`).update(raw).digest()
  return signature.split(/\s+/).some((part) => {
    if (!part.startsWith("v1,")) return false
    const actual = Buffer.from(part.slice(3), "base64")
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  })
}

export type CallAddress = { kind: string; identity?: string; number?: string }

export type CallQuestion = {
  type: string
  version: string
  callId: string
  number: string
  timestamp: string
  direction?: string
  test?: boolean
  from?: CallAddress
  to?: CallAddress
}

/** The one number the app asked to call, until `until` (epoch ms). */
export type PendingDial = { to: string; until: number }

export type CallAnswer =
  | { action: { action: "connectToUser"; identity: string } }
  | { action: { action: "connectToNumber"; number: string; callerId: string; dialTimeoutSeconds: number } }
  | { action: { action: "reject"; reason: "declined" | "busy" } }

export const DIAL_TIMEOUT_SECONDS = 30

const reject = (reason: "declined" | "busy"): CallAnswer => ({ action: { action: "reject", reason } })
const dial = (to: string, callerId: string): CallAnswer => ({
  action: { action: "connectToNumber", number: to, callerId, dialTimeoutSeconds: DIAL_TIMEOUT_SECONDS },
})

/**
 * Answers Sent's callback question for the app's number. Sent asks about every
 * call in both directions, and the answer decides what rings:
 *
 * - An inbound call from a phone rings the phone tab (`connectToUser`), unless
 *   the agent is not ready or the line is busy.
 * - An outbound call dials only the number the app asked for, from the phone
 *   tab's identity, before the request expires. `connectToNumber` costs money,
 *   so this is the toll-fraud guard.
 */
export function answerCallQuestion(
  question: CallQuestion,
  context: { number: string; identity: string; ready: boolean; lineBusy: boolean; pending?: PendingDial; now?: number },
): CallAnswer {
  const { number, identity } = context
  if (question.type !== "call.request" || question.version !== "1" || question.number !== number) return reject("declined")
  const to = question.to?.kind === "number" ? toE164(question.to.number) : undefined

  // Sent's callback test places no call. Answering it checks the full public path.
  if (question.test === true) return question.direction === "outbound" && to ? dial(to, number) : { action: { action: "connectToUser", identity } }

  if (question.direction === "inbound") {
    if (to !== number || question.from?.kind !== "number" || !toE164(question.from.number)) return reject("declined")
    if (!context.ready || context.lineBusy) return reject("busy")
    return { action: { action: "connectToUser", identity } }
  }

  const fromPhoneTab = question.direction === "outbound" && question.from?.kind === "user" && question.from.identity === identity
  const { pending } = context
  if (!fromPhoneTab || !pending || to !== pending.to || (context.now ?? Date.now()) > pending.until) return reject("declined")
  return dial(pending.to, number)
}
