import { WebSocket } from "ws"
import type { CallItem, CallOutcome, Conversation, Speaker } from "@/lib/types"
import { displayName, formatPhone } from "@/lib/format"
import { callChecks } from "@/lib/policy"
import { toE164 } from "@/lib/phone"
import { newId } from "./store"
import { DIAL_TIMEOUT_SECONDS, type CallAnswer, type CallQuestion, type PendingDial } from "./security"
import { VoiceAgent, voicePrompt, type OutcomeRecord, type VoiceEvent } from "./voice-agent"
import type { Runtime } from "./runtime"
import type { Conversations } from "./conversations"

/** From the dial request to the answer: model session, Sent's call setup, and the ring time. */
const DIAL_SETUP_MS = (45 + DIAL_TIMEOUT_SECONDS) * 1000
/** From the model being ready to Sent's callback question; the SDK places the call within seconds. */
const PENDING_DIAL_MS = 20_000
/** An inbound call that rings this long without an answer is missed. */
const RING_LIMIT_MS = 45_000
const MAX_CALL_MS = 10 * 60_000

/** +38344876143 → +3834•••43, for logs. */
const maskPhone = (phone: unknown) => (typeof phone === "string" && phone.length > 7 ? `${phone.slice(0, 5)}•••${phone.slice(-2)}` : "an unknown number")

const OUTCOME: Record<OutcomeRecord["outcome"], CallOutcome> = {
  resolved: "resolved",
  callback_requested: "callback_requested",
  not_interested: "not_interested",
  voicemail: "voicemail",
  needs_person: "handed_over",
}

type Session = { callId: string; socket: WebSocket; voice?: VoiceAgent; handover: boolean }

/** Sent's call.failed reasons, as sentences (docs: Call Failure Reasons). */
const FAILURE: Record<string, string> = {
  destination_blocked: "Sent doesn't allow calls to this country on your account. Ask support@sent.dm to allow it.",
  insufficient_balance: "Your Sent balance is too low to place calls.",
  invalid_answer: "Sent couldn't use the app's answer, for example a dial to a blocked country.",
  callback_timeout: "Sent couldn't reach the app in time to ask about the call.",
  callback_not_configured: "The number has no callback URL.",
  rejected: "The call was declined, or the line was busy.",
  no_answer: "No answer.",
}

/** The browser voice SDK's reason for a call that ended before anyone answered, as a sentence. */
function endReason(reason: unknown): string | undefined {
  if (typeof reason !== "string" || !reason) return undefined
  const text = reason.slice(0, 300)
  if (text === "noAnswer") return "No answer."
  if (text === "busy") return "The line was busy, or the call was declined."
  if (text === "completed") return "The call ended before anyone answered."
  return `The call failed (${text}).`
}

