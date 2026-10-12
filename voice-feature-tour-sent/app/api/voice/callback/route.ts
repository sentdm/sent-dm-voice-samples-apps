import { setTimeout as sleep } from "node:timers/promises";
import { NextResponse } from "next/server";
import type {
  AppConfig,
  CallbackLogEntry,
  ParticipantTarget,
  TrackedCall,
  VoiceAction,
  VoiceAddress,
  VoiceQuestion,
} from "@/lib/shared/types";
import { readConfig, readRoutingRules } from "@/lib/server/config-store";
import { decide, identityOf } from "@/lib/server/routing";
import { addParticipant, SentApiError } from "@/lib/server/sent-api";
import {
  readSignatureHeaders,
  signatureStatusOf,
  verifySentSignature,
} from "@/lib/server/signature";
import {
  appendCallbackLog,
  getCall,
  onlineIdentities,
  upsertCall,
} from "@/lib/server/state";
import { newId } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Answers `ok` so the route can be compiled and warmed up before the first real question. */
export async function GET() {
  return NextResponse.json({ ok: true, route: "voice callback" });
}

/**
 * The callback URL configured on the voice number. Sent POSTs a question here and waits at
 * most 2.5 seconds for the answer, so this handler does no network calls of its own:
 * verify, decide, remember, answer. A 4xx tells Sent the call is refused.
 */
export async function POST(request: Request) {
  const startedAt = Date.now();
  const rawBody = await request.text();
  const requestId = request.headers.get("x-request-id");
  const retry = request.headers.get("x-sent-retry") === "1";
  const signatureHeaders = readSignatureHeaders(request.headers);

  const [config, rules] = await Promise.all([readConfig(), readRoutingRules()]);
  const verdict = verifySentSignature(
    signatureHeaders,
    rawBody,
    config?.callbackSigningSecret
  );

  const entry: CallbackLogEntry = {
    id: newId(),
    receivedAt: new Date(startedAt).toISOString(),
    requestId,
    retry,
    signature: signatureStatusOf(verdict),
    signatureDetail: verdict.ok ? null : verdict.detail,
    question: null,
    rawBody,
    answer: null,
    explanation: "",
    statusCode: 200,
    durationMs: 0,
  };

  if (!verdict.ok) {
    entry.explanation = `Refused: ${verdict.detail}`;
    return finish(entry, 401, { error: "Invalid signature" }, startedAt);
  }

  let question: VoiceQuestion;
  try {
    question = parseQuestion(rawBody);
  } catch (error) {
    entry.explanation = `Refused: ${error instanceof Error ? error.message : "unreadable question"}`;
    return finish(entry, 400, { error: "Unreadable question" }, startedAt);
  }
  entry.question = question;

  const decision = decide(question, rules, { online: onlineIdentities() });
  entry.answer = decision.answer;
  entry.explanation = decision.explanation;

  const call = remember(
    question,
    decision.identities,
    decision.conferenceName,
    decision.answer.action
  );

  if (decision.followUp && !isTest(question) && config) {
    const target = decision.followUp;
    upsertCall(call.callId, {
      callId: call.callId,
      followUp: {
        target,
        status: "pending",
        participantId: null,
        message: null,
      },
    });
    // Not awaited: Sent is waiting for the answer, and the participant request needs the
    // room to be recorded on the call first, which happens once Sent has read this answer.
    void dialIntoRoom(call.callId, target, rules.callerId || undefined, config);
  }

  return finish(entry, 200, decision.answer, startedAt);
}

function finish(
  entry: CallbackLogEntry,
  status: number,
  body: unknown,
  startedAt: number
) {
  entry.statusCode = status;
  entry.durationMs = Date.now() - startedAt;
  appendCallbackLog(entry);
  return NextResponse.json(body, { status });
}

