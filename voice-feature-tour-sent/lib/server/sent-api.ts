import type {
  AccountSummary,
  ApiEnvelope,
  AppConfig,
  HttpMethod,
  ParticipantTarget,
  ProxyResponse,
  SentCredentials,
  VoiceCallRecord,
  VoiceNumberResponse,
  VoiceParticipantResponse,
  VoiceTokenResponse,
} from "@/lib/shared/types";
import { parseJsonOrText } from "@/lib/utils";
import { certificateHint } from "./certificates";

/**
 * The only place this app talks to the Sent API. Every call adds the API key and the
 * base URL from the saved configuration.
 */

export interface SentApiCall {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

/** Everything about one exchange with the Sent API. The API explorer shows it as is. */
export type SentApiResult = ProxyResponse;

export class SentApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: Record<string, string[]> | null;

  constructor(result: SentApiResult) {
    const envelope = result.body as ApiEnvelope<unknown> | null;
    const error = envelope?.error;
    super(
      error?.message ??
        (result.status === 0
          ? "The Sent API could not be reached"
          : `The Sent API answered ${result.status}`)
    );
    this.name = "SentApiError";
    this.status = result.status;
    this.code = error?.code ?? null;
    this.details = error?.details ?? null;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = "voice-feature-tour-sent/0.1";

export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | undefined>
): string {
  const url = new URL(path.replace(/^\/+/, ""), ensureTrailingSlash(baseUrl));
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url.toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export async function callSentApi(
  config: SentCredentials,
  call: SentApiCall
): Promise<SentApiResult> {
  const url = buildUrl(config.apiBaseUrl, call.path, call.query);
  const requestHeaders: Record<string, string> = {
    "x-api-key": config.apiKey,
    accept: "application/json",
    "user-agent": USER_AGENT,
  };
  let payload: string | undefined;
  if (call.body !== undefined && call.method !== "GET") {
    requestHeaders["content-type"] = "application/json";
    payload = JSON.stringify(call.body);
  }

  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: call.method,
      headers: requestHeaders,
      body: payload,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      cache: "no-store",
    });
    const rawBody = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      url,
      durationMs: Date.now() - startedAt,
      requestHeaders,
      responseHeaders: Object.fromEntries(response.headers),
      body: parseJsonOrText(rawBody),
      rawBody,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      url,
      durationMs: Date.now() - startedAt,
      requestHeaders,
      responseHeaders: {},
      body: {
        success: false,
        error: {
          code: "NETWORK",
          message:
            error instanceof Error && error.name === "TimeoutError"
              ? "The request timed out"
              : `The request failed: ${describe(error)}`,
        },
      },
      rawBody: "",
    };
  }
}

/** Calls the API and returns the `data` of a successful envelope, or throws a SentApiError. */
export async function sentData<T>(
  config: SentCredentials,
  call: SentApiCall
): Promise<T> {
  const result = await callSentApi(config, call);
  if (!result.ok) throw new SentApiError(result);
  const envelope = result.body as ApiEnvelope<T> | null;
  if (envelope && typeof envelope === "object" && "data" in envelope) {
    return envelope.data as T;
  }
  return result.body as T;
}

/** Calls an endpoint that answers 204, throwing on anything else. */
export async function sentNoContent(
  config: SentCredentials,
  call: SentApiCall
): Promise<void> {
  const result = await callSentApi(config, call);
  if (!result.ok) throw new SentApiError(result);
}

export async function getAccount(
  config: SentCredentials
): Promise<AccountSummary> {
  const account = await sentData<Partial<AccountSummary>>(config, {
    method: "GET",
    path: "/v3/me",
  });
  return {
    id: account.id ?? null,
    name: account.name ?? null,
    type: account.type ?? null,
    status: account.status ?? null,
  };
}

export function listVoiceNumbers(
  config: SentCredentials
): Promise<VoiceNumberResponse[]> {
  return sentData(config, { method: "GET", path: "/v3/channels/voice" });
}

/**
 * Points a number's calls at a callback URL. Sent answers with the number and, for this
 * request only, its callback secret.
 */
export function routeVoiceNumber(
  config: SentCredentials,
  number: string,
  callbackUrl: string
): Promise<VoiceNumberResponse & { callback_secret?: string }> {
  return sentData(config, {
    method: "POST",
    path: "/v3/channels/voice",
    body: { number, callback_url: callbackUrl },
  });
}

export function mintVoiceToken(
  config: AppConfig,
  identity: string,
  ttlSeconds?: number
): Promise<VoiceTokenResponse> {
  return sentData(config, {
    method: "POST",
    path: "/v3/channels/voice/tokens",
    body: {
      identity,
      number: config.phoneNumber,
      ...(ttlSeconds ? { ttl: ttlSeconds } : {}),
    },
  });
}

export function addParticipant(
  config: AppConfig,
  callId: string,
  target: ParticipantTarget,
  callerId?: string
): Promise<VoiceCallRecord> {
  return sentData(config, {
    method: "POST",
    path: `/v3/calls/${encodeURIComponent(callId)}/participants`,
    body: {
      to: target,
      ...(callerId ? { caller_id: callerId } : {}),
    },
  });
}

export function listParticipants(
  config: AppConfig,
  callId: string
): Promise<VoiceParticipantResponse[]> {
  return sentData(config, {
    method: "GET",
    path: `/v3/calls/${encodeURIComponent(callId)}/participants`,
  });
}

export function removeParticipant(
  config: AppConfig,
  callId: string,
  participantId: string
): Promise<void> {
  return sentNoContent(config, {
    method: "DELETE",
    path: `/v3/calls/${encodeURIComponent(callId)}/participants/${encodeURIComponent(participantId)}`,
  });
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: { code?: string } }).cause;
    const hint = certificateHint(error);
    return cause?.code
      ? `${error.message} (${cause.code})${hint ? `. ${hint}` : ""}`
      : error.message;
  }
  return String(error);
}

/** The subscription this app keeps: every `call` event, delivered to `endpointUrl`. */
export function webhookSettings(endpointUrl: string) {
  return {
    display_name: "Sent voice feature tour",
    endpoint_url: endpointUrl,
    event_types: ["call"],
    retry_count: 3,
    timeout_seconds: 30,
  };
}

/** Points an existing subscription at a new endpoint. Its signing secret stays the same. */
export function updateWebhookEndpoint(
  config: SentCredentials,
  webhookId: string,
  endpointUrl: string
): Promise<unknown> {
  return sentData(config, {
    method: "PUT",
    path: `/v3/webhooks/${encodeURIComponent(webhookId)}`,
    body: webhookSettings(endpointUrl),
  });
}
