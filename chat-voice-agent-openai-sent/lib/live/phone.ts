import { SentVoice } from "@sentdm/voice"
import type { CallItem, Conversation, PhoneCommand, Snapshot } from "@/lib/types"
import { AudioEngine, PLAYBACK_LIMIT_MS } from "./audio"

type Post = <T = unknown>(path: string, body?: object) => Promise<T>
type Notify = (level: "info" | "error", message: string) => void

const HEARTBEAT_MS = 2_000
// A Web Worker keeps time while the tab is in the background, where timers on the page are throttled.
const TICKER_SOURCE = `setInterval(() => postMessage(0), ${HEARTBEAT_MS})`

/** The WebSocket that carries one agent call's audio between this tab and the server's model session. */
class Bridge {
  private socket: WebSocket
  private ready: Promise<void>
  private itemId?: string
  private rendered = new Map<string, number>()
  private closed = false
  private intentional = false

  constructor(
    csrf: string,
    callId: string,
    private handlers: {
      onAudio: (audio: ArrayBuffer, itemId?: string) => void
      onClear: () => void
      onEndCall: () => void
      onHandover: () => void
      onError: (message: string) => void
      onClosed: (intentional: boolean) => void
    },
  ) {
    this.socket = new WebSocket(`ws://${location.host}/bridge?token=${encodeURIComponent(csrf)}&callId=${encodeURIComponent(callId)}`)
    this.socket.binaryType = "arraybuffer"
    this.ready = new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("The agent's voice session did not start in time.")), 20_000)
      this.socket.onopen = () => this.send({ type: "start" })
      this.socket.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) return this.handlers.onAudio(event.data, this.itemId)
        let message: { type?: string; itemId?: string; message?: string }
        try {
          message = JSON.parse(String(event.data))
        } catch {
          return
        }
        if (message.type === "ready") {
          window.clearTimeout(timer)
          resolve()
        } else if (message.type === "audio-meta") this.itemId = message.itemId
        else if (message.type === "clear") this.handlers.onClear()
        else if (message.type === "end-call") this.handlers.onEndCall()
        else if (message.type === "handover") this.handlers.onHandover()
        else if (message.type === "error") {
          window.clearTimeout(timer)
          reject(new Error(message.message ?? "The agent's voice session failed."))
          this.handlers.onError(message.message ?? "The agent's voice session failed.")
        } else if (message.type === "closed") this.close(false)
      }
      this.socket.onclose = () => {
        window.clearTimeout(timer)
        reject(new Error("The agent's voice session closed."))
        if (this.closed) return
        this.closed = true
        this.handlers.onClosed(this.intentional)
      }
    })
    this.ready.catch(() => {})
  }

  waitForReady() {
    return this.ready
  }

  private send(message: object) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  sendAudio(frame: ArrayBuffer) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(frame)
  }

  reportRendered(itemId: string, ms: number) {
    const total = (this.rendered.get(itemId) ?? 0) + ms
    this.rendered.set(itemId, total)
    this.send({ type: "playback", itemId, audioMs: total })
  }

  answered() {
    this.send({ type: "answered" })
  }

  close(intentional = true) {
    this.intentional ||= intentional
    if (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN) this.socket.close()
  }
}

/** The call this tab is on. The tab is one phone line, so there is at most one. */
type Line = {
  callId: string
  by: "agent" | "human"
  invite?: SentVoice.CallInvite
  call?: SentVoice.Call
  bridge?: Bridge
  connected: boolean
}

/**
 * Makes this browser tab the phone: it registers with Sent as an app user,
 * places and answers calls, and streams agent calls to the server.
 */
export class PhoneEngine {
  private audio?: AudioEngine
  private voice?: SentVoice
  private registered = false
  private ticker?: Worker
  private line?: Line
  private invites = new Map<string, SentVoice.CallInvite>()
  private autoAnswer = new Map<string, number>()
  private remoteWatch?: number

  constructor(
    private deps: {
      clientId: string
      csrf: string
      post: Post
      snapshot: () => Snapshot | null
      remoteAudio: () => HTMLAudioElement | null
      notify: Notify
    },
  ) {}

  get running() {
    return !!this.voice
  }

