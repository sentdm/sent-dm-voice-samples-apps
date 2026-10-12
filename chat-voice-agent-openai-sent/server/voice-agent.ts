import WebSocket from "ws"
import type { AgentSettings, Conversation } from "@/lib/types"
import { threadText } from "./text-agent"

// Adapted from the inbound and outbound samples' OpenAI adapter, Realtime models only:
// this agent always needs its tools (record_outcome, end_call).

const TRANSCRIPTION_MODEL = "gpt-live-transcribe"

export const VOICE_OUTCOMES = ["resolved", "callback_requested", "not_interested", "voicemail", "needs_person"] as const
export type VoiceOutcome = (typeof VOICE_OUTCOMES)[number]
export type OutcomeRecord = { outcome: VoiceOutcome; summary: string; callbackTime?: string }

export type VoiceConfig = {
  key: string
  model: string
  instructions: string
  mode: "inbound" | "outbound"
  /** The first thing the agent says. */
  opener: string
  wsBase?: string
  saveOutcome: (outcome: OutcomeRecord) => Promise<void>
  /** Ends the call after this long with neither contact speech nor agent audio, counted from the answer. */
  idleTimeoutMs?: number
  /** Outbound only: how long the agent waits for the contact's "Hello?" before it speaks first. */
  openingWaitMs?: number
}

export type VoiceEvent = { type: string; [key: string]: unknown }
export type Emit = (event: VoiceEvent | Buffer) => void

// "Most errors are recoverable and the session will stay open" (OpenAI Realtime server events).
// Only billing, limit, and auth failures leave it unusable.
const FATAL_ERROR_CODES = new Set([
  "session_expired",
  "invalid_api_key",
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
])
const isFatal = (error: { code?: string; type?: string } | undefined) => FATAL_ERROR_CODES.has(error?.code ?? "") || error?.type === "insufficient_quota"
const DEFAULT_IDLE_TIMEOUT_MS = 60_000
// Live tests of the outbound sample: at 1.5 s the opening line started while people were still saying who they were.
const DEFAULT_OPENING_WAIT_MS = 3_000
// People pause inside their first words ("Hello? … yes, Betim here"), so the first turn ends after a longer pause.
const FIRST_TURN_SILENCE_MS = 900
const TURN_SILENCE_MS = 450

const TOOLS = [
  {
    type: "function",
    name: "record_outcome",
    description: "Record how the call went, once you know. Call it without announcing it, before end_call.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["outcome", "summary"],
      properties: {
        outcome: {
          type: "string",
          enum: VOICE_OUTCOMES,
          description: "needs_person: a team member must follow up. voicemail: you left a voicemail.",
        },
        summary: { type: "string", description: "One or two sentences on what was said and agreed. Don't add details they didn't say." },
        callback_time: { type: "string", description: "When they asked to be called back, in their words, if they did." },
      },
    },
  },
  {
    type: "function",
    name: "end_call",
    description: "Hang up once the conversation is over. Don't say goodbye first: you'll be asked to say it right after, and the call ends once it has played.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
  },
]
// Left to the model, the goodbye before end_call was skipped or narrated in 4 of 5 calls in the inbound sample's
// live tests, so the app asks for it explicitly, with tools off, and hangs up when it has finished.
const GOODBYE = "Say a short, warm goodbye, like “Thanks, bye!”. Nothing else."

