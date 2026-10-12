import type { AgentSettings, Channel, Conversation, TemplateSummary, ThreadItem } from "@/lib/types"
import { CHANNEL_LABEL, contactPlace, contactZone, displayName, formatDuration, formatPhone, localTime } from "@/lib/format"
import { fetchWithReason } from "./http"

export const OPENAI_HTTP = "https://api.openai.com"

/** What the text agent was woken up for. */
export type Trigger =
  | { kind: "message" }
  | { kind: "call_ended" }
  | { kind: "missed_call" }
  | { kind: "handback" }
  /** A team member decided not to call. */
  | { kind: "call_dismissed" }
  /** A person owns the conversation: write a draft for them, with no tools. */
  | { kind: "draft" }

export type TextAgentTools = {
  chooseChannel(channel: Channel, reason: string): Promise<object>
  proposeCall(reason: string, signals: string[]): Promise<object>
  recordConsent(evidence: string): Promise<object>
  requestHandover(reason: string, signals: string[]): Promise<object>
  sendTemplate(template: string, parameters: Record<string, string>, channel?: Channel): Promise<object>
}

/** What the agent should know about channels: where the contact writes, and whether WhatsApp's 24-hour window is open. */
export type ChannelFacts = { used: Channel[]; last: Channel; whatsappOpen: boolean }

/** Whether a free-text reply can go out now, or why not and which templates the agent may send instead. */
export type FreeText = ({ allowed: true } | { blocked: string; templates: TemplateSummary[] }) & { channels?: ChannelFacts }

const NO_REPLY = "NO_REPLY"

const CHANNELS = ["sms", "whatsapp", "rcs"] as const

const TOOLS = [
  {
    type: "function",
    name: "choose_channel",
    description:
      "Optional. Pin the channel for your next message when there is a reason: the customer asked for it, or they write on WhatsApp and expect the reply there. Without it, Sent's routing picks the channel. You never choose the sender.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["channel", "reason"],
      properties: {
        channel: { type: "string", enum: CHANNELS },
        reason: { type: "string", description: "Why this channel, in a few words." },
      },
    },
  },
  {
    type: "function",
    name: "propose_call",
    description:
      "Ask to phone the customer, when a call would help: they asked for one, or the topic needs back-and-forth that is slow by text. Only after they asked for or agreed to a call. The result says what happened.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["reason", "signals"],
      properties: {
        reason: { type: "string", description: "One sentence a team member can read: why a call helps now." },
        signals: { type: "array", items: { type: "string" }, description: "Two to four short labels, for example \"Asked for a call\"." },
      },
    },
  },
  {
    type: "function",
    name: "record_call_consent",
    description: "Record that the customer asked for a phone call or agreed to one. Call it when they do, before propose_call.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["evidence"],
      properties: { evidence: { type: "string", description: "The customer's own words that show consent." } },
    },
  },
  {
    type: "function",
    name: "send_template",
    description:
      "Send one of the approved templates listed in the prompt. Only when free text isn't allowed, and only a template whose name clearly fits the situation. After it is sent, answer NO_REPLY.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["template", "parameters"],
      properties: {
        template: { type: "string", description: "The template name, exactly as listed." },
        parameters: { type: "object", description: "A value for each of the template's variables, keyed by variable name.", additionalProperties: { type: "string" } },
        channel: { type: "string", enum: CHANNELS, description: "Optional. Leave it out to let Sent's routing pick the channel." },
      },
    },
  },
  {
    type: "function",
    name: "request_handover",
    description: "Bring in a team member when the customer needs something you can't do or decide. Then tell the customer a colleague will reply here.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["reason", "signals"],
      properties: {
        reason: { type: "string", description: "One sentence for the team member: what the customer needs and why you can't do it." },
        signals: { type: "array", items: { type: "string" }, description: "Two to four short labels, for example \"Refund above limit\"." },
      },
    },
  },
]

function handoverRules(settings: AgentSettings) {
  const rules = [
    "a decision or an action you can't take, for example changing an order",
    `a refund or credit above $${settings.handover.refundLimit}`,
  ]
  if (settings.handover.onRequest) rules.unshift("the customer asks for a person")
  if (settings.handover.onFrustration) rules.push("the customer is upset or frustrated")
  return rules.join("; ")
}

