import type { Channel, Conversation, MessageItem, ProposalItem } from "@/lib/types"
import { CHANNEL_LABEL, displayName, firstName } from "@/lib/format"
import { activeCall, decideCall } from "@/lib/policy"
import { freeTextBlocked, whatsappWindowOpen } from "@/lib/channels"
import { toE164 } from "@/lib/phone"
import { newId } from "./store"
import { sentErrorMessage } from "./sent"
import { runTextAgent, type TextAgentTools, type Trigger } from "./text-agent"
import type { Runtime } from "./runtime"
import type { Calls } from "./calls"

const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"])
const START_WORDS = new Set(["START", "UNSTOP"])
/** Several quick texts in a row get one reply. */
const REPLY_DELAY_MS = 1_500

const STATUS: Record<string, MessageItem["status"]> = {
  SENT: "sent",
  DELIVERED: "delivered",
  READ: "read",
  FAILED: "failed",
  BLOCKED: "failed",
  FILTERED: "failed",
}
const RANK: Record<NonNullable<MessageItem["status"]>, number> = { sending: 0, sent: 1, delivered: 2, read: 3, failed: 4 }

/** Sent's `sms`, `mms`, `whatsapp`, `rcs` as this app's channels. MMS is shown as SMS. */
function channelOf(value: unknown): Channel {
  return value === "whatsapp" || value === "rcs" ? value : "sms"
}

type WebhookEvent = { field?: string; event?: string; payload?: Record<string, unknown> }

export class Conversations {
  calls!: Calls
  private timers = new Map<string, NodeJS.Timeout>()
  private queues = new Map<string, Promise<void>>()
  private seen = new Set<string>()
  /** Status events that arrived before the send returned the message id. */
  private early = new Map<string, Record<string, unknown>>()

  constructor(private rt: Runtime) {}

  private get store() {
    return this.rt.store
  }

  // -------------------------------------------------------------------------
  // Messaging webhooks

