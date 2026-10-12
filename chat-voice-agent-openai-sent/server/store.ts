import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { AgentSettings, CallItem, Channel, Conversation, EventItem, MessageItem, ThreadItem, ToolCall } from "@/lib/types"

export const newId = (prefix: string) => `${prefix}_${randomUUID()}`

export const DEFAULT_SETTINGS: AgentSettings = {
  businessName: "",
  number: "",
  textModel: "gpt-6-luna",
  voiceModel: "gpt-realtime-2.1",
  instructions:
    "Help customers with questions about the business, their orders, and deliveries. Keep replies short and friendly, like a helpful person texting. You can't see accounts, orders, or payments, so don't make up details or promise actions you can't take. Offer a call when a question is easier to talk through, and bring in a team member when someone needs a decision you can't make.",
  callPolicy: "auto",
  callingHours: { start: "09:00", end: "20:00" },
  inbound: "team_first",
  teamRingSeconds: 10,
  handover: { onRequest: true, onFrustration: true, refundLimit: 20 },
  onlyNumbers: [],
}

/** Private JSON files in .sent-agent: owner-only, written atomically. */
export class JsonFiles {
  constructor(readonly dir: string) {}

  async read<T>(name: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path.join(this.dir, name), "utf8")) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  }

  async write(name: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const file = path.join(this.dir, name)
    await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
    await rename(`${file}.tmp`, file)
  }

  async remove(name: string): Promise<void> {
    await unlink(path.join(this.dir, name)).catch((error) => {
      if (error.code !== "ENOENT") throw error
    })
  }
}

/**
 * Conversations and settings. Every change goes through `changed()`, which
 * tells the UI and saves to disk shortly after.
 */
export class Store {
  conversations: Conversation[] = []
  settings: AgentSettings = DEFAULT_SETTINGS
  private saveTimer?: NodeJS.Timeout
  private saving: Promise<void> = Promise.resolve()

  constructor(
    private files: JsonFiles,
    private onChange: () => void,
  ) {}

  async load(): Promise<void> {
    const saved = await this.files.read<AgentSettings>("settings.json")
    this.settings = { ...DEFAULT_SETTINGS, ...saved, handover: { ...DEFAULT_SETTINGS.handover, ...saved?.handover } }
    this.conversations = (await this.files.read<Conversation[]>("conversations.json")) ?? []
    // A call can't survive a restart: the browser tab and the model session are gone.
    const now = Date.now()
    for (const c of this.conversations) {
      // Files saved before the rename call the contact's last channel "replyChannel".
      const legacy = c as Conversation & { replyChannel?: Channel }
      c.lastChannel ??= legacy.replyChannel ?? "sms"
      delete legacy.replyChannel
      c.agentTyping = false
      for (const item of c.items) {
        if (item.kind === "call" && (item.state === "ringing" || item.state === "live")) {
          item.state = item.state === "live" ? "ended" : "missed"
          item.endedAt = now
          item.summary ??= "The app stopped during this call."
        }
      }
    }
  }

  changed(): void {
    this.onChange()
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.flush(), 400)
  }

  async flush(): Promise<void> {
    clearTimeout(this.saveTimer)
    this.saving = this.saving.then(() => this.files.write("conversations.json", this.conversations)).catch((error) => {
      console.error(`Could not save conversations: ${(error as Error).message}`)
    })
    await this.saving
  }

  async saveSettings(settings: AgentSettings): Promise<void> {
    this.settings = settings
    await this.files.write("settings.json", settings)
    this.onChange()
  }

  find(id: string) {
    return this.conversations.find((c) => c.id === id)
  }

  get(id: string) {
    const conversation = this.find(id)
    if (!conversation) throw new Error("That conversation no longer exists.")
    return conversation
  }

  /** The conversation for a phone number, created on first contact. One contact, one conversation. */
  forPhone(phone: string, channel?: Channel): Conversation {
    let conversation = this.conversations.find((c) => c.contact.phone === phone)
    if (!conversation) {
      conversation = {
        id: newId("conv"),
        contact: { id: newId("contact"), phone, channels: [], callConsent: { granted: false }, tags: [] },
        owner: "agent",
        status: "open",
        lastChannel: channel ?? "sms",
        unread: 0,
        items: [],
        toolLog: [],
      }
      this.conversations.unshift(conversation)
    }
    if (channel && !conversation.contact.channels.includes(channel)) conversation.contact.channels.push(channel)
    return conversation
  }

  findMessage(sentId: string): { conversation: Conversation; message: MessageItem } | undefined {
    for (const conversation of this.conversations) {
      const message = conversation.items.find((i): i is MessageItem => i.kind === "message" && i.sentId === sentId)
      if (message) return { conversation, message }
    }
    return undefined
  }

  findCall(callId: string): { conversation: Conversation; call: CallItem } | undefined {
    for (const conversation of this.conversations) {
      const call = conversation.items.find((i): i is CallItem => i.kind === "call" && i.id === callId)
      if (call) return { conversation, call }
    }
    return undefined
  }

  /** The ringing or live call, if any. The browser tab is one phone line, so there is at most one. */
  activeCall(): { conversation: Conversation; call: CallItem } | undefined {
    for (const conversation of this.conversations) {
      const call = conversation.items.find((i): i is CallItem => i.kind === "call" && (i.state === "ringing" || i.state === "live"))
      if (call) return { conversation, call }
    }
    return undefined
  }

  push(conversation: Conversation, item: ThreadItem): void {
    conversation.items.push(item)
  }

  event(conversation: Conversation, icon: EventItem["icon"], text: string): void {
    conversation.items.push({ kind: "event", id: newId("evt"), at: Date.now(), icon, text })
  }

  log(conversation: Conversation, name: ToolCall["name"], detail: string): void {
    conversation.toolLog.push({ id: newId("tool"), at: Date.now(), name, detail })
    if (conversation.toolLog.length > 200) conversation.toolLog.shift()
  }
}
