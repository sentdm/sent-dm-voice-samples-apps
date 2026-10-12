"use client"

import { createContext, useContext } from "react"
import type { AgentSettings, CampaignSummary, Channel, Conversation, InboxFilter, SystemStatus, TemplateSummary } from "./types"
import { activeCall } from "./policy"

export type ConsoleState = {
  conversations: Conversation[]
  selectedId: string
  filter: InboxFilter
  settings: AgentSettings
  /** Approved templates, for messages when free text isn't allowed. */
  templates: TemplateSummary[]
  campaigns: CampaignSummary[]
}

/** What a campaign needs: the same body POST /api/campaigns takes from other programs. */
export type CampaignInput = {
  name: string
  templateId: string
  scenario: string
  channel?: Channel
  recipients: Array<{ phone: string; name?: string; variables: Record<string, string> }>
}

/** What the console can do. Conversation-level call actions act on that conversation's active call. */
export type ConsoleActions = {
  select: (id: string) => void
  setFilter: (filter: InboxFilter) => void
  /** Without a channel, Sent's routing picks one. */
  send: (id: string, text: string, channel?: Channel) => void
  sendTemplate: (id: string, templateId: string, parameters: Record<string, string>, channel?: Channel) => void
  takeOver: (id: string) => void
  handBack: (id: string) => void
  approveHandover: (id: string, proposalId: string) => void
  dismissHandover: (id: string, proposalId: string) => void
  approveCall: (id: string, proposalId: string, by: "agent" | "human") => void
  dismissCall: (id: string, proposalId: string) => void
  startCall: (id: string, by: "agent" | "human") => void
  answer: (id: string, by: "agent" | "human") => void
  declineCall: (id: string) => void
  takeOverCall: (id: string) => void
  toggleListen: (id: string) => void
  hangUp: (id: string) => void
  resolve: (id: string) => void
  reopen: (id: string) => void
  saveSettings: (settings: AgentSettings) => Promise<void>
  setConsent: (id: string, granted: boolean) => void
  setTimeZone: (id: string, timeZone: string) => void
  createCampaign: (input: CampaignInput) => Promise<void>
  stopCampaign: (id: string) => void
  resumeCampaign: (id: string) => void
}

/** The agent's connection to Sent and this tab's role. */
export type LiveControls = {
  system: SystemStatus
  /** This tab registered with Sent: calls ring here, and only here can a person talk. */
  isPhone: boolean
  connect: (sentKey: string, openaiKey: string) => Promise<void>
  start: () => Promise<void>
  stop: () => Promise<void>
  setMuted: (muted: boolean) => void
}

export type ConsoleValue = {
  state: ConsoleState
  actions: ConsoleActions
  live: LiveControls
}

export const ConsoleContext = createContext<ConsoleValue | null>(null)

export function useConsole() {
  const value = useContext(ConsoleContext)
  if (!value) throw new Error("useConsole must be used inside <LiveConsoleProvider>")
  return value
}

export function useSelectedConversation(): Conversation | undefined {
  const { state } = useConsole()
  return state.conversations.find((c) => c.id === state.selectedId) ?? state.conversations[0]
}

/** The browser tab is one phone line, so a call with anyone else blocks a new one. */
export function useLineBusy(conversation: Conversation | undefined): boolean {
  const { state } = useConsole()
  if (!conversation) return false
  return state.conversations.some((c) => c.id !== conversation.id && activeCall(c))
}
