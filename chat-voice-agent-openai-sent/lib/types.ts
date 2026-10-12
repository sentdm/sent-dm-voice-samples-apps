// Domain model for the console. The server stores these shapes and sends them
// to the UI as they are.

export type Channel = "sms" | "whatsapp" | "rcs"

/** Who replies in a conversation right now. */
export type Owner = "agent" | "human"

export type ConversationStatus = "open" | "needs_human" | "resolved"

export type Contact = {
  id: string
  name?: string
  phone: string
  channels: Channel[]
  /** IANA time zone. Unset until someone chooses it; your own zone is used meanwhile. */
  timeZone?: string
  city?: string
  /** No one calls the contact without consent: they asked for a call or agreed to one. */
  callConsent: { granted: boolean; source?: string }
  /** The contact texted STOP. Sent blocks further messages; the agent stops replying. */
  optedOut?: boolean
  tags: string[]
}

export type Speaker = "contact" | "agent" | "human"

export type TranscriptLine = {
  id: string
  speaker: Speaker
  text: string
  at: number
}

export type CallState = "ringing" | "live" | "ended" | "missed" | "declined"

export type CallOutcome =
  | "resolved"
  | "callback_requested"
  | "handed_over"
  | "voicemail"
  | "no_answer"
  | "not_interested"

export type CallItem = {
  kind: "call"
  id: string
  at: number
  direction: "inbound" | "outbound"
  state: CallState
  handledBy: "agent" | "human"
  answeredAt?: number
  endedAt?: number
  /** Why the call was placed, when the agent asked for it. */
  reason?: string
  outcome?: CallOutcome
  summary?: string
  transcript: TranscriptLine[]
  /** Inbound only: when the agent picks up if no one on the team answers. */
  agentAnswersAt?: number
  listening?: boolean
  /** Sent's call id, once the browser voice SDK reports it. */
  sentCallId?: string
}

export type MessageItem = {
  kind: "message"
  id: string
  at: number
  author: Speaker
  channel: Channel
  text: string
  /** Outbound only. "failed" covers Sent's FAILED, BLOCKED, and FILTERED. */
  status?: "sending" | "sent" | "delivered" | "read" | "failed"
  /** Why the message was not delivered, in Sent's words. */
  error?: string
  /** Sent's message id, used to match delivery webhooks. */
  sentId?: string
  /** Outbound only: Sent hasn't reported the channel it picked yet. `channel` is a guess until then. */
  routing?: boolean
  /** Imported from your Sent message history, sent before this app ran. */
  fromHistory?: boolean
  /** The Sent template the message was sent from, if any. */
  template?: string
}

export type EventItem = {
  kind: "event"
  id: string
  at: number
  icon: "handover" | "takeover" | "handback" | "resolved" | "reopened" | "consent" | "join" | "optout" | "info"
  text: string
}

export type ProposalItem = {
  kind: "proposal"
  id: string
  at: number
  action: "call" | "handover"
  reason: string
  signals: string[]
  status: "pending" | "approved" | "dismissed"
  resolution?: string
}

export type ThreadItem = MessageItem | CallItem | EventItem | ProposalItem

export type ToolCall = {
  id: string
  at: number
  name:
    | "send_message"
    | "propose_call"
    | "start_call"
    | "answer_call"
    | "request_handover"
    | "choose_channel"
    | "record_call_consent"
    | "record_outcome"
    | "end_call"
  detail: string
}

export type Conversation = {
  id: string
  contact: Contact
  owner: Owner
  status: ConversationStatus
  /** The channel the contact last wrote on. Sent's routing picks the channel for each reply. */
  lastChannel: Channel
  unread: number
  items: ThreadItem[]
  toolLog: ToolCall[]
  /** Copilot draft offered to a person who has taken over. */
  suggestion?: string
  /** The campaign that started this conversation. The agent follows its scenario. */
  campaignId?: string
  agentTyping?: boolean
}

export type CallPolicy = "never" | "ask" | "auto"

export type InboundMode = "agent" | "team_first" | "team_only"

export type AgentSettings = {
  /** Used in greetings, for example "Thanks for calling {businessName}." */
  businessName: string
  number: string
  textModel: string
  voiceModel: string
  instructions: string
  callPolicy: CallPolicy
  /** Contact's local time. The agent never calls outside these hours. */
  callingHours: { start: string; end: string }
  inbound: InboundMode
  teamRingSeconds: number
  handover: { onRequest: boolean; onFrustration: boolean; refundLimit: number }
  /** While set, the agent acts only for these numbers: a safe way to test on an account with real customers. */
  onlyNumbers: string[]
}

export type InboxFilter = "needs_you" | "open" | "resolved"

// ---------------------------------------------------------------------------
// What the server sends to the browser, and what it asks the phone tab to do.

export type Phase = "offline" | "starting" | "ready" | "stopping"

export type SystemStatus = {
  /** Both API keys passed their checks. */
  configured: boolean
  keySource: "env" | "dashboard" | null
  /** Active Sent voice numbers on the key. */
  numbers: string[]
  phase: Phase
  /** What Start is doing right now. */
  step?: string
  error?: string
  warning?: string
  /** The browser tab that registered with Sent. Calls ring there. */
  phoneId?: string
  phoneOnline: boolean
}

/** An approved Sent template. Sent doesn't return template bodies, so the app shows the name and variables. */
export type TemplateSummary = {
  id: string
  name: string
  category: string
  channels: Channel[]
  variables: string[]
  language?: string
}

/**
 * Outreach to a list of contacts: one approved template each, then the agent
 * handles the replies and calls by following the scenario.
 */
export type Campaign = {
  id: string
  name: string
  createdAt: number
  templateId: string
  templateName: string
  /** What the agent should achieve with these contacts, in the team's words. */
  scenario: string
  /** Pinned channel for the first message; otherwise Sent's routing picks. */
  channel?: Channel
  status: "sending" | "done" | "stopped"
  recipients: CampaignRecipient[]
}

export type CampaignRecipient = {
  phone: string
  name?: string
  variables: Record<string, string>
  status: "queued" | "sending" | "sent" | "failed" | "skipped"
  error?: string
  conversationId?: string
}

/** What the browser gets: counts instead of every recipient. */
export type CampaignSummary = Omit<Campaign, "recipients"> & {
  total: number
  queued: number
  sent: number
  failed: number
  skipped: number
  replied: number
  called: number
}

export type Snapshot = {
  conversations: Conversation[]
  settings: AgentSettings
  system: SystemStatus
  templates: TemplateSummary[]
  campaigns: CampaignSummary[]
}

export type PhoneCommand =
  | { type: "dial"; conversationId: string; callId: string; to: string; by: "agent" | "human" }
  | { type: "answer"; callId: string; by: "agent" | "human" }
  | { type: "decline"; callId: string }
  | { type: "hang-up"; callId: string }
  | { type: "take-over"; callId: string }
  | { type: "listen"; callId: string; on: boolean }

export type ServerMessage =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "phone"; command: PhoneCommand }
  | { type: "notice"; level: "info" | "error"; message: string }
