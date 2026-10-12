import type { Campaign, CampaignRecipient, CampaignSummary, Channel } from "@/lib/types"
import { toE164 } from "@/lib/phone"
import { newId, type JsonFiles } from "./store"
import type { Runtime } from "./runtime"
import type { Conversations } from "./conversations"

/** Sends at a time. Sent allows 10,000 requests a minute; this keeps a 1,000-contact campaign to a couple of minutes. */
const WORKERS = 4
export const MAX_RECIPIENTS = 1000

type CreateInput = {
  name?: unknown
  template?: unknown
  templateId?: unknown
  scenario?: unknown
  channel?: unknown
  recipients?: unknown
}

/**
 * Campaigns: one approved template to each contact on a list, then the agent
 * handles the replies and calls by following the campaign's scenario.
 */
export class Campaigns {
  campaigns: Campaign[] = []
  private saveTimer?: NodeJS.Timeout

  constructor(
    private rt: Runtime,
    private conversations: Conversations,
    private files: JsonFiles,
  ) {
    rt.campaignFor = (id) => {
      const campaign = id ? this.campaigns.find((c) => c.id === id) : undefined
      return campaign && { name: campaign.name, scenario: campaign.scenario }
    }
    rt.campaignSummaries = () => this.summaries()
  }

  async load() {
    this.campaigns = (await this.files.read<Campaign[]>("campaigns.json")) ?? []
    // Sending stops with the app. Resume picks up the contacts not sent yet.
    for (const campaign of this.campaigns) {
      if (campaign.status === "sending") campaign.status = "stopped"
      for (const r of campaign.recipients) if (r.status === "sending") r.status = "queued"
    }
  }