export function systemPrompt(settings: AgentSettings) {
  return [
    `You are the AI assistant for ${settings.businessName}. You text with customers by SMS, WhatsApp, and RCS. The app can also phone them.`,
    `Instructions from the team:\n${settings.instructions}`,
    [
      "How you work:",
      "- Reply in the customer's language, in one to three short sentences. Plain text only, no markdown.",
      "- If someone asks whether you're a person, say you're an AI assistant.",
      `- Customers can call you at ${formatPhone(settings.number)}: you or the team answer calls to it.`,
      `- When talking would help (the goal mentions a call, the question needs back-and-forth, or the customer seems unsure), invite a call: they can call ${formatPhone(settings.number)} anytime, or you can call them now if they reply yes.`,
      "- When the customer asks for a call or agrees to one, call record_call_consent with their words, then propose_call. The result tells you what happened: dialing (say you're calling now), queued (another call is on the line; say you'll call them in a few minutes), waiting_for_approval (say someone will call shortly), or declined with the reason (stay in text and explain briefly).",
      `- Use request_handover when: ${handoverRules(settings)}. Then tell the customer a colleague will reply here.`,
      "- Never promise what you can't see or do. If you don't know, say so and offer a team member.",
      `- If nothing needs to be sent, answer with exactly ${NO_REPLY}.`,
    ].join("\n"),
  ].join("\n\n")
}

function speakerLabel(item: ThreadItem): string {
  if (item.kind !== "message") return ""
  if (item.author === "contact") return "customer"
  if (item.fromHistory) return item.template ? `the business, template "${item.template}"` : "the business"
  return item.author === "agent" ? "you" : "team member"
}

/** The thread as plain text, oldest first: messages, calls with their summary and transcript, and events. */
export function threadText(c: Conversation, maxChars = 14_000): string {
  const clock = (at: number) => localTime(contactZone(c.contact), at)
  const lines = c.items.map((item) => {
    switch (item.kind) {
      case "message": {
        const failed = item.status === "failed" ? " (not delivered)" : ""
        return `[${clock(item.at)}, ${speakerLabel(item)}, ${CHANNEL_LABEL[item.channel]}${failed}] ${item.text}`
      }
      case "call": {
        const who = item.handledBy === "agent" ? "you" : "a team member"
        const length = item.answeredAt ? formatDuration((item.endedAt ?? Date.now()) - item.answeredAt) : null
        const head = `[${clock(item.at)}, ${item.direction} phone call, ${item.state}${length ? `, ${length}` : ""}, handled by ${who}]`
        const transcript = item.transcript.map((l) => `  ${l.speaker === "contact" ? "Customer" : l.speaker === "agent" ? "You" : "Team member"}: ${l.text}`).join("\n")
        return [head, item.reason && `  Reason: ${item.reason}`, item.summary && `  Summary: ${item.summary}`, transcript].filter(Boolean).join("\n")
      }
      case "event":
        return `[${clock(item.at)}, event] ${item.text}`
      case "proposal":
        return `[${clock(item.at)}, you asked to ${item.action === "call" ? "call" : "bring in a team member"}] ${item.reason} ${item.resolution ?? "(waiting for a team member)"}`
    }
  })
  const text = lines.join("\n")
  return text.length > maxChars ? `…\n${text.slice(-maxChars)}` : text
}

const TRIGGER_TEXT: Record<Trigger["kind"], string> = {
  message: "Reply to the customer's latest message.",
  call_ended: `The phone call above just ended. If you promised during the call to text something, such as a link, a summary, or a confirmation, send it now in one message. Otherwise answer ${NO_REPLY}.`,
  missed_call: "The customer just called and no one could answer. Send one short text: sorry you missed the call, and how can you help.",
  handback: `A team member handed the conversation back to you. If the customer is waiting for an answer, reply. Otherwise answer ${NO_REPLY}.`,
  call_dismissed: "A team member decided not to call right now. Tell the customer briefly that a call isn't possible at the moment, and keep helping by text.",
  draft: "A team member is replying to this customer. Write the next reply as they could send it, for them to review. Don't mention that it is a draft.",
}

function channelText(facts: ChannelFacts | undefined) {
  if (!facts) return ""
  const used = facts.used.length ? facts.used.map((c) => CHANNEL_LABEL[c]).join(", ") : "none yet"
  return `Channels the customer has written on: ${used}; last on ${CHANNEL_LABEL[facts.last]}. WhatsApp's 24-hour window is ${facts.whatsappOpen ? "open" : "closed"}.`
}

function freeTextText(freeText: FreeText | undefined) {
  if (!freeText) return ""
  if ("allowed" in freeText) {
    return [
      "Favor rich channels. If the customer writes on WhatsApp and its 24-hour window is open, call choose_channel with whatsapp. If they write on RCS, choose rcs. Otherwise don't choose: Sent's routing picks the channel and falls back on its own. Never choose a channel the customer hasn't written on.",
      channelText(freeText.channels),
    ]
      .filter(Boolean)
      .join("\n")
  }
  const list = freeText.templates.map((t) => `- "${t.name}"${t.variables.length ? ` (variables: ${t.variables.join(", ")})` : ""}`).join("\n")
  return [
    `Free text isn't allowed right now: ${freeText.blocked}`,
    channelText(freeText.channels),
    list
      ? `You can only send one of these approved templates with send_template, and only if its name clearly fits. Otherwise answer ${NO_REPLY}.\nTemplates:\n${list}`
      : `There is no template you may send, so answer ${NO_REPLY}.`,
  ].join("\n")
}

