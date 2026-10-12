import { NextResponse } from "next/server";
import type {
  CallWebhookPayload,
  TrackedCall,
  WebhookEnvelope,
  WebhookInboxEntry,
} from "@/lib/shared/types";
import { readConfig } from "@/lib/server/config-store";
import {
  readSignatureHeaders,
  signatureStatusOf,
  verifySentSignature,
} from "@/lib/server/signature";
import { appendWebhook, getCall, upsertCall } from "@/lib/server/state";
import { newId } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Receives the call webhooks Sent delivers to the subscription this app created. The
 * signature is verified with that subscription's secret, the same scheme as the callback
 * questions. Anything that does not verify is refused with 401 so it is never trusted.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const config = await readConfig();
  const verdict = verifySentSignature(
    readSignatureHeaders(request.headers),
    rawBody,
    config?.webhook?.signingSecret
  );

  const entry: WebhookInboxEntry = {
    id: newId(),
    receivedAt: new Date().toISOString(),
    signature: signatureStatusOf(verdict),
    signatureDetail: verdict.ok ? null : verdict.detail,
    event: request.headers.get("x-webhook-event-type"),
    envelope: null,
    rawBody,
    statusCode: verdict.ok ? 200 : 401,
  };

  if (!verdict.ok) {
    appendWebhook(entry);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    const envelope = JSON.parse(rawBody) as WebhookEnvelope<CallWebhookPayload>;
    entry.envelope = envelope;
    entry.event = envelope.event ?? entry.event;
    if (envelope.field === "call") applyCallEvent(envelope);
  } catch {
    entry.statusCode = 400;
    appendWebhook(entry);
    return NextResponse.json({ error: "Unreadable body" }, { status: 400 });
  }

  appendWebhook(entry);
  return NextResponse.json({ received: true });
}

/** Moves the tracked call along. Participant legs have their own ids and do not end the parent call. */
function applyCallEvent(envelope: WebhookEnvelope<CallWebhookPayload>): void {
  const payload = envelope.payload;
  if (!payload?.call_id) return;
  const call = getCall(payload.call_id);
  if (!call) return;

  const patch: Partial<TrackedCall> & { callId: string } = {
    callId: call.callId,
  };
  switch (envelope.event) {
    case "call.answered":
      patch.status = "answered";
      break;
    case "call.completed":
      patch.status = "completed";
      patch.endedAt = payload.updated_at;
      patch.durationSeconds = payload.duration_seconds ?? null;
      patch.price = payload.price ?? null;
      break;
    case "call.failed":
      patch.status =
        payload.reason === "rejected"
          ? "rejected"
          : payload.reason === "no_answer"
            ? "no_answer"
            : "failed";
      patch.endedAt = payload.updated_at;
      patch.failureReason = payload.reason ?? null;
      break;
    case "call.recording_ready":
      // One of these arrives per recording; the flag only says at least one is ready.
      patch.recordingAvailable = true;
      break;
    default:
      return;
  }
  upsertCall(call.callId, patch);
}
