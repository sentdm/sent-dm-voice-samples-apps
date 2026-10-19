import { randomBytes } from "node:crypto"
import { WebSocket } from "ws"
import type { AgentSettings, CallPolicy, CampaignSummary, InboundMode, Phase, PhoneCommand, ServerMessage, Snapshot, SystemStatus, TemplateSummary } from "@/lib/types"
import { JsonFiles, Store } from "./store"
import { toE164 } from "@/lib/phone"
import { createSentApi, sentErrorMessage, type SentApi } from "./sent"
import { checkOpenAIKey } from "./text-agent"
import { preflightVoice } from "./voice-agent"
import { TEXT_MODELS, VOICE_MODELS, isTextModel, isVoiceModel } from "@/lib/models"
import { openTunnel, tunnelConfigFromEnv, type TunnelConfig, type TunnelHandle } from "./tunnel"

export type RuntimeOptions = {
  dataDir: string
  sentBase?: string
  openaiHttpBase?: string
  openaiWsBase?: string
  tunnelFactory?: typeof openTunnel
  /** Which public tunnel Start opens. Defaults to the environment (TUNNEL_PROVIDER, NGROK_AUTHTOKEN, NGROK_DOMAIN). */
  tunnel?: TunnelConfig
}

/**
 * What Start changed in Sent, saved before each change, so Stop (or the next
 * run after a crash) can put it back.
 */
type Backup = {
  number: string
  previousUrl: string | null
  installedUrl: string
  callbackSecret?: string
  webhookId?: string
  webhookSecret?: string
  createdAt: string
}

/** The phone tab is alive while its last heartbeat is newer than this. It beats every 2 s. */
const HEARTBEAT_ALIVE_MS = 7_000

export class Runtime {
  readonly csrf = randomBytes(32).toString("hex")
  /** The phone tab registers with Sent as this app user. */
  readonly identity = `sent-chat-${randomBytes(6).toString("hex")}`
  readonly files: JsonFiles
  readonly store: Store
  sent?: SentApi
  openaiKey = ""
  keySource: SystemStatus["keySource"] = null
  numbers: string[] = []
  phase: Phase = "offline"
  step?: string
  error?: string
  warning?: string
  /** Approved Sent templates, for messages when free text isn't allowed. */
  templates: TemplateSummary[] = []
  backup: Backup | null = null
  tunnel?: TunnelHandle
  voicePath = ""
  hookPath = ""
  phone?: { id: string; heartbeat: number; registered: boolean }
  /** Ends the active call and clears per-call state. Set by the call module. */
  onStop: () => Promise<void> = async () => {}
  /** Runs once the keys work, for example to import the message history. */
  onConnected: () => void = () => {}
  /** The campaign behind a conversation, for the agents' prompts. Set by the campaign module. */
  campaignFor: (id?: string) => { name: string; scenario: string } | undefined = () => undefined
  campaignSummaries: () => CampaignSummary[] = () => []
  private sockets = new Map<WebSocket, string>()
  private broadcastTimer?: NodeJS.Timeout
  private mutating = false
  private stopping?: Promise<void>
  private watchdog: NodeJS.Timeout
  private tunnelConfig: TunnelConfig

  constructor(readonly options: RuntimeOptions) {
    this.tunnelConfig = options.tunnel ?? tunnelConfigFromEnv()
    this.files = new JsonFiles(options.dataDir)
    this.store = new Store(this.files, () => this.broadcastSoon())
    this.watchdog = setInterval(() => {
      const running = this.phase === "ready" || (this.phase === "starting" && this.phone && this.phone.heartbeat > 0)
      if (running && !this.phoneAlive()) {
        this.warning = "The phone tab stopped responding, so the agent stopped and your number's routing was restored."
        void this.stop()
      }
    }, 2_000)
  }

  async init(): Promise<void> {
    await this.store.load()
    this.backup = await this.files.read<Backup>("backup.json")
  }

  get settings(): AgentSettings {
    return this.store.settings
  }

  phoneAlive() {
    return !!this.phone && Date.now() - this.phone.heartbeat < HEARTBEAT_ALIVE_MS
  }

  phoneOnline() {
    return this.phoneAlive() && !!this.phone?.registered
  }

  /** Texts and calls are handled only while Start has finished and the phone tab is online. */
  isReady() {
    return this.phase === "ready" && this.phoneOnline()
  }

  /** Whether the agent may act for this number. With "Only these numbers" set, everyone else is left alone. */
  agentServes(phone: string) {
    const only = this.settings.onlyNumbers
    return only.length === 0 || only.includes(phone)
  }