/** Instructions for one call: the team's instructions, the call's purpose, and what happened before it. */
export function voicePrompt(settings: AgentSettings, conversation: Conversation, mode: "inbound" | "outbound", reason?: string, campaign?: { name: string; scenario: string }) {
  const purpose =
    mode === "inbound"
      ? "The customer called the business. Greet them, say you're the AI assistant, and ask how you can help."
      : `You called the customer. Why: ${reason ?? "to follow up on their messages"}. When they answer, let them speak first, then say who you are and why you're calling.`
  return [
    `You are the AI voice assistant for ${settings.businessName}, on a phone call with a customer. Say that you're an AI assistant in your first sentence.`,
    `Instructions from the team:\n${settings.instructions}`,
    [
      "How you speak:",
      "- Sound like a friendly person, not a script. Keep most replies under 20 words, ask one question at a time, and use plain words.",
      "- Don't read out links, codes, or long numbers. Offer to text them after the call; the app texts what you promised once the call ends.",
      "- You can't see accounts, orders, or payments, so don't guess or promise anything.",
      "- If the customer needs a team member, say a colleague will follow up, and record the outcome as needs_person.",
      "- If you reach voicemail, wait for the beep, leave one short message, then end the call.",
      "- Before you end the call, record the outcome.",
    ].join("\n"),
    purpose,
    campaign && `This customer is part of your campaign "${campaign.name}". The team's goal for it:\n${campaign.scenario}`,
    `What happened before this call (texts and earlier calls), oldest first:\n${threadText(conversation, 8_000) || "(nothing yet)"}`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined)

export class VoiceAgent {
  private socket?: WebSocket
  private ready = false
  private ending = false
  private pickedUp = false
  private firstReplyDone = false
  private closing?: Promise<void>
  private playback = new Map<string, number>()
  private activeItem?: string
  private pendingByte = Buffer.alloc(0)
  private inputTranscripts = new Map<string, string>()
  private toolCalls: Promise<"continue" | "end">[] = []
  private hangUpAfterResponse = false
  private lastActivity = 0
  private idleTimer?: NodeJS.Timeout
  private openingTimer?: NodeJS.Timeout

  constructor(
    private config: VoiceConfig,
    private sink: Emit,
  ) {}

  get connected(): boolean {
    return this.ready && !this.ending
  }

  /** Before the contact picks up, the line carries ringback and carrier messages, which the model must not hear. */
  get isAnswered(): boolean {
    return this.pickedUp
  }

  private emit(event: VoiceEvent | Buffer): void {
    if (Buffer.isBuffer(event) || event.type === "transcript" || event.type === "clear") this.lastActivity = Date.now()
    this.sink(event)
  }

  private instructions(): string {
    return `${this.config.instructions}\n\nOpen with: “${this.config.opener}”`
  }

  // The server cancels the response when the contact starts talking; the client only truncates to what was heard.
  private inputAudio(silenceMs: number) {
    return {
      format: { type: "audio/pcm", rate: 24000 },
      turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: silenceMs, create_response: true, interrupt_response: true },
      transcription: { model: TRANSCRIPTION_MODEL },
    }
  }

  async connect(): Promise<void> {
    if (this.socket) throw new Error("Model session already created.")
    const base = this.config.wsBase ?? "wss://api.openai.com"
    const socket = (this.socket = new WebSocket(`${base}/v1/realtime?model=${encodeURIComponent(this.config.model)}`, {
      headers: { Authorization: `Bearer ${this.config.key}` },
      maxPayload: 4 * 1024 * 1024,
      handshakeTimeout: 12_000,
    }))
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) {
          socket.terminate()
          reject(error)
        } else {
          this.ready = true
          resolve()
        }
      }
      const timer = setTimeout(() => finish(new Error("OpenAI session startup timed out. Check model access and network.")), 15_000)
      socket.on("open", () => {
        this.send({
          type: "session.update",
          session: {
            type: "realtime",
            model: this.config.model,
            output_modalities: ["audio"],
            instructions: this.instructions(),
            tools: TOOLS,
            tool_choice: "auto",
            // OpenAI's voice prompting guide: "Start with `low` for most production voice agents".
            reasoning: { effort: "low" },
            audio: { input: this.inputAudio(FIRST_TURN_SILENCE_MS), output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" } },
          },
        })
      })
      socket.on("message", (data) => {
        try {
          const event = JSON.parse(data.toString())
          if (event.type === "session.updated") finish()
          if (event.type === "error" && !settled) finish(new Error(`OpenAI: ${event.error?.message ?? "Session rejected."}`))
          this.handle(event)
        } catch (error) {
          this.emit({ type: "error", message: `Invalid model event: ${(error as Error).message}` })
        }
      })
      socket.on("error", (error) => {
        finish(new Error(`OpenAI connection: ${error.message}`))
        if (this.ready && !this.ending) this.emit({ type: "error", message: error.message })
      })
      socket.on("unexpected-response", (_req, response) => {
        response.resume()
        finish(new Error(`OpenAI connection refused (${response.statusCode}). Check the key and the voice model's access.`))
      })
      socket.on("close", () => {
        finish(new Error("OpenAI disconnected before becoming ready."))
        this.ready = false
        if (!this.ending) this.emit({ type: "closed" })
      })
    })
  }

  private send(event: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event))
  }

  audio(bytes: Buffer): void {
    if (!this.connected || !this.pickedUp) return
    if ((this.socket?.bufferedAmount ?? 0) > 128 * 1024) {
      this.emit({ type: "error", message: "OpenAI audio transport is congested; ending instead of building latency." })
      void this.close()
      return
    }
    const chunk = Buffer.concat([this.pendingByte, bytes])
    const count = chunk.length - (chunk.length % 2)
    this.pendingByte = chunk.subarray(count)
    if (count) this.send({ type: "input_audio_buffer.append", audio: chunk.subarray(0, count).toString("base64") })
  }

  /** The call connected: start the silence clock and the opening line. */
  answered(): void {
    if (!this.connected || this.pickedUp) return
    this.pickedUp = true
    this.lastActivity = Date.now()
    const limit = this.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastActivity < limit) return
      clearInterval(this.idleTimer)
      this.emit({ type: "end-call", reason: "silence" })
    }, Math.min(5_000, limit))
    // A caller expects to be greeted at once. Someone we called says "Hello?" first, and the agent answers that.
    if (this.config.mode === "inbound") this.open()
    else this.openingTimer = setTimeout(() => this.open(), this.config.openingWaitMs ?? DEFAULT_OPENING_WAIT_MS)
  }

  private open(): void {
    if (!this.connected) return
    const who = this.config.mode === "inbound" ? "The call has connected." : "The person you called has answered."
    this.send({ type: "response.create", response: { instructions: `${who} Say: ${this.config.opener} Then pause and listen. Do not repeat the opening line.` } })
  }

  reportPlayback(itemId: string, milliseconds: number): void {
    if (typeof itemId !== "string" || !Number.isFinite(milliseconds) || milliseconds < 0) return
    this.playback.set(itemId, milliseconds)
    // Realtime audio arrives several times faster than it plays, so the agent is "speaking" until playback catches up.
    this.lastActivity = Date.now()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenAI server events are a large union; each case reads only what it uses.
  private handle(event: any): void {
    if (this.ending) return
    switch (event.type) {
      case "response.output_audio.delta": {
        if (typeof event.delta !== "string") return
        if (event.item_id) {
          this.activeItem = event.item_id
          this.emit({ type: "audio-meta", itemId: event.item_id })
        }
        this.emit(Buffer.from(event.delta, "base64"))
        break
      }
      case "response.output_audio_transcript.delta":
        this.transcript("agent", event.delta)
        break
      case "conversation.item.input_audio_transcription.delta": {
        if (typeof event.delta !== "string") break
        if (typeof event.item_id === "string") {
          const key = `${event.item_id}:${event.content_index ?? 0}`
          this.inputTranscripts.set(key, (this.inputTranscripts.get(key) ?? "") + event.delta)
          if (this.inputTranscripts.size > 100) this.inputTranscripts.delete(this.inputTranscripts.keys().next().value!)
        }
        this.transcript("contact", event.delta)
        break
      }
      case "conversation.item.input_audio_transcription.completed": {
        const key = `${event.item_id}:${event.content_index ?? 0}`
        const streamed = this.inputTranscripts.get(key)
        if (streamed === undefined) this.transcript("contact", event.transcript)
        else if (typeof event.transcript === "string" && event.transcript.startsWith(streamed)) this.transcript("contact", event.transcript.slice(streamed.length))
        this.inputTranscripts.delete(key)
        break
      }
      case "input_audio_buffer.speech_started":
        clearTimeout(this.openingTimer)
        this.emit({ type: "clear" })
        if (this.activeItem) {
          this.send({ type: "conversation.item.truncate", item_id: this.activeItem, content_index: 0, audio_end_ms: Math.floor(this.playback.get(this.activeItem) ?? 0) })
        }
        this.activeItem = undefined
        break
      case "response.output_item.done":
        // Also emitted for items of an interrupted or cancelled response; a cut-off end_call must not hang up.
        if (event.item?.type === "function_call" && event.item.status === "completed") this.toolCalls.push(this.callTool(event.item))
        break
      case "response.done": {
        if (!this.firstReplyDone && this.pickedUp && event.response?.status !== "cancelled") {
          this.firstReplyDone = true
          this.send({ type: "session.update", session: { type: "realtime", audio: { input: this.inputAudio(TURN_SILENCE_MS) } } })
        }
        // The prompted goodbye finished: hang up, unless the contact cut in, which cancels it.
        if (this.hangUpAfterResponse) {
          this.hangUpAfterResponse = false
          if (event.response?.status !== "cancelled") this.emit({ type: "end-call", reason: "agent" })
          break
        }
        // A response.create sent while a response is active is rejected, so tool follow-ups wait for response.done.
        const calls = this.toolCalls.splice(0)
        if (calls.length) {
          void Promise.all(calls).then((outcomes) => {
            if (this.ending) return
            this.hangUpAfterResponse = outcomes.includes("end")
            this.send({ type: "response.create", ...(this.hangUpAfterResponse ? { response: { instructions: GOODBYE, tool_choice: "none" } } : {}) })
          })
        }
        break
      }
      case "error": {
        const message = event.error?.message ?? "OpenAI session error."
        this.emit({ type: isFatal(event.error) ? "error" : "notice", message: `OpenAI: ${message}` })
        break
      }
    }
  }

  private transcript(speaker: "contact" | "agent", value: unknown): void {
    if (typeof value !== "string" || !value) return
    if (speaker === "contact") clearTimeout(this.openingTimer)
    this.emit({ type: "transcript", speaker, text: value })
  }

  private async callTool(item: { name?: string; call_id?: string; arguments?: string }): Promise<"continue" | "end"> {
    if (item.name === "end_call") {
      this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: item.call_id, output: JSON.stringify({ ending: true }) } })
      return "end"
    }
    let output: object
    try {
      if (item.name !== "record_outcome") throw new Error(`Unknown tool ${item.name}.`)
      const args = JSON.parse(item.arguments || "{}")
      const outcome = VOICE_OUTCOMES.find((value) => value === args.outcome)
      if (!outcome) throw new Error(`The outcome must be one of: ${VOICE_OUTCOMES.join(", ")}.`)
      const summary = text(args.summary, 2000)
      if (!summary) throw new Error("A summary is required.")
      await this.config.saveOutcome({ outcome, summary, callbackTime: text(args.callback_time, 200) })
      output = { saved: true }
    } catch (error) {
      this.emit({ type: "notice", message: `Tool ${item.name} failed: ${(error as Error).message}` })
      output = { saved: false, error: (error as Error).message }
    }
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: item.call_id, output: JSON.stringify(output) } })
    return "continue"
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.ending = true
    this.ready = false
    clearInterval(this.idleTimer)
    clearTimeout(this.openingTimer)
    const socket = this.socket
    if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve()
    this.closing = new Promise((resolve) => {
      const timer = setTimeout(() => {
        socket.terminate()
        resolve()
      }, 4000)
      socket.once("close", () => {
        clearTimeout(timer)
        resolve()
      })
      if (socket.readyState === WebSocket.OPEN) socket.close()
      else socket.terminate()
    })
    return this.closing
  }
}

/** Opens a real session with the selected model, then closes it. Start stops here if the project can't use the model. */
export async function preflightVoice(key: string, model: string, wsBase?: string): Promise<void> {
  const agent = new VoiceAgent({ key, model, wsBase, instructions: "Preflight.", mode: "inbound", opener: "Hello.", saveOutcome: async () => {} }, () => {})
  try {
    await agent.connect()
  } finally {
    await agent.close()
  }
}