  /** Must be called from a click: browsers start audio and ask for notifications only during a user action. */
  async start(): Promise<void> {
    const audio = (this.audio = new AudioEngine())
    audio.onCapture = (frame) => this.line?.bridge?.sendAudio(frame)
    audio.onRendered = (itemId, ms) => this.line?.bridge?.reportRendered(itemId, ms)
    audio.onOverflow = (message) => {
      this.deps.notify("error", `${message} Ending the call so no speech is lost.`)
      void this.line?.call?.disconnect()
    }
    const audioReady = audio.init()
    const permission = "Notification" in window ? Notification.requestPermission() : Promise.resolve("denied" as NotificationPermission)
    try {
      const [, allowed] = await Promise.all([audioReady, permission])
      if (allowed !== "granted") throw new Error("Allow notifications for this page. Sent uses them to ring this tab when someone calls.")
      await this.deps.post("/api/start/prepare", { clientId: this.deps.clientId })
      this.voice = this.createVoice()
      await this.voice.register()
      if (!this.registered) throw new Error("This tab could not register with Sent.")
      await this.startHeartbeat()
      await this.deps.post("/api/start/activate", { clientId: this.deps.clientId })
    } catch (error) {
      await this.teardown()
      throw error
    }
  }

  async stop(): Promise<void> {
    try {
      await this.deps.post("/api/stop")
    } finally {
      await this.teardown()
    }
  }

  private createVoice(): SentVoice {
    const log = (level: string) => (message: string) => console.warn(`Sent voice SDK ${level}: ${message}`)
    const voice = new SentVoice({
      tokenProvider: async () => (await this.deps.post<{ token: string }>("/api/voice-token", { clientId: this.deps.clientId })).token,
      logLevel: "warn",
      logger: { error: log("error"), warn: log("warn"), info: () => {}, debug: () => {} },
      serviceWorker: { url: "/sw.js", scope: "/" },
      audio: { element: this.deps.remoteAudio() ?? undefined },
    })
    voice.on("registered", () => {
      this.registered = true
      void this.beat()
    })
    voice.on("offline", (reason) => {
      // The SDK retries about every 30 s; a call in progress continues.
      this.registered = false
      void this.beat()
      this.deps.notify("error", `${reason.message} Retrying. Calls can't connect until this tab is back online.`)
    })
    voice.on("error", (error) => this.deps.notify("error", error.message))
    voice.on("incomingCall", (invite) => void this.onIncoming(invite))
    return voice
  }

  private async startHeartbeat() {
    this.ticker?.terminate()
    this.ticker = new Worker(URL.createObjectURL(new Blob([TICKER_SOURCE], { type: "text/javascript" })))
    this.ticker.onmessage = () => void this.beat()
    await this.beat()
  }

  private beat() {
    return this.deps.post("/api/heartbeat", { clientId: this.deps.clientId, registered: this.registered }).catch(() => {})
  }

  private async teardown() {
    this.ticker?.terminate()
    this.ticker = undefined
    for (const timer of this.autoAnswer.values()) window.clearTimeout(timer)
    this.autoAnswer.clear()
    for (const invite of this.invites.values()) void invite.reject().catch(() => {})
    this.invites.clear()
    if (this.line) {
      await this.line.call?.disconnect().catch(() => {})
      this.endLine(this.line)
    }
    const voice = this.voice
    this.voice = undefined
    this.registered = false
    await voice?.destroy().catch(() => {})
    const audio = this.audio
    this.audio = undefined
    await audio?.shutdown().catch(() => {})
  }

  // -------------------------------------------------------------------------
  // Commands from the server

  handle(command: PhoneCommand) {
    switch (command.type) {
      case "dial":
        return void this.dial(command)
      case "answer":
        return void this.answer(command.callId, command.by)
      case "decline":
        return void this.decline(command.callId)
      case "hang-up":
        return void this.hangUp(command.callId)
      case "listen":
        if (this.line?.callId === command.callId) this.setHearing(command.on)
        return
      case "take-over":
        return
    }
  }

  private report(callId: string, state: string, sentCallId?: string, reason?: string) {
    return this.deps.post(`/api/calls/${callId}/state`, { state, sentCallId, reason }).catch(() => {})
  }