  private changed() {
    this.rt.broadcastSoon()
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.files.write("campaigns.json", this.campaigns).catch(() => {}), 1_000)
  }

  async flush() {
    clearTimeout(this.saveTimer)
    await this.files.write("campaigns.json", this.campaigns)
  }

  summaries(): CampaignSummary[] {
    return this.campaigns.map((campaign) => this.summary(campaign))
  }

  summary(campaign: Campaign): CampaignSummary {
    const { recipients, ...rest } = campaign
    const count = (status: CampaignRecipient["status"]) => recipients.filter((r) => r.status === status).length
    let replied = 0
    let called = 0
    for (const c of this.rt.store.conversations) {
      if (c.campaignId !== campaign.id) continue
      if (c.items.some((i) => i.kind === "message" && i.author === "contact" && i.at > campaign.createdAt)) replied++
      if (c.items.some((i) => i.kind === "call" && i.at > campaign.createdAt)) called++
    }
    return { ...rest, total: recipients.length, queued: count("queued") + count("sending"), sent: count("sent"), failed: count("failed"), skipped: count("skipped"), replied, called }
  }

  get(id: string) {
    const campaign = this.campaigns.find((c) => c.id === id)
    if (!campaign) throw new Error("That campaign doesn't exist.")
    return campaign
  }

  /**
   * Checks a campaign request and starts sending. Invalid rows don't stop the
   * campaign: each one is kept as "skipped" with the reason.
   */
  create(input: CreateInput): CampaignSummary {
    if (!this.rt.isReady()) throw new Error("Start the agent first: replies and calls reach the app only while it runs.")
    const ref = typeof input.templateId === "string" ? input.templateId : typeof input.template === "string" ? input.template : ""
    const template = this.rt.templates.find((t) => t.id === ref || t.name === ref)
    if (!template) throw new Error("Choose one of your approved Sent templates, by id or by name.")
    const scenario = typeof input.scenario === "string" ? input.scenario.trim().slice(0, 2000) : ""
    if (!scenario) throw new Error("Describe the scenario: what the agent should achieve with these contacts.")
    const channel = input.channel === undefined || input.channel === null || input.channel === "" ? undefined : input.channel
    if (channel !== undefined && channel !== "sms" && channel !== "whatsapp" && channel !== "rcs") throw new Error("The channel must be sms, whatsapp, rcs, or left out for Sent to pick.")
    if (channel && !template.channels.includes(channel)) throw new Error(`The template "${template.name}" can't be sent by ${channel}.`)
    if (!Array.isArray(input.recipients) || input.recipients.length === 0) throw new Error("Add at least one contact.")
    if (input.recipients.length > MAX_RECIPIENTS) throw new Error(`A campaign can have at most ${MAX_RECIPIENTS} contacts.`)

    const seen = new Set<string>()
    const recipients: CampaignRecipient[] = input.recipients.map((raw) => {
      const row = (raw && typeof raw === "object" ? raw : {}) as { phone?: unknown; name?: unknown; variables?: unknown }
      const typed = typeof row.phone === "string" ? row.phone.trim().replace(/^00/, "+") : ""
      const phone = toE164(typed)
      const name = typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, 80) : undefined
      const given = (row.variables && typeof row.variables === "object" ? row.variables : {}) as Record<string, unknown>
      const variables: Record<string, string> = {}
      for (const v of template.variables) if (typeof given[v] === "string" && (given[v] as string).trim()) variables[v] = (given[v] as string).trim().slice(0, 500)
      const skip = (error: string): CampaignRecipient => ({ phone: phone ?? (typed || "(empty)"), name, variables, status: "skipped", error })
      if (!phone) return skip("Not in international format, for example +14155551234.")
      if (seen.has(phone)) return skip("Listed twice.")
      seen.add(phone)
      if (!this.rt.agentServes(phone)) return skip("Not on your Only these numbers list.")
      const missing = template.variables.find((v) => !variables[v])
      if (missing) return skip(`No value for the template variable ${missing}.`)
      return { phone, name, variables, status: "queued" }
    })

    const campaign: Campaign = {
      id: newId("camp"),
      name: (typeof input.name === "string" && input.name.trim().slice(0, 80)) || `Campaign ${new Date().toLocaleDateString()}`,
      createdAt: Date.now(),
      templateId: template.id,
      templateName: template.name,
      scenario,
      channel,
      status: "sending",
      recipients,
    }
    this.campaigns.unshift(campaign)
    this.changed()
    void this.run(campaign)
    return this.summary(campaign)
  }

  stop(id: string) {
    const campaign = this.get(id)
    if (campaign.status === "sending") campaign.status = "stopped"
    this.changed()
    return this.summary(campaign)
  }

  resume(id: string) {
    const campaign = this.get(id)
    if (campaign.status === "sending") return this.summary(campaign)
    if (!this.rt.isReady()) throw new Error("Start the agent first.")
    if (!campaign.recipients.some((r) => r.status === "queued")) throw new Error("Every contact in this campaign was already handled.")
    campaign.status = "sending"
    this.changed()
    void this.run(campaign)
    return this.summary(campaign)
  }

  private async run(campaign: Campaign) {
    await Promise.all(Array.from({ length: WORKERS }, () => this.worker(campaign)))
    if (campaign.status === "sending") campaign.status = "done"
    this.changed()
  }

  private async worker(campaign: Campaign) {
    while (campaign.status === "sending") {
      // The agent stopped: pause here, so Resume can pick up the rest.
      if (!this.rt.isReady()) {
        campaign.status = "stopped"
        return
      }
      const recipient = campaign.recipients.find((r) => r.status === "queued")
      if (!recipient) return
      recipient.status = "sending"
      await this.send(campaign, recipient)
      this.changed()
    }
  }

  private async send(campaign: Campaign, recipient: CampaignRecipient) {
    const c = this.rt.store.forPhone(recipient.phone)
    recipient.conversationId = c.id
    if (recipient.name && !c.contact.name) c.contact.name = recipient.name
    if (!c.contact.tags.includes(campaign.name)) c.contact.tags.push(campaign.name)
    c.campaignId = campaign.id
    if (c.status === "resolved") c.status = "open"
    if (c.contact.optedOut) {
      recipient.status = "skipped"
      recipient.error = "Texted STOP."
      return
    }
    try {
      await this.conversations.sendTemplate(c, campaign.templateId, recipient.variables, "agent", campaign.channel as Channel | undefined)
      const message = c.items.findLast((i) => i.kind === "message" && i.author === "agent")
      const failed = message?.kind === "message" && message.status === "failed"
      recipient.status = failed ? "failed" : "sent"
      if (failed && message?.kind === "message") recipient.error = message.error
    } catch (error) {
      recipient.status = "failed"
      recipient.error = (error as Error).message
    }
  }
}