function parseQuestion(rawBody: string): VoiceQuestion {
  const parsed = JSON.parse(rawBody) as Partial<VoiceQuestion> &
    Record<string, unknown>;
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("not an object");
  if (typeof parsed.callId !== "string" || typeof parsed.number !== "string") {
    throw new Error("callId and number are required");
  }
  if (parsed.type === "call.request") {
    if (!isAddress(parsed.from) || !isAddress(parsed.to))
      throw new Error("from and to are required");
    return parsed as VoiceQuestion;
  }
  if (parsed.type === "call.input") {
    if (typeof parsed.digits !== "string")
      throw new Error("digits is required");
    return parsed as VoiceQuestion;
  }
  throw new Error(`unknown question type ${String(parsed.type)}`);
}

function isAddress(value: unknown): value is VoiceAddress {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "user" ||
    kind === "number" ||
    kind === "anonymous" ||
    kind === "conference"
  );
}

function isTest(question: VoiceQuestion): boolean {
  return question.type === "call.request" && question.test === true;
}

/** Keeps the call map current: who is in the call and which room it is in, by Sent's call id. */
function remember(
  question: VoiceQuestion,
  identities: string[],
  conferenceName: string | null,
  action: VoiceAction
): TrackedCall {
  const existing = getCall(question.callId);
  const status: TrackedCall["status"] =
    action.action === "reject"
      ? "rejected"
      : action.action === "hangup"
        ? "completed"
        : "connecting";

  const legs = { ...(existing?.legs ?? {}) };
  for (const identity of identities) legs[identity] ??= question.callId;
  const common = {
    callId: question.callId,
    number: question.number,
    identities: [...(existing?.identities ?? []), ...identities],
    legs,
    conferenceName: conferenceName ?? existing?.conferenceName ?? null,
    status,
    answer: action,
  };

  if (question.type === "call.request") {
    // In a direct connect both app users share the one call; in a room the callee's own leg
    // arrives with the follow-up.
    const caller = identityOf(question.from);
    if (caller) legs[caller] = question.callId;
    return upsertCall(question.callId, {
      ...common,
      direction: question.direction,
      from: question.from,
      to: question.to,
      startedAt:
        existing?.startedAt ?? question.timestamp ?? new Date().toISOString(),
      endedAt: status === "connecting" ? null : new Date().toISOString(),
      test: question.test === true,
    });
  }

  return upsertCall(question.callId, common);
}

const FOLLOW_UP_ATTEMPTS = 8;
const FOLLOW_UP_DELAY_MS = 1000;

/**
 * Room per call: dials the intended party into the room right after the answer. Sent records
 * the room on the call as it reads our answer, and this can run before that write lands, so a
 * `409 Call is not in a conference` is retried for a few seconds.
 */
async function dialIntoRoom(
  callId: string,
  target: ParticipantTarget,
  callerId: string | undefined,
  config: AppConfig
): Promise<void> {
  for (let attempt = 1; attempt <= FOLLOW_UP_ATTEMPTS; attempt++) {
    await sleep(FOLLOW_UP_DELAY_MS);
    try {
      const leg = await addParticipant(config, callId, target, callerId);
      const current = getCall(callId);
      upsertCall(callId, {
        callId,
        identities: [
          ...(current?.identities ?? []),
          ...(target.kind === "user" ? [target.value] : []),
        ],
        legs:
          target.kind === "user"
            ? { ...(current?.legs ?? {}), [target.value]: leg.id }
            : (current?.legs ?? {}),
        followUp: {
          target,
          status: "done",
          participantId: leg.id,
          message: `Joined the room on attempt ${attempt}`,
        },
      });
      return;
    } catch (error) {
      const conflict = error instanceof SentApiError && error.status === 409;
      if (conflict && attempt < FOLLOW_UP_ATTEMPTS) continue;
      upsertCall(callId, {
        callId,
        followUp: {
          target,
          status: "failed",
          participantId: null,
          message:
            error instanceof Error
              ? error.message
              : "Adding the participant failed",
        },
      });
      return;
    }
  }
}