  private async dial(command: Extract<PhoneCommand, { type: "dial" }>) {
    if (!this.voice || !this.audio) return void this.report(command.callId, "failed")
    if (this.line) return void this.report(command.callId, "failed")
    const line: Line = (this.line = { callId: command.callId, by: command.by, connected: false })
    try {
      if (command.by === "agent") {
        line.bridge = this.openBridge(line)
        // The model session opens first, so the agent is ready the moment the contact picks up.
        await line.bridge.waitForReady()
      } else await this.audio.attachMicrophone()
      if (this.line !== line) return
      this.bindCall(line, await this.voice.connect({ to: command.to }))
    } catch (error) {
      this.deps.notify("error", `The call could not be placed: ${(error as Error).message}`)
      void this.report(line.callId, "failed")
      this.endLine(line)
    }
  }

  private findRinging(phone: string | undefined): { conversation: Conversation; call: CallItem } | undefined {
    const snapshot = this.deps.snapshot()
    if (!snapshot || !phone) return undefined
    for (const conversation of snapshot.conversations) {
      if (conversation.contact.phone !== phone) continue
      const call = conversation.items.findLast((i): i is CallItem => i.kind === "call" && i.direction === "inbound" && i.state === "ringing")
      if (call) return { conversation, call }
    }
    return undefined
  }

  private async onIncoming(invite: SentVoice.CallInvite) {
    const from = invite.from.kind === "number" ? invite.from.number : undefined
    // The server records the call before Sent rings this tab, but its update can arrive a moment later.
    let found = this.findRinging(from)
    for (let i = 0; !found && i < 12; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      found = this.findRinging(from)
    }
    if (!found || this.line || this.invites.has(found.call.id)) {
      await invite.reject().catch(() => {})
      return
    }
    const { call } = found
    this.invites.set(call.id, invite)
    invite.on("cancelled", () => {
      this.clearInvite(call.id)
      void this.report(call.id, "missed")
    })
    const inbound = this.deps.snapshot()?.settings.inbound
    if (call.agentAnswersAt !== undefined && inbound !== "team_only") {
      const delay = Math.max(0, call.agentAnswersAt - Date.now())
      this.autoAnswer.set(call.id, window.setTimeout(() => void this.answer(call.id, "agent"), delay))
    }
  }

  private clearInvite(callId: string) {
    window.clearTimeout(this.autoAnswer.get(callId))
    this.autoAnswer.delete(callId)
    this.invites.delete(callId)
  }

  private async answer(callId: string, by: "agent" | "human") {
    const invite = this.invites.get(callId)
    if (!invite || invite.state !== "pending" || !this.audio) return
    this.clearInvite(callId)
    if (this.line) {
      await invite.reject().catch(() => {})
      return
    }
    const line: Line = (this.line = { callId, by, invite, connected: false })
    try {
      if (by === "agent") {
        line.bridge = this.openBridge(line)
        await line.bridge.waitForReady()
      } else await this.audio.attachMicrophone()
      if (this.line !== line || invite.state !== "pending") return void this.endLine(line)
      this.bindCall(line, await invite.accept())
    } catch (error) {
      this.deps.notify("error", `The call could not be answered: ${(error as Error).message}`)
      if (invite.state === "pending") await invite.reject().catch(() => {})
      void this.report(callId, "missed")
      this.endLine(line)
    }
  }

  private async decline(callId: string) {
    const invite = this.invites.get(callId)
    this.clearInvite(callId)
    if (invite?.state === "pending") await invite.reject().catch(() => {})
    void this.report(callId, "declined")
  }

  private async hangUp(callId: string) {
    if (this.invites.has(callId)) return this.decline(callId)
    const line = this.line
    if (line?.callId !== callId) return void this.report(callId, "ended")
    if (line.call) await line.call.disconnect().catch(() => {})
    else {
      void this.report(callId, "ended")
      this.endLine(line)
    }
  }

  // -------------------------------------------------------------------------
  // The live call