  handleWebhook(eventId: string | undefined, body: WebhookEvent) {
    // Sent retries until it gets a 2xx and keeps the event id across attempts.
    if (eventId) {
      if (this.seen.has(eventId)) return
      this.seen.add(eventId)
      if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!)
    }
    if (!body.payload) return
    if (body.field === "call") return this.calls.callEvent(body.event, body.payload)
    if (body.field !== "message") return
    if (body.event === "message.received") this.received(body.payload)
    else if (typeof body.payload.message_status === "string") this.status(body.payload)
  }

  private received(payload: Record<string, unknown>) {
    const from = toE164(payload.inbound_number)
    if (!from) return
    const channel = channelOf(payload.channel)
    const c = this.store.forPhone(from, channel)
    const sentId = typeof payload.message_id === "string" ? payload.message_id : undefined
    if (sentId && c.items.some((i) => i.kind === "message" && i.sentId === sentId)) return
    const media = Array.isArray(payload.media) && payload.media.length > 0
    const text = typeof payload.text === "string" && payload.text ? payload.text : media ? "(attachment)" : "(empty message)"
    const at = typeof payload.received_at === "string" ? Date.parse(payload.received_at) || Date.now() : Date.now()
    c.items.push({ kind: "message", id: newId("msg"), at, author: "contact", channel, text, sentId })
    c.lastChannel = channel
    c.unread += 1
    if (c.status === "resolved") c.status = "open"

    const word = text.trim().toUpperCase()
    if (STOP_WORDS.has(word)) {
      c.contact.optedOut = true
      this.store.event(c, "optout", `${displayName(c.contact)} texted ${word}. Sent stops texts to them, and the agent won't reply.`)
      this.store.changed()
      return
    }
    if (START_WORDS.has(word) && c.contact.optedOut) {
      c.contact.optedOut = false
      this.store.event(c, "optout", `${displayName(c.contact)} texted ${word} and can get texts again.`)
    }
    this.store.changed()
    this.schedule(c, c.owner === "agent" ? { kind: "message" } : { kind: "draft" })
  }

  private status(payload: Record<string, unknown>) {
    const id = typeof payload.message_id === "string" ? payload.message_id : undefined
    if (!id) return
    const found = this.store.findMessage(id)
    if (!found) {
      this.early.set(id, payload)
      setTimeout(() => this.early.delete(id), 30_000)
      return
    }
    this.applyStatus(found.message, payload)
    this.store.changed()
  }

  private applyStatus(message: MessageItem, payload: Record<string, unknown>) {
    const next = STATUS[String(payload.message_status).toUpperCase()]
    if (!next) return
    if (next === "failed" || RANK[next] > RANK[message.status ?? "sending"]) message.status = next
    if (next === "failed") message.error = typeof payload.reason === "string" ? payload.reason : "Sent could not deliver this message."
    // Sent reports the channel its routing picked; before routing it may say "sent" or "auto".
    if (payload.channel === "sms" || payload.channel === "whatsapp" || payload.channel === "rcs") {
      message.channel = payload.channel
      message.routing = false
    } else if (next === "failed") message.routing = false
    // Status events carry the rendered body; for a template it is the exact text the contact got.
    if (message.template && typeof payload.body === "string" && payload.body) message.text = payload.body
  }

  // -------------------------------------------------------------------------
  // Message history

  /**
   * Imports your newest Sent messages, so the inbox starts with every number
   * you have texted. Sent groups a contact's messages across channels into one
   * conversation, like this app. The agent never replies to imported history.
   */
  async importHistory(limit = 1000): Promise<number> {
    const sent = this.rt.requireSent()
    const messages = await sent.history(limit)
    const known = new Set(this.store.conversations.flatMap((c) => c.items.flatMap((i) => (i.kind === "message" && i.sentId ? [i.sentId] : []))))
    const touched = new Set<Conversation>()
    for (const m of messages) {
      const phone = toE164(m.phone)
      if (!phone || !m.id || known.has(m.id)) continue
      const channel = channelOf(m.channel)
      const isNew = !this.store.conversations.some((c) => c.contact.phone === phone)
      const c = this.store.forPhone(phone, channel)
      if (isNew) c.lastChannel = channel
      const inbound = m.direction?.toUpperCase() === "INBOUND"
      const status = STATUS[m.status?.toUpperCase() ?? ""]
      c.items.push({
        kind: "message",
        id: newId("msg"),
        at: Date.parse(m.created_at ?? "") || Date.now(),
        author: inbound ? "contact" : "human",
        channel,
        text: m.message_body?.content || (m.template_name ? `(template: ${m.template_name})` : "(empty message)"),
        sentId: m.id,
        fromHistory: true,
        template: m.template_name ?? undefined,
        status: inbound ? undefined : (status ?? "sent"),
        error: status === "failed" ? (m.reason ?? undefined) : undefined,
      })
      known.add(m.id)
      touched.add(c)
    }
    for (const c of touched) {
      c.items.sort((a, b) => a.at - b.at)
      const lastInbound = c.items.findLast((i) => i.kind === "message" && i.author === "contact")
      if (lastInbound?.kind === "message") c.lastChannel = lastInbound.channel
    }
    this.store.conversations.sort((a, b) => (b.items.at(-1)?.at ?? 0) - (a.items.at(-1)?.at ?? 0))
    if (touched.size) this.store.changed()
    return touched.size
  }

  // -------------------------------------------------------------------------
  // Sending

  private requireSendable(c: Conversation) {
    if (!this.rt.isReady()) throw new Error("Start the agent to send texts.")
    if (c.contact.optedOut) throw new Error(`${displayName(c.contact)} texted STOP. Sent blocks texts to them until they text START.`)
  }

  /**
   * Sends free-form text and tracks it until Sent reports the outcome. Sent's
   * routing picks the sender, and the channel unless the agent chose one.
   */
  async send(c: Conversation, text: string, author: "agent" | "human", channel?: Channel): Promise<void> {
    const sent = this.rt.requireSent()
    this.requireSendable(c)
    const body = text.trim().slice(0, 1500)
    if (!body) throw new Error("Write a message first.")
    const blocked = freeTextBlocked(c, Date.now(), channel)
    if (blocked) throw new Error(`${blocked} Send an approved template instead.`)
    // Without a chosen channel, the contact's last channel is a guess until Sent reports the one it picked.
    const message: MessageItem = { kind: "message", id: newId("msg"), at: Date.now(), author, channel: channel ?? c.lastChannel, routing: !channel, text: body, status: "sending" }
    c.items.push(message)
    if (author === "human") c.suggestion = undefined
    if (c.status === "resolved") c.status = "open"
    this.store.changed()
    try {
      message.sentId = await sent.sendText({ to: c.contact.phone, text: body, channel, idempotencyKey: message.id })
      if (!message.sentId) message.status = "sent"
      else {
        const early = this.early.get(message.sentId)
        if (early) this.applyStatus(message, early)
      }
      if (author === "agent") this.store.log(c, "send_message", `${channel ? `${CHANNEL_LABEL[channel]}: ` : ""}${body.length > 70 ? `${body.slice(0, 70)}…` : body}`)
    } catch (error) {
      message.status = "failed"
      message.error = sentErrorMessage(error)
    }
    this.store.changed()
  }

  /** Sends an approved template with its variables. Sent's routing picks the channel among the template's channels, unless the agent chose one. */
  async sendTemplate(c: Conversation, templateId: unknown, parameters: unknown, author: "agent" | "human", channel?: Channel): Promise<{ body: string }> {
    const sent = this.rt.requireSent()
    this.requireSendable(c)
    const template = this.rt.templates.find((t) => t.id === templateId || t.name === templateId)
    if (!template) throw new Error("Choose one of your approved Sent templates.")
    const values = (parameters && typeof parameters === "object" ? parameters : {}) as Record<string, unknown>
    const filled: Record<string, string> = {}
    for (const name of template.variables) {
      const value = values[name]
      if (typeof value !== "string" || !value.trim()) throw new Error(`Fill in ${name} for the template "${template.name}".`)
      filled[name] = value.trim().slice(0, 500)
    }
    if (channel && !template.channels.includes(channel)) throw new Error(`The template "${template.name}" can't be sent by ${CHANNEL_LABEL[channel]}.`)
    const message: MessageItem = {
      kind: "message",
      id: newId("msg"),
      at: Date.now(),
      author,
      channel: channel ?? (template.channels.includes(c.lastChannel) ? c.lastChannel : (template.channels[0] ?? "sms")),
      routing: !channel,
      text: `Template “${template.name}”`,
      template: template.name,
      status: "sending",
    }
    c.items.push(message)
    if (author === "human") c.suggestion = undefined
    if (c.status === "resolved") c.status = "open"
    this.store.changed()
    try {
      const result = await sent.sendTemplate({ to: c.contact.phone, templateId: template.id, parameters: filled, channel, idempotencyKey: message.id })
      message.sentId = result.messageId
      if (result.body) message.text = result.body
      if (!message.sentId) message.status = "sent"
      else {
        const early = this.early.get(message.sentId)
        if (early) this.applyStatus(message, early)
      }
      if (author === "agent") this.store.log(c, "send_message", `${channel ? `${CHANNEL_LABEL[channel]} t` : "T"}emplate: ${template.name}`)
    } catch (error) {
      message.status = "failed"
      message.error = sentErrorMessage(error)
    }
    this.store.changed()
    return { body: message.text }
  }

  // -------------------------------------------------------------------------
  // Team member actions

  takeOver(c: Conversation, text: string | null = "You took over from the agent") {
    if (c.owner === "agent" && text) this.store.event(c, "takeover", text)
    c.owner = "human"
    c.agentTyping = false
    if (c.status === "needs_human") c.status = "open"
    for (const proposal of this.pending(c, "handover")) {
      proposal.status = "approved"
      proposal.resolution = "You took over."
    }
    this.store.changed()
    const last = c.items.findLast((i) => i.kind === "message")
    if (last?.kind === "message" && last.author === "contact") this.schedule(c, { kind: "draft" }, 0)
  }

  handBack(c: Conversation) {
    c.owner = "agent"
    c.suggestion = undefined
    this.store.event(c, "handback", "You handed the conversation back to the agent")
    this.store.changed()
    this.schedule(c, { kind: "handback" }, 0)
  }

  resolve(c: Conversation) {
    c.status = "resolved"
    for (const proposal of [...this.pending(c, "call"), ...this.pending(c, "handover")]) {
      proposal.status = "dismissed"
      proposal.resolution = "Closed when the conversation was resolved."
    }
    this.store.event(c, "resolved", "You resolved this conversation")
    this.store.changed()
  }

  reopen(c: Conversation) {
    c.status = "open"
    this.store.event(c, "reopened", "You reopened this conversation")
    this.store.changed()
  }

  read(c: Conversation) {
    if (c.unread === 0) return
    c.unread = 0
    this.store.changed()
  }

  setConsent(c: Conversation, granted: boolean) {
    c.contact.callConsent = granted ? { granted: true, source: "Marked by a team member." } : { granted: false }
    if (granted) this.store.event(c, "consent", `You marked that ${firstName(c.contact)} agreed to a call`)
    this.store.changed()
  }

  setTimeZone(c: Conversation, timeZone: unknown) {
    if (typeof timeZone !== "string") throw new Error("Choose a time zone.")
    try {
      new Intl.DateTimeFormat("en", { timeZone })
    } catch {
      throw new Error(`${timeZone} is not a time zone.`)
    }
    c.contact.timeZone = timeZone
    c.contact.city = undefined
    this.store.changed()
  }

  approve(c: Conversation, proposalId: string, by: "agent" | "human") {
    const proposal = this.proposal(c, proposalId)
    if (proposal.action === "handover") {
      this.takeOver(c)
      return
    }
    this.calls.place(c, by, by === "agent" ? proposal.reason : undefined)
    proposal.status = "approved"
    proposal.resolution = by === "agent" ? "You approved the call." : "You called instead."
    this.store.changed()
  }

  dismiss(c: Conversation, proposalId: string) {
    const proposal = this.proposal(c, proposalId)
    proposal.status = "dismissed"
    if (proposal.action === "handover") {
      proposal.resolution = "You asked the agent to continue."
      c.status = "open"
      this.store.event(c, "handback", "You asked the agent to keep going")
      this.store.changed()
      this.schedule(c, { kind: "handback" }, 0)
    } else {
      proposal.resolution = "Dismissed. The agent continues by text."
      this.store.changed()
      this.schedule(c, { kind: "call_dismissed" }, 0)
    }
  }

  /**
   * After a call no one answered: the agent texts the caller. Without free
   * text (the caller never texted you) it may only send a fitting template.
   */
  afterMissedCall(c: Conversation) {
    if (c.owner !== "agent" || c.contact.optedOut) return
    if (freeTextBlocked(c, Date.now()) && !this.agentTemplates().length) {
      this.store.event(c, "info", "No text sent: this caller has never texted you, and you have no approved utility template for the agent to send.")
      this.store.changed()
      return
    }
    this.schedule(c, { kind: "missed_call" }, 500)
  }

  /** The templates the agent may send: approved utility templates only, never marketing or one-time codes. */
  agentTemplates() {
    return this.rt.templates.filter((t) => t.category.toUpperCase() === "UTILITY")
  }

  private pending(c: Conversation, action: ProposalItem["action"]) {
    return c.items.filter((i): i is ProposalItem => i.kind === "proposal" && i.action === action && i.status === "pending")
  }

  private proposal(c: Conversation, id: string) {
    const proposal = c.items.find((i): i is ProposalItem => i.kind === "proposal" && i.id === id)
    if (!proposal || proposal.status !== "pending") throw new Error("That request was already handled.")
    return proposal
  }

  // -------------------------------------------------------------------------
  // The text agent

  /** Runs an agent turn after a short delay. Turns for one conversation run one at a time. */
  schedule(c: Conversation, trigger: Trigger, delay = REPLY_DELAY_MS) {
    clearTimeout(this.timers.get(c.id))
    this.timers.set(
      c.id,
      setTimeout(() => {
        this.timers.delete(c.id)
        const previous = this.queues.get(c.id) ?? Promise.resolve()
        const next = previous.then(() => this.turn(c.id, trigger))
        this.queues.set(c.id, next)
        void next.finally(() => {
          if (this.queues.get(c.id) === next) this.queues.delete(c.id)
        })
      }, delay),
    )
  }

  private async turn(id: string, trigger: Trigger) {
    const c = this.store.find(id)
    if (!c || !this.rt.isReady() || c.contact.optedOut || !this.rt.agentServes(c.contact.phone)) return
    const draft = trigger.kind === "draft"
    if (draft ? c.owner !== "human" : c.owner !== "agent") return
    if (!draft) c.agentTyping = true
    this.store.changed()
    try {
      const blocked = freeTextBlocked(c, Date.now())
      // The agent may pin the channel for this turn's reply with choose_channel; otherwise Sent's routing picks.
      const turn: { channel?: Channel } = {}
      const channels = { used: c.contact.channels, last: c.lastChannel, whatsappOpen: whatsappWindowOpen(c, Date.now()) }
      const reply = await runTextAgent(c, trigger, {
        key: this.rt.openaiKey,
        settings: this.rt.settings,
        tools: this.tools(c, turn),
        httpBase: this.rt.options.openaiHttpBase,
        freeText: blocked ? { blocked, templates: this.agentTemplates(), channels } : { allowed: true, channels },
        campaign: this.rt.campaignFor(c.campaignId),
      })
      if (draft) c.suggestion = reply ?? undefined
      // A team member may have taken over while the model was writing. Without free text, only a template goes out.
      else if (reply && c.owner === "agent" && !freeTextBlocked(c, Date.now())) {
        c.agentTyping = false
        await this.send(c, reply, "agent", turn.channel)
      }
    } catch (error) {
      this.rt.notice("error", `The agent couldn't reply to ${displayName(c.contact)}: ${(error as Error).message}`)
    } finally {
      c.agentTyping = false
      this.store.changed()
    }
  }

  private tools(c: Conversation, turn: { channel?: Channel } = {}): TextAgentTools {
    return {
      chooseChannel: async (channel, reason) => {
        // A pinned channel has no fallback, so a rich one needs proof the customer is on it.
        const wroteThere = c.items.some((i) => i.kind === "message" && i.author === "contact" && i.channel === channel)
        if (channel !== "sms" && !wroteThere) return { ok: false, error: `The customer hasn't written on ${CHANNEL_LABEL[channel]}. Leave the channel to Sent's routing.` }
        const blocked = freeTextBlocked(c, Date.now(), channel)
        if (blocked) return { ok: false, error: `${blocked} Leave the channel to Sent's routing.` }
        turn.channel = channel
        this.store.log(c, "choose_channel", `${CHANNEL_LABEL[channel]}: ${reason}`)
        return { ok: true }
      },
      proposeCall: async (reason, signals) => {
        const lineBusy = Boolean(this.store.activeCall())
        const decision = decideCall(c, this.rt.settings, Date.now(), lineBusy)
        this.store.log(c, "propose_call", `${signals.join("; ") || reason} → ${decision.kind}`)
        if (decision.kind === "decline") {
          // The only problem is another call on the line: with "Call on its own", wait for it to end.
          const onlyLineBusy = decision.failed.every((check) => check.id === "line")
          if (onlyLineBusy && this.rt.settings.callPolicy === "auto" && !activeCall(c)) {
            const position = this.calls.enqueueCallback(c, reason)
            return { result: "queued", position }
          }
          const failed = decision.failed[0]
          return { result: "declined", reason: failed.label, detail: failed.detail }
        }
        if (decision.kind === "dial") {
          try {
            this.calls.place(c, "agent", reason)
            return { result: "dialing" }
          } catch (error) {
            return { result: "declined", reason: (error as Error).message }
          }
        }
        if (this.pending(c, "call").length === 0) {
          c.items.push({ kind: "proposal", id: newId("prop"), at: Date.now(), action: "call", reason, signals, status: "pending" })
          this.store.changed()
        }
        return { result: "waiting_for_approval" }
      },
      recordConsent: async (evidence) => {
        c.contact.callConsent = { granted: true, source: `“${evidence}”` }
        this.store.event(c, "consent", `${firstName(c.contact)} agreed to a call`)
        this.store.log(c, "record_call_consent", evidence)
        this.store.changed()
        return { ok: true }
      },
      sendTemplate: async (template, parameters, channel) => {
        if (!freeTextBlocked(c, Date.now())) return { sent: false, error: "Free text is allowed. Reply with text instead." }
        if (!this.agentTemplates().some((t) => t.id === template || t.name === template)) return { sent: false, error: "Use one of the listed utility templates." }
        const { body } = await this.sendTemplate(c, template, parameters, "agent", channel)
        return { sent: true, body }
      },
      requestHandover: async (reason, signals) => {
        c.status = "needs_human"
        if (this.pending(c, "handover").length === 0) {
          c.items.push({ kind: "proposal", id: newId("prop"), at: Date.now(), action: "handover", reason, signals, status: "pending" })
        }
        this.store.log(c, "request_handover", reason)
        this.store.changed()
        this.rt.notice("info", `${displayName(c.contact)} needs a person: ${reason}`)
        return { ok: true }
      },
    }
  }
}