export type CampaignContext = { name: string; scenario: string }

export function promptFor(c: Conversation, trigger: Trigger, now = Date.now(), freeText?: FreeText, campaign?: CampaignContext) {
  return [
    `Customer: ${displayName(c.contact)}. Their local time: ${localTime(contactZone(c.contact), now)} (${contactPlace(c.contact)}).`,
    campaign && `This conversation started with your campaign "${campaign.name}". The team's goal for it:\n${campaign.scenario}`,
    `Conversation so far, oldest first:\n${threadText(c) || "(nothing yet)"}`,
    freeTextText(freeText),
    TRIGGER_TEXT[trigger.kind],
  ]
    .filter(Boolean)
    .join("\n\n")
}

type OutputItem = { type: string; call_id?: string; name?: string; arguments?: string; content?: Array<{ type: string; text?: string }> }

/**
 * Runs one turn of the text agent with the Responses API, statelessly
 * (store: false), and returns the text to send, or null for no reply.
 */
export async function runTextAgent(
  conversation: Conversation,
  trigger: Trigger,
  deps: { key: string; settings: AgentSettings; tools: TextAgentTools; freeText?: FreeText; campaign?: CampaignContext; httpBase?: string; signal?: AbortSignal },
): Promise<string | null> {
  const useTools = trigger.kind !== "draft"
  // send_template exists only while free text is blocked, so the agent can't reach for a template when text would do.
  const tools = deps.freeText && "blocked" in deps.freeText ? TOOLS : TOOLS.filter((tool) => tool.name !== "send_template")
  const input: unknown[] = [{ role: "user", content: promptFor(conversation, trigger, Date.now(), trigger.kind === "draft" ? undefined : deps.freeText, deps.campaign) }]
  let reply = ""

  for (let round = 0; round < 4; round++) {
    const response = await fetchWithReason((deps.httpBase ?? OPENAI_HTTP) + "/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.key}`, "Content-Type": "application/json" },
      signal: deps.signal ?? AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: deps.settings.textModel,
        instructions: systemPrompt(deps.settings),
        input,
        ...(useTools ? { tools, tool_choice: "auto" } : {}),
        // Customers wait on every reply, so each model runs at its lowest reasoning effort.
        reasoning: { effort: "none" },
        max_output_tokens: 800,
        store: false,
        include: ["reasoning.encrypted_content"],
      }),
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
      throw new Error(`OpenAI ${response.status}: ${body.error?.message ?? "request failed"}`)
    }
    const result = (await response.json()) as { output?: OutputItem[] }
    const output = result.output ?? []
    const text = output
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === "output_text" && part.text)
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (text) reply = text

    const calls = output.filter((item) => item.type === "function_call")
    if (calls.length === 0) break
    input.push(...output)
    for (const call of calls) {
      input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(await runTool(call, deps.tools)) })
    }
  }

  if (!reply || reply === NO_REPLY || reply.endsWith(NO_REPLY)) return null
  return reply.slice(0, 1500)
}

async function runTool(call: OutputItem, tools: TextAgentTools): Promise<object> {
  try {
    const args = JSON.parse(call.arguments || "{}") as { reason?: unknown; signals?: unknown; evidence?: unknown; template?: unknown; parameters?: unknown; channel?: unknown }
    const channel = CHANNELS.find((c) => c === args.channel)
    const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 300) : ""
    const signals = Array.isArray(args.signals) ? args.signals.filter((s): s is string => typeof s === "string").map((s) => s.slice(0, 40)).slice(0, 4) : []
    switch (call.name) {
      case "choose_channel":
        if (!channel) throw new Error("Choose sms, whatsapp, or rcs.")
        return await tools.chooseChannel(channel, reason || "No reason given.")
      case "propose_call":
        if (!reason) throw new Error("A reason is required.")
        return await tools.proposeCall(reason, signals)
      case "record_call_consent":
        if (typeof args.evidence !== "string" || !args.evidence.trim()) throw new Error("Evidence is required.")
        return await tools.recordConsent(args.evidence.trim().slice(0, 300))
      case "request_handover":
        if (!reason) throw new Error("A reason is required.")
        return await tools.requestHandover(reason, signals)
      case "send_template": {
        if (typeof args.template !== "string" || !args.template) throw new Error("Name the template.")
        const raw = args.parameters && typeof args.parameters === "object" ? (args.parameters as Record<string, unknown>) : {}
        const parameters = Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        return await tools.sendTemplate(args.template, parameters, channel)
      }
      default:
        throw new Error(`Unknown tool ${call.name}.`)
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

/** Validates an OpenAI key without starting a model session. */
export async function checkOpenAIKey(key: string, httpBase = OPENAI_HTTP): Promise<void> {
  const response = await fetchWithReason(httpBase + "/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(12_000) })
  await response.body?.cancel()
  if (!response.ok) throw new Error(`OpenAI key check failed (${response.status}).`)
}