  private openBridge(line: Line) {
    return new Bridge(this.deps.csrf, line.callId, {
      onAudio: (pcm, itemId) => this.audio?.enqueueAudio(pcm, itemId),
      onClear: () => this.audio?.clearAudio(),
      onEndCall: () => this.endAfterPlayback(line),
      onHandover: () => void this.takeOver(line),
      onError: (message) => {
        this.deps.notify("error", message)
        if (line.call) void line.call.disconnect()
      },
      onClosed: (intentional) => {
        // The model session is gone. Unless a person took over, the call can't continue.
        if (!intentional && line.by === "agent" && line.call && this.line === line) void line.call.disconnect()
      },
    })
  }

  private bindCall(line: Line, call: SentVoice.Call) {
    line.call = call
    call.on("connected", () => this.onConnected(line))
    call.on("disconnected", (info) => this.onDisconnected(line, info))
    call.on("error", (error) => this.deps.notify("error", error.message))
    if (call.state === "connected") this.onConnected(line)
  }

  private onConnected(line: Line) {
    if (line.connected || this.line !== line || !line.call) return
    // The SDK must use the software microphone. If it reached the real microphone some other way,
    // room audio could go to the contact, so end the call instead.
    if (!this.audio?.softwareMicrophoneUsed) {
      this.deps.notify("error", "The Sent SDK did not take the app's audio stream. Ending the call; check the @sentdm/voice version.")
      void line.call.disconnect()
      return
    }
    line.connected = true
    this.watchRemoteAudio()
    if (line.by === "agent") {
      // Only now: before the answer the line carries ringback and carrier messages, which the model must not hear.
      this.audio.setCapturing(true)
      line.bridge?.answered()
    } else this.setHearing(true)
    void this.report(line.callId, "live", line.call.id)
  }

  private onDisconnected(line: Line, info: SentVoice.DisconnectInfo) {
    if (this.line !== line) return
    // The SDK says how the call ended; the error says why it failed, in Sent's words.
    const reason = info.error ? `${info.state}: ${info.error.code} ${info.error.message}` : info.state
    void this.report(line.callId, line.connected ? "ended" : line.invite ? "missed" : "ended", line.call?.id, reason)
    this.endLine(line)
  }

  /** The agent said goodbye: hang up once its last words have played. */
  private endAfterPlayback(line: Line) {
    this.audio?.setCapturing(false)
    const finish = () => {
      window.clearTimeout(fallback)
      if (this.line === line) void line.call?.disconnect()
    }
    const fallback = window.setTimeout(finish, PLAYBACK_LIMIT_MS + 1_000)
    if (this.audio) this.audio.whenDrained(finish)
    else finish()
  }

  /** A person takes the call: the microphone joins, and the agent's audio stops. The call stays up. */
  private async takeOver(line: Line) {
    if (this.line !== line || !this.audio) return
    line.by = "human"
    this.audio.setCapturing(false)
    this.audio.clearAudio()
    line.bridge?.close(true)
    line.bridge = undefined
    try {
      await this.audio.attachMicrophone()
      this.setHearing(true)
    } catch (error) {
      this.deps.notify("error", `The microphone could not start: ${(error as Error).message}. Ending the call.`)
      void line.call?.disconnect()
    }
  }

  setMuted(muted: boolean) {
    this.audio?.setMicrophoneMuted(muted)
  }

  /** Plays the contact's audio in this tab: always for a person on the call, on request while the agent talks. */
  private setHearing(on: boolean) {
    const element = this.deps.remoteAudio()
    if (!element) return
    element.muted = !on
    element.volume = on ? 1 : 0
    if (on) void element.play().catch(() => {})
  }

  private watchRemoteAudio() {
    window.clearInterval(this.remoteWatch)
    const element = this.deps.remoteAudio()
    const attach = () => {
      const stream = element?.srcObject
      return stream instanceof MediaStream && !!this.audio?.attachRemoteStream(stream)
    }
    if (attach()) return
    let checks = 0
    this.remoteWatch = window.setInterval(() => {
      if (attach() || ++checks >= 40) window.clearInterval(this.remoteWatch)
    }, 250)
  }

  private endLine(line: Line) {
    if (this.line === line) this.line = undefined
    line.bridge?.close(true)
    window.clearInterval(this.remoteWatch)
    this.audio?.setCapturing(false)
    this.audio?.clearAudio()
    this.audio?.detachRemoteStream()
    this.audio?.detachMicrophone()
    this.setHearing(false)
  }
}
