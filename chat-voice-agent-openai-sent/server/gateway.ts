import http from "node:http"
import { answerCallQuestion, verifySentSignature, type CallAnswer, type CallQuestion } from "./security"
import type { Runtime } from "./runtime"
import type { Conversations } from "./conversations"
import type { Calls } from "./calls"

/** Reads a request body up to `limit` bytes. Resolves null when it is larger. */
export function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

function respond(res: http.ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, body === undefined ? {} : { "Content-Type": "application/json" })
  res.end(body === undefined ? undefined : JSON.stringify(body))
}

/**
 * The only server the internet can reach, through the tunnel. Sent posts
 * signed voice questions and messaging webhooks to random paths; everything
 * else is 404.
 */
export function createGateway(rt: Runtime, conversations: Conversations, calls: Calls) {
  // Sent retries a question it got no answer to; a retry gets the same answer.
  const answers = new Map<string, { answer: CallAnswer; time: number }>()

  return http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://gateway").pathname
      if (req.method === "GET" && path === "/health") return respond(res, 200, { ok: true })
      if (req.method !== "POST") return respond(res, 404)

      if (rt.voicePath && path === rt.voicePath) {
        const raw = await readBody(req, 64 * 1024)
        const secret = rt.backup?.callbackSecret
        if (!raw || !secret || !verifySentSignature(req.headers, raw, secret)) return respond(res, 401)
        let question: CallQuestion
        try {
          question = JSON.parse(raw.toString())
        } catch {
          return respond(res, 400)
        }
        if (!question || typeof question.callId !== "string" || question.callId.length > 100) return respond(res, 400)
        const key = `${question.callId}:${question.type}:${question.test === true ? "test" : "live"}`
        const previous = answers.get(key)
        if (previous && Date.now() - previous.time < 15_000) return respond(res, 200, previous.answer)
        // With "Only these numbers" set, other callers don't reach the app.
        const caller = question.direction === "inbound" ? question.from?.number : undefined
        const answer = answerCallQuestion(question, {
          number: rt.settings.number,
          identity: rt.identity,
          ready: rt.isReady() && (!caller || rt.agentServes(caller)),
          lineBusy: Boolean(rt.store.activeCall()),
          pending: calls.pendingDial(),
        })
        answers.set(key, { answer, time: Date.now() })
        if (answers.size > 300) answers.delete(answers.keys().next().value!)
        if (!question.test) {
          if (question.direction === "inbound") calls.inboundQuestion(question, answer)
          else calls.outboundQuestion(question, answer)
        }
        return respond(res, 200, answer)
      }

      if (rt.hookPath && path === rt.hookPath) {
        const raw = await readBody(req, 256 * 1024)
        const secret = rt.backup?.webhookSecret
        if (!raw || !secret || !verifySentSignature(req.headers, raw, secret)) return respond(res, 401)
        let event: unknown
        try {
          event = JSON.parse(raw.toString())
        } catch {
          return respond(res, 400)
        }
        // Answer first: Sent counts a slow response as a failed delivery.
        respond(res, 200, { ok: true })
        const eventId = req.headers["x-webhook-event-id"]
        conversations.handleWebhook(typeof eventId === "string" ? eventId : undefined, event as Parameters<Conversations["handleWebhook"]>[1])
        return
      }

      return respond(res, 404)
    } catch (error) {
      console.error(`Gateway: ${(error as Error).message}`)
      if (!res.headersSent) respond(res, 500)
    }
  })
}