export class Calls {
  private pending?: PendingDial & { callId: string }
  /** Callbacks the agent promised while the line was busy, in order. The tab is one phone line. */
  private callbacks: Array<{ conversationId: string; reason: string }> = []
  private session?: Session
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private rt: Runtime,
    private conversations: Conversations,
  ) {
    rt.onStop = () => this.endAll("The agent stopped.")
  }

  private get store() {
    return this.rt.store
  }

  pendingDial(): PendingDial | undefined {
    return this.pending
  }

  private find(callId: string) {
    const found = this.store.findCall(callId)
    if (!found) throw new Error("That call no longer exists.")
    return found
  }

  private timer(callId: string, ms: number, run: () => void) {
    clearTimeout(this.timers.get(callId))
    this.timers.set(callId, setTimeout(run, ms))
  }

  // -------------------------------------------------------------------------
  // Sent's callback questions

  /** Records an inbound call once the gateway has answered Sent's question about it. */
  inboundQuestion(question: CallQuestion, answer: CallAnswer) {
    const from = toE164(question.from?.number)
    console.log(`[call] Sent asked about an inbound call from ${maskPhone(from)}; the app answered ${answer.action.action}${answer.action.action === "reject" ? ` (${answer.action.reason})` : ""}.`)
    if (!from) return
    const c = this.store.forPhone(from)
    const now = Date.now()
    if (c.status === "resolved") c.status = "open"
    c.unread += 1
    if (answer.action.action !== "connectToUser") {
      const served = this.rt.agentServes(from)
      const summary = served ? "The line was busy with another call." : "Declined: this number isn't on your Only these numbers list."
      c.items.push({ kind: "call", id: newId("call"), at: now, direction: "inbound", state: "missed", handledBy: "agent", endedAt: now, transcript: [], sentCallId: question.callId, summary })
      this.store.changed()
      if (served) this.conversations.afterMissedCall(c)
      return
    }
    const { inbound, teamRingSeconds } = this.rt.settings
    const call: CallItem = {
      kind: "call",
      id: newId("call"),
      at: now,
      direction: "inbound",
      state: "ringing",
      handledBy: "agent",
      transcript: [],
      sentCallId: question.callId,
      agentAnswersAt: inbound === "team_only" ? undefined : now + (inbound === "agent" ? 1_000 : teamRingSeconds * 1000),
    }
    c.items.push(call)
    this.store.changed()
    this.timer(call.id, RING_LIMIT_MS, () => this.finish(call.id, "missed", "No one answered."))
  }

  /**
   * Records Sent's question about an outbound call and the gateway's answer.
   * "connectToNumber" means Sent now dials the contact; "reject" ends the attempt.
   */
  outboundQuestion(question: CallQuestion, answer: CallAnswer) {
    const to = question.to?.number
    const found = this.pending ? this.store.findCall(this.pending.callId) : this.store.activeCall()
    console.log(`[call] Sent asked about an outbound call to ${maskPhone(to)}; the app answered ${answer.action.action}${answer.action.action === "reject" ? ` (${answer.action.reason})` : ""}.`)
    if (answer.action.action === "connectToNumber") {
      // One request, one call: a retry of this question gets the cached answer.
      this.pending = undefined
      if (found) found.call.sentCallId = question.callId
      return
    }
    if (found && found.call.direction === "outbound" && found.call.state === "ringing" && found.conversation.contact.phone === toE164(to)) {
      this.finish(found.call.id, "ended", "The app declined Sent's dial request: it didn't match a call started in this tab, or it came too late.")
    }
  }

  /**
   * Sent's call events. call.failed carries the reason a call never connected,
   * which the browser SDK reports only as "failed". The tab is one phone line,
   * so a failure without a known call id belongs to the latest unanswered call.
   */
  callEvent(event: string | null | undefined, payload: Record<string, unknown>) {
    if (event !== "call.failed") return
    const callId = typeof payload.call_id === "string" ? payload.call_id : undefined
    const reason = typeof payload.reason === "string" ? payload.reason : undefined
    console.log(`[call] Sent reports call ${callId ?? "?"} failed: ${reason ?? "no reason recorded"}.`)
    const recent = Date.now() - 2 * 60_000
    let byId: { conversation: Conversation; call: CallItem } | undefined
    let latest: { conversation: Conversation; call: CallItem } | undefined
    for (const conversation of this.store.conversations) {
      for (const call of conversation.items) {
        if (call.kind !== "call") continue
        if (callId && call.sentCallId === callId) byId = { conversation, call }
        if (!call.answeredAt && (call.endedAt ?? call.at) >= recent && (!latest || call.at > latest.call.at)) latest = { conversation, call }
      }
    }
    const found = byId ?? latest
    if (!found) return
    const sentence = reason ? (FAILURE[reason] ?? `The call failed (${reason}).`) : "The call failed."
    if (found.call.state === "ringing" || found.call.state === "live") this.finish(found.call.id, "ended", sentence)
    else {
      found.call.summary = sentence
      this.store.changed()
    }
    this.rt.notice("error", `The call to ${maskPhone(found.conversation.contact.phone)} failed. ${sentence}`)
  }

  /** Queues a callback for when the line is free. Returns the position in line, from 1. */
  enqueueCallback(c: Conversation, reason: string): number {
    const existing = this.callbacks.findIndex((q) => q.conversationId === c.id)
    if (existing >= 0) return existing + 1
    this.callbacks.push({ conversationId: c.id, reason })
    const position = this.callbacks.length
    this.store.log(c, "propose_call", `Line busy: queued for a callback, ${position} in line`)
    this.store.event(c, "info", `Queued for a callback, ${position} in line`)
    this.store.changed()
    return position
  }

  /** Calls the next queued contact whose checks still pass. Runs when a call ends. */
  private nextCallback() {
    while (this.callbacks.length && !this.store.activeCall()) {
      const next = this.callbacks.shift()!
      const c = this.store.find(next.conversationId)
      if (!c || c.owner !== "agent") continue
      const failed = callChecks(c, this.rt.settings, Date.now(), "agent", false).find((check) => !check.ok)
      if (failed) {
        this.store.event(c, "info", `The queued callback didn't go out: ${failed.label.toLowerCase()}.`)
        this.store.changed()
        continue
      }
      try {
        this.place(c, "agent", next.reason)
        return
      } catch (error) {
        this.store.event(c, "info", `The queued callback didn't go out: ${(error as Error).message}`)
        this.store.changed()
      }
    }
  }

  // -------------------------------------------------------------------------
  // Placing a call

  place(c: Conversation, by: "agent" | "human", reason?: string) {
    if (!this.rt.isReady()) throw new Error("Start the agent first: calls go through the phone tab.")
    const failed = callChecks(c, this.rt.settings, Date.now(), by, Boolean(this.store.activeCall())).find((check) => !check.ok)
    if (failed) throw new Error(`Can't call ${displayName(c.contact)}: ${failed.label.toLowerCase()}.`)
    const call: CallItem = { kind: "call", id: newId("call"), at: Date.now(), direction: "outbound", state: "ringing", handledBy: by, reason, transcript: [] }
    c.items.push(call)
    if (by === "human") {
      this.conversations.takeOver(c, "You called the contact")
      // A person needs no model session, so the dial is allowed at once. The browser may first ask
      // for the microphone, so the request lasts longer than an agent's.
      this.pending = { callId: call.id, to: c.contact.phone, until: Date.now() + 3 * PENDING_DIAL_MS }
    } else {
      this.store.log(c, "start_call", `${formatPhone(c.contact.phone)}${reason ? `: ${reason}` : ""}`)
    }
    this.store.changed()
    if (!this.rt.phoneCommand({ type: "dial", conversationId: c.id, callId: call.id, to: c.contact.phone, by })) {
      this.finish(call.id, "ended", "The phone tab is not connected.")
      throw new Error("The phone tab is not connected.")
    }
    this.timer(call.id, DIAL_SETUP_MS, () => {
      this.rt.phoneCommand({ type: "hang-up", callId: call.id })
      this.finish(call.id, "ended", "No answer.")
    })
  }

  // -------------------------------------------------------------------------
  // Reports from the phone tab, and commands to it

  report(callId: string, state: unknown, sentCallId?: unknown, reason?: unknown) {
    const { call } = this.find(callId)
    if (typeof sentCallId === "string" && sentCallId.length < 120) call.sentCallId = sentCallId
    if (state === "live") {
      if (call.state !== "ringing") return
      call.state = "live"
      call.answeredAt = Date.now()
      call.agentAnswersAt = undefined
      this.timer(callId, MAX_CALL_MS, () => this.rt.phoneCommand({ type: "hang-up", callId }))
      this.store.changed()
      return
    }
    if (state === "ended" || state === "missed" || state === "declined") {
      if (call.state === "ringing" || call.state === "live") this.finish(callId, state, call.answeredAt ? undefined : endReason(reason))
      return
    }
    if (state === "failed") this.finish(callId, "ended", "The call failed.")
  }

  answer(callId: string, by: "agent" | "human") {
    const { conversation: c, call } = this.find(callId)
    if (call.direction !== "inbound" || call.state !== "ringing") throw new Error("That call is no longer ringing.")
    if (by === "human") {
      call.handledBy = "human"
      call.agentAnswersAt = undefined
      this.conversations.takeOver(c, "You answered the call")
    }
    this.store.changed()
    if (!this.rt.phoneCommand({ type: "answer", callId, by })) throw new Error("The phone tab is not connected.")
  }

  decline(callId: string) {
    const { call } = this.find(callId)
    if (call.state !== "ringing") throw new Error("That call is no longer ringing.")
    if (!this.rt.phoneCommand({ type: "decline", callId })) this.finish(callId, "declined")
  }

  hangUp(callId: string) {
    const { call } = this.find(callId)
    if (call.state !== "ringing" && call.state !== "live") return
    if (!this.rt.phoneCommand({ type: "hang-up", callId })) this.finish(callId, "ended", "You ended the call.")
  }

  listen(callId: string, on: boolean) {
    const { call } = this.find(callId)
    call.listening = on
    this.store.changed()
    this.rt.phoneCommand({ type: "listen", callId, on })
  }

  /** A person takes the call from the agent: the phone tab switches to the microphone, and the model session closes. */
  takeOver(callId: string) {
    const { conversation: c, call } = this.find(callId)
    if (call.state !== "live" || call.handledBy !== "agent") throw new Error("The agent is not on this call.")
    call.handledBy = "human"
    this.store.event(c, "join", "You joined the call. The agent stopped speaking.")
    this.conversations.takeOver(c, null)
    const session = this.session
    if (session?.callId === callId) {
      session.handover = true
      this.sendJson(session.socket, { type: "handover" })
      void session.voice?.close()
    }
    this.store.changed()
  }

  /** Marks a call as over, closes its model session, and starts the follow-up. */
  private finish(callId: string, state: "ended" | "missed" | "declined", summary?: string) {
    const found = this.store.findCall(callId)
    if (!found) return
    const { conversation: c, call } = found
    if (call.state !== "ringing" && call.state !== "live") return
    clearTimeout(this.timers.get(callId))
    this.timers.delete(callId)
    const answered = Boolean(call.answeredAt)
    call.endedAt = Date.now()
    call.listening = false
    call.agentAnswersAt = undefined
    if (state === "ended" && !answered) {
      call.state = call.direction === "inbound" ? "missed" : "ended"
      if (call.direction === "outbound") call.outcome ??= "no_answer"
    } else call.state = state
    if (summary && !call.summary) call.summary = summary
    if (this.pending?.callId === callId) this.pending = undefined
    if (this.session?.callId === callId) {
      const session = this.session
      this.session = undefined
      void session.voice?.close()
      if (session.socket.readyState === WebSocket.OPEN) {
        this.sendJson(session.socket, { type: "closed" })
        session.socket.close()
      }
    }
    this.store.changed()
    if (answered && call.handledBy === "agent") this.conversations.schedule(c, { kind: "call_ended" }, 800)
    if (call.direction === "inbound" && call.state === "missed") this.conversations.afterMissedCall(c)
    // The line is free: give the browser a moment to tear the call down, then the next callback.
    if (this.callbacks.length) setTimeout(() => this.nextCallback(), 3_000)
  }

  async endAll(summary: string) {
    this.callbacks = []
    const active = this.store.activeCall()
    if (active) {
      this.rt.phoneCommand({ type: "hang-up", callId: active.call.id })
      this.finish(active.call.id, "ended", summary)
    }
    this.pending = undefined
  }

  // -------------------------------------------------------------------------
  // The audio bridge: the phone tab streams the contact's audio here, and gets the agent's voice back.

  private sendJson(socket: WebSocket, message: object) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  attachBridge(socket: WebSocket, callId: string) {
    const found = this.store.findCall(callId)
    if (!found || (found.call.state !== "ringing" && found.call.state !== "live") || found.call.handledBy !== "agent" || this.session) {
      socket.close(1008, "No call for the agent.")
      return
    }
    const session: Session = { callId, socket, handover: false }
    this.session = session
    let started = false
    const startTimer = setTimeout(() => {
      if (!started) socket.close(1008, "Start required.")
    }, 5_000)
    const send = (value: object | Buffer) => {
      if (socket.readyState !== WebSocket.OPEN) return
      if (socket.bufferedAmount > 128 * 1024) {
        socket.close(1011, "Audio congestion.")
        return
      }
      socket.send(Buffer.isBuffer(value) ? value : JSON.stringify(value))
    }

    socket.on("message", async (data, binary) => {
      if (binary) {
        const voice = session.voice
        if (!voice?.isAnswered) return
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
        if (bytes.length <= 24 * 1024) voice.audio(bytes)
        return
      }
      try {
        const message = JSON.parse(data.toString())
        if (message.type === "start" && !started) {
          started = true
          clearTimeout(startTimer)
          const voice = (session.voice = this.createVoice(callId, send))
          await voice.connect()
          if (socket.readyState !== WebSocket.OPEN || this.session !== session) {
            await voice.close()
            return
          }
          const { conversation: c, call } = this.find(callId)
          // Only now may the gateway dial: the agent is ready the moment the contact picks up.
          if (call.direction === "outbound") this.pending = { callId, to: c.contact.phone, until: Date.now() + PENDING_DIAL_MS }
          else this.store.log(c, "answer_call", `Inbound from ${formatPhone(c.contact.phone)}`)
          this.store.changed()
          send({ type: "ready" })
        } else if (message.type === "answered") session.voice?.answered()
        else if (message.type === "playback") session.voice?.reportPlayback(message.itemId, message.audioMs)
      } catch (error) {
        send({ type: "error", message: (error as Error).message })
        socket.close()
      }
    })
    socket.on("error", () => {})
    socket.on("close", () => {
      clearTimeout(startTimer)
      if (this.session === session) this.session = undefined
      void session.voice?.close()
    })
  }

  private createVoice(callId: string, send: (value: object | Buffer) => void) {
    const { conversation: c, call } = this.find(callId)
    const settings = this.rt.settings
    const mode = call.direction
    const opener =
      mode === "inbound"
        ? `Thanks for calling ${settings.businessName}. I'm the AI assistant. How can I help?`
        : `Hi, this is the AI assistant from ${settings.businessName}. ${call.reason ? "You asked us to call." : "I'm following up on your messages."} Is now a good time?`
    return new VoiceAgent(
      {
        key: this.rt.openaiKey,
        model: settings.voiceModel,
        wsBase: this.rt.options.openaiWsBase,
        instructions: voicePrompt(settings, c, mode, call.reason, this.rt.campaignFor(c.campaignId)),
        mode,
        opener,
        saveOutcome: async (outcome) => this.saveOutcome(callId, outcome),
      },
      (event) => this.onVoiceEvent(callId, event, send),
    )
  }

  private onVoiceEvent(callId: string, event: VoiceEvent | Buffer, send: (value: object | Buffer) => void) {
    if (Buffer.isBuffer(event)) return send(event)
    switch (event.type) {
      case "transcript":
        this.appendTranscript(callId, event.speaker as Speaker, String(event.text))
        break
      case "audio-meta":
      case "clear":
      case "end-call":
        send(event)
        break
      case "error":
        send(event)
        this.rt.notice("error", String(event.message))
        break
      case "notice":
        console.warn(String(event.message))
        break
      case "closed":
        if (!this.session?.handover) send({ type: "closed" })
        break
    }
  }

  /** Transcript deltas stream in; consecutive deltas from one speaker form one line. */
  private appendTranscript(callId: string, speaker: Speaker, text: string) {
    const found = this.store.findCall(callId)
    if (!found || !text) return
    const { call } = found
    const last = call.transcript.at(-1)
    if (last && last.speaker === speaker) last.text += text
    else call.transcript.push({ id: newId("line"), speaker, text: text.trimStart(), at: Date.now() })
    this.store.changed()
  }

  private async saveOutcome(callId: string, outcome: OutcomeRecord) {
    const { conversation: c, call } = this.find(callId)
    call.outcome = OUTCOME[outcome.outcome]
    call.summary = outcome.callbackTime ? `${outcome.summary} Call back: ${outcome.callbackTime}.` : outcome.summary
    this.store.log(c, "record_outcome", `${outcome.outcome}: ${outcome.summary}`)
    if (outcome.outcome === "needs_person") {
      c.status = "needs_human"
      c.items.push({ kind: "proposal", id: newId("prop"), at: Date.now(), action: "handover", reason: outcome.summary, signals: ["From a phone call"], status: "pending" })
      this.rt.notice("info", `${displayName(c.contact)} needs a person: ${outcome.summary}`)
    }
    this.store.changed()
  }
}
