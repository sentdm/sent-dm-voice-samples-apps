import Sent, { APIError } from "@sentdm/sentdm"
import type { Channel, TemplateSummary } from "@/lib/types"

/** Message events the app follows: replies from contacts, and what happened to each text it sent. */
export const MESSAGE_EVENTS = ["received", "sent", "delivered", "read", "failed", "blocked", "filtered"]

/** A Sent error as one readable line: "Sent 404: NOT_FOUND. The number is not on this account." */
export function sentErrorMessage(error: unknown): string {
  if (error instanceof APIError) {
    const body = error.error as { error?: { code?: string; message?: string }; message?: string } | undefined
    const code = body?.error?.code
    const message = body?.error?.message ?? body?.message ?? error.message
    return `Sent${error.status ? ` ${error.status}` : ""}: ${code ? `${code}. ` : ""}${message}`
  }
  return error instanceof Error ? error.message : String(error)
}

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Sent returned no ${what}. Check the API key's access.`)
  return value
}

/** The Sent API calls this app makes, through the official SDK. */
export function createSentApi(apiKey: string, baseURL?: string) {
  const client = new Sent({ apiKey, baseURL, maxRetries: 1, timeout: 15_000 })

  return {
    async voiceNumbers() {
      return (await client.channels.voice.list()).data ?? []
    },

    async voiceNumber(number: string) {
      return required((await client.channels.voice.retrieve(number)).data, "voice number")
    },

    /** Points an existing number's calls at the app. Returns the secret Sent signs each question with. */
    async routeNumber(number: string, callbackUrl: string) {
      const created = required((await client.channels.voice.create({ number, callback_url: callbackUrl })).data, "voice number")
      return required(created.callback_secret, "callback secret")
    },

    async restoreNumber(number: string, callbackUrl: string) {
      await client.channels.voice.update(number, { callback_url: callbackUrl })
    },

    /** Asks Sent to send a signed test question through the public path. */
    async testCallback(number: string) {
      const verdict = required((await client.channels.voice.test(number, {})).data, "test result")
      if (verdict.outcome !== "ok") throw new Error(`Sent callback test: ${verdict.outcome}. ${verdict.error?.message ?? ""}`.trim())
    },

    async voiceToken(identity: string, number: string) {
      const data = required((await client.channels.voice.createToken({ identity, number, ttl: 600 })).data, "voice token")
      return required(data.token, "voice token")
    },

    /** Approved templates you can send. Sent's keyword auto-replies (STOP, HELP, START) are left out. */
    async templates(): Promise<TemplateSummary[]> {
      const templates: TemplateSummary[] = []
      for await (const t of client.templates.list({ page_size: 100, status: "APPROVED" })) {
        if (!t.id || !t.name || t.status !== "APPROVED" || t.auto_reply_action) continue
        templates.push({
          id: t.id,
          name: t.name,
          category: t.category ?? "UTILITY",
          channels: (t.channels ?? ["sms"]).filter((c): c is Channel => c === "sms" || c === "whatsapp" || c === "rcs"),
          variables: t.variables ?? [],
          language: t.language,
        })
        if (templates.length >= 200) break
      }
      return templates
    },

    /**
     * Sends an approved template. Sent's routing picks the sender, and the
     * channel too unless the agent chose one. The status webhooks report the
     * channel used and the rendered body.
     */
    async sendTemplate(input: { to: string; templateId: string; parameters: Record<string, string>; channel?: Channel; idempotencyKey: string }) {
      const response = await client.messages.send({
        to: [input.to],
        template: { id: input.templateId, parameters: input.parameters },
        ...(input.channel ? { channel: [input.channel] } : {}),
        "Idempotency-Key": input.idempotencyKey,
      })
      const recipient = response.data?.recipients?.[0]
      return { messageId: recipient?.message_id, body: recipient?.body ?? undefined }
    },

    /** Your newest messages across all conversations, up to `limit`. The SDK fetches the pages. */
    async history(limit: number) {
      const messages = []
      for await (const message of client.conversations.list({ page_size: 100 })) {
        messages.push(message)
        if (messages.length >= limit) break
      }
      return messages
    },

    async createWebhook(endpointUrl: string) {
      const webhook = required(
        (
          await client.webhooks.create({
            display_name: "Sent chat + voice sample (local)",
            endpoint_url: endpointUrl,
            event_types: ["message", "call"],
            // call.failed says why a call never connected, for example a country Sent doesn't call.
            event_filters: { message: MESSAGE_EVENTS, call: ["failed"] },
            retry_count: 3,
            timeout_seconds: 10,
          })
        ).data,
        "webhook",
      )
      return { id: required(webhook.id, "webhook id"), secret: required(webhook.signing_secret, "webhook secret") }
    },

    async deleteWebhook(id: string) {
      await client.webhooks.delete(id)
    },

    /**
     * Sends free-form text. Sent's routing picks the sender for each contact,
     * using your routing rules: the app never sets one, because a pinned sender
     * fails every contact it can't reach. Sent picks the channel too, unless
     * the agent chose one for a reason.
     */
    async sendText(input: { to: string; text: string; channel?: Channel; idempotencyKey: string }) {
      const response = await client.messages.send({
        to: [input.to],
        text: input.text,
        ...(input.channel ? { channel: [input.channel] } : {}),
        "Idempotency-Key": input.idempotencyKey,
      })
      return response.data?.recipients?.[0]?.message_id
    },
  }
}

export type SentApi = ReturnType<typeof createSentApi>