  requireSent(): SentApi {
    if (!this.sent || !this.openaiKey) throw new Error("Connect your Sent and OpenAI keys first.")
    return this.sent
  }

  // -------------------------------------------------------------------------
  // State for the browser

  system(): SystemStatus {
    return {
      configured: !!this.sent && !!this.openaiKey,
      keySource: this.keySource,
      numbers: this.numbers,
      phase: this.phase,
      step: this.step,
      error: this.error,
      warning: this.warning,
      phoneId: this.phone?.id,
      phoneOnline: this.phoneOnline(),
    }
  }

  snapshot(): Snapshot {
    return { conversations: this.store.conversations, settings: this.settings, system: this.system(), templates: this.templates, campaigns: this.campaignSummaries() }
  }

  addSocket(ws: WebSocket, clientId: string) {
    this.sockets.set(ws, clientId)
    this.send(ws, { type: "snapshot", snapshot: this.snapshot() })
  }

  removeSocket(ws: WebSocket) {
    this.sockets.delete(ws)
  }

  private send(ws: WebSocket, message: ServerMessage) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
  }

  /** Coalesces changes: transcript deltas arrive many times a second. */
  broadcastSoon() {
    if (this.broadcastTimer) return
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = undefined
      const message: ServerMessage = { type: "snapshot", snapshot: this.snapshot() }
      for (const ws of this.sockets.keys()) this.send(ws, message)
    }, 120)
  }

  notice(level: "info" | "error", message: string) {
    for (const ws of this.sockets.keys()) this.send(ws, { type: "notice", level, message })
  }

  /** Sends a command to the phone tab. Returns false when it is not connected. */
  phoneCommand(command: PhoneCommand): boolean {
    let sent = false
    for (const [ws, clientId] of this.sockets) {
      if (clientId === this.phone?.id && ws.readyState === WebSocket.OPEN) {
        this.send(ws, { type: "phone", command })
        sent = true
      }
    }
    return sent
  }

  /** A failed request. The tab that sent it shows the message; it doesn't change the status line. */
  recordErrorQuietly(error: unknown): string {
    return sentErrorMessage(error)
  }

  /** A failure nobody asked about directly, such as the tunnel dropping: the status line and a notice. */
  recordError(error: unknown): string {
    this.error = sentErrorMessage(error)
    this.notice("error", this.error)
    this.broadcastSoon()
    return this.error
  }

  // -------------------------------------------------------------------------
  // Keys and settings

  private requireStopped(message: string) {
    if (this.phase !== "offline" || this.mutating) throw new Error(message)
  }

  async connect(sentKey: unknown, openaiKey: unknown, source: "env" | "dashboard"): Promise<void> {
    this.requireStopped("Stop the agent before changing keys.")
    const valid = (key: unknown): key is string => typeof key === "string" && key.trim().length >= 12 && key.length <= 1024
    if (!valid(sentKey) || !valid(openaiKey)) {
      throw new Error(source === "env" ? "SENT_DM_API_KEY and OPENAI_API_KEY must each be 12–1024 characters." : "Enter valid Sent and OpenAI API keys.")
    }
    const candidate = createSentApi(sentKey.trim(), this.options.sentBase)
    const openai = openaiKey.trim()
    const keyCheck = checkOpenAIKey(openai, this.options.openaiHttpBase)
    keyCheck.catch(() => {})
    const found = await candidate.voiceNumbers()
    const active = found.filter((n) => n.status?.toUpperCase() === "ACTIVE" && n.number).map((n) => n.number!)
    // A number added without a callback URL is INACTIVE for that reason alone; setting one turns it on.
    const waiting = found.filter((n) => n.status?.toUpperCase() !== "ACTIVE" && !n.callback_url && n.number).map((n) => n.number!)
    if (!active.length && waiting.length) {
      throw new Error(`${waiting.join(", ")} ${waiting.length > 1 ? "are" : "is"} waiting for a first callback URL. Set any public HTTPS URL on it in Sent; this app swaps in its own while it runs and restores yours on Stop. Then connect again.`)
    }
    if (!active.length) throw new Error("No active voice numbers on this Sent key. Turn on voice for an existing number in Sent first. This app does not buy numbers.")
    await keyCheck
    this.sent = candidate
    this.openaiKey = openai
    this.keySource = source
    this.numbers = active
    this.error = undefined
    if (!active.includes(this.settings.number)) {
      const preferred = found.find((n) => n.default_for_app_calls && n.number && active.includes(n.number))?.number ?? active[0]
      await this.store.saveSettings({ ...this.settings, number: preferred })
    }
    if (this.backup) {
      this.warning = "A previous session left Sent changes behind. Restoring them before the next Start."
      await this.restoreBackup()
    }
    await this.loadTemplates()
    this.broadcastSoon()
    this.onConnected()
  }

  async loadTemplates() {
    try {
      this.templates = await this.requireSent().templates()
    } catch (error) {
      this.notice("error", `Couldn't load your Sent templates: ${sentErrorMessage(error)}`)
    }
    this.broadcastSoon()
  }

  async saveSettings(input: unknown): Promise<void> {
    const value = (input ?? {}) as Partial<AgentSettings>
    const current = this.settings
    const next: AgentSettings = { ...current, ...value, handover: { ...current.handover, ...value.handover }, callingHours: { ...current.callingHours, ...value.callingHours } }
    if (typeof next.businessName !== "string" || next.businessName.trim().length > 80) throw new Error("The business name can be at most 80 characters.")
    next.businessName = next.businessName.trim()
    if (next.number !== current.number) {
      this.requireStopped("Stop the agent before you change the number.")
      if (!this.numbers.includes(next.number)) throw new Error("Choose one of your active Sent voice numbers.")
    }
    if (!isTextModel(next.textModel)) throw new Error(`Choose a text model: ${TEXT_MODELS.map((m) => m.label).join(", ")}.`)
    if (!isVoiceModel(next.voiceModel)) throw new Error(`Choose a voice model: ${VOICE_MODELS.map((m) => m.label).join(", ")}.`)
    if (typeof next.instructions !== "string" || next.instructions.length > 5000) throw new Error("Instructions can be at most 5,000 characters.")
    if (!(["never", "ask", "auto"] satisfies CallPolicy[] as string[]).includes(next.callPolicy)) throw new Error("Choose a call policy.")
    if (!(["agent", "team_first", "team_only"] satisfies InboundMode[] as string[]).includes(next.inbound)) throw new Error("Choose who answers calls.")
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/
    if (!hhmm.test(next.callingHours.start) || !hhmm.test(next.callingHours.end) || next.callingHours.start >= next.callingHours.end) {
      throw new Error("Calling hours need a start time before the end time, for example 09:00 to 20:00.")
    }
    if (!Number.isInteger(next.teamRingSeconds) || next.teamRingSeconds < 5 || next.teamRingSeconds > 25) throw new Error("The team rings for 5–25 seconds.")
    if (!Number.isFinite(next.handover.refundLimit) || next.handover.refundLimit < 0 || next.handover.refundLimit > 100_000) throw new Error("Enter a refund limit from 0 to 100,000.")
    if (!Array.isArray(next.onlyNumbers) || next.onlyNumbers.length > 50) throw new Error("List at most 50 numbers.")
    const only = next.onlyNumbers.map((n) => toE164(n))
    const bad = next.onlyNumbers.find((_, i) => !only[i])
    if (bad !== undefined) throw new Error(`${bad} is not in international format, for example +14155551234.`)
    next.onlyNumbers = [...new Set(only as string[])]
    await this.store.saveSettings(next)
  }

  // -------------------------------------------------------------------------
  // Start and Stop. The order matters: the number changes only after every other part works.

  /** Step 1: check the voice model and open the public tunnel. The number's routing is unchanged. */
  async prepare(clientId: string): Promise<void> {
    this.requireSent()
    if (this.phase !== "offline" || this.mutating) throw new Error("The agent is already starting or running.")
    if (!this.settings.businessName) throw new Error("Enter your business name in Agent settings. The agent uses it in every greeting.")
    if (!this.numbers.includes(this.settings.number)) throw new Error("Choose a Sent voice number in Agent settings.")
    this.mutating = true
    this.phase = "starting"
    this.error = undefined
    this.warning = undefined
    this.phone = { id: clientId, heartbeat: 0, registered: false }
    try {
      if (this.backup) await this.restoreBackup()
      void this.loadTemplates()
      this.progress(`Checking access to ${this.settings.voiceModel}`)
      await preflightVoice(this.openaiKey, this.settings.voiceModel, this.options.openaiWsBase)
      this.progress("Opening the public tunnel")
      this.tunnel = await (this.options.tunnelFactory ?? openTunnel)(this.gatewayPort, (message) => {
        this.recordError(message)
        void this.stop()
      }, this.tunnelConfig)
      this.voicePath = `/voice/${randomBytes(24).toString("hex")}`
      this.hookPath = `/hooks/${randomBytes(24).toString("hex")}`
      this.progress("Registering this tab with Sent")
    } catch (error) {
      this.tunnel?.stop()
      this.tunnel = undefined
      this.phase = "offline"
      this.phone = undefined
      this.step = undefined
      this.error = sentErrorMessage(error)
      throw error
    } finally {
      this.mutating = false
      this.broadcastSoon()
    }
  }

  gatewayPort = 0

  private progress(step: string) {
    this.step = step
    this.broadcastSoon()
  }

  heartbeat(clientId: string, registered: boolean) {
    if (!this.phone || this.phone.id !== clientId) throw new Error("This tab is not the phone tab.")
    const changed = this.phone.registered !== registered || !this.phoneAlive()
    this.phone.heartbeat = Date.now()
    this.phone.registered = registered
    if (changed) this.broadcastSoon()
  }

  async voiceToken(clientId: string): Promise<string> {
    const sent = this.requireSent()
    if (!this.phone || this.phone.id !== clientId || (this.phase !== "starting" && this.phase !== "ready")) throw new Error("Start the agent in this tab first.")
    return sent.voiceToken(this.identity, this.settings.number)
  }

  /** Step 2, once the phone tab is registered: back up, route the number, subscribe to messages, test. */
  async activate(clientId: string): Promise<void> {
    const sent = this.requireSent()
    if (this.phase !== "starting" || !this.tunnel || !this.phone || this.phone.id !== clientId || this.mutating) throw new Error("Start the agent again.")
    if (!this.phoneOnline()) throw new Error("This tab must register with Sent before the number is routed to it.")
    this.mutating = true
    const number = this.settings.number
    try {
      this.progress("Saving your number's current routing")
      const previous = await sent.voiceNumber(number)
      if (previous.status?.toUpperCase() !== "ACTIVE") throw new Error(`${number} is no longer an active voice number.`)
      this.backup = { number, previousUrl: previous.callback_url ?? null, installedUrl: this.tunnel.url + this.voicePath, createdAt: new Date().toISOString() }
      await this.files.write("backup.json", this.backup)

      this.progress("Routing calls to this app")
      this.backup.callbackSecret = await sent.routeNumber(number, this.backup.installedUrl)
      await this.files.write("backup.json", this.backup)

      this.progress("Subscribing to messages")
      const webhook = await sent.createWebhook(this.tunnel.url + this.hookPath)
      this.backup.webhookId = webhook.id
      this.backup.webhookSecret = webhook.secret
      await this.files.write("backup.json", this.backup)

      this.progress("Testing the call path")
      this.phase = "ready"
      await sent.testCallback(number)

      if (!previous.callback_url) this.warning = "This number had no callback URL before. Sent can't clear it, so after Stop calls to it are rejected until you set one."
      this.step = undefined
    } catch (error) {
      this.phase = "starting"
      await this.restoreBackup().catch((recovery) => this.recordError(`Recovery: ${sentErrorMessage(recovery)}`))
      this.tunnel?.stop()
      this.tunnel = undefined
      this.phase = "offline"
      this.phone = undefined
      this.step = undefined
      this.error = sentErrorMessage(error)
      throw error
    } finally {
      this.mutating = false
      this.broadcastSoon()
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping
    if (this.phase === "offline") return
    this.phase = "stopping"
    this.broadcastSoon()
    this.stopping = (async () => {
      await this.onStop().catch(() => {})
      try {
        await this.restoreBackup()
      } catch (error) {
        this.recordError(`Restoring your Sent settings failed: ${sentErrorMessage(error)} The backup is kept; connect the same keys and Start or Stop again.`)
      }
      this.tunnel?.stop()
      this.tunnel = undefined
      this.phase = "offline"
      this.phone = undefined
      this.step = undefined
      this.broadcastSoon()
    })().finally(() => {
      this.stopping = undefined
    })
    return this.stopping
  }

  /** Puts back what Start changed: the number's callback URL and the webhook. */
  private async restoreBackup(): Promise<void> {
    const saved = this.backup
    if (!saved || !this.sent) return
    if (saved.webhookId) {
      await this.sent.deleteWebhook(saved.webhookId).catch((error) => {
        if (!sentErrorMessage(error).includes("404")) throw error
      })
      delete saved.webhookId
      delete saved.webhookSecret
      await this.files.write("backup.json", saved)
    }
    const current = await this.sent.voiceNumber(saved.number)
    if (current.callback_url === saved.installedUrl) {
      if (saved.previousUrl) await this.sent.restoreNumber(saved.number, saved.previousUrl)
    } else if (current.callback_url !== saved.previousUrl) {
      this.warning = "The number's callback URL was changed outside this app. It was not overwritten."
    }
    this.backup = null
    await this.files.remove("backup.json")
  }

  async close(): Promise<void> {
    clearInterval(this.watchdog)
    await this.stop()
    await this.store.flush()
  }
}
