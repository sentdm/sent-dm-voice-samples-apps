import type {
  AccountSummary,
  ApiEnvelope,
  ParticipantTarget,
  PresenceEntry,
  ProxyRequest,
  ProxyResponse,
  PublicConfig,
  RoutingRules,
  StateSnapshot,
  TrackedCall,
  TransferResult,
  VoiceNumberResponse,
} from "@/lib/shared/types";
import { parseJsonOrText } from "@/lib/utils";

/** Calls to this app's own server. Every Sent API call goes through the proxy in here. */

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly details: unknown = null
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

const SETUP_PASSWORD_KEY = "sent-voice-tour.setup-password";

/** Remembered for this browser session and sent with every configuration change. */
export function setSetupPassword(password: string): void {
  if (password) window.sessionStorage.setItem(SETUP_PASSWORD_KEY, password);
  else window.sessionStorage.removeItem(SETUP_PASSWORD_KEY);
}

function setupPasswordHeader(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const password = window.sessionStorage.getItem(SETUP_PASSWORD_KEY);
  return password ? { "x-setup-password": password } : {};
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...setupPasswordHeader(),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await response.text();
  const body = parseJsonOrText(text);
  if (!response.ok) {
    const error = body as {
      error?: string;
      code?: string;
      details?: unknown;
    } | null;
    throw new ApiClientError(
      error?.error ?? `Request failed with ${response.status}`,
      response.status,
      error?.code ?? null,
      error?.details ?? null
    );
  }
  return body as T;
}

export interface SetupInput {
  apiBaseUrl: string;
  apiKey: string;
  phoneNumber: string;
  callbackSigningSecret: string;
}

export interface SetupResult {
  config: PublicConfig;
  account: AccountSummary;
  warnings: string[];
}

export interface ConnectResult {
  account: AccountSummary;
  numbers: VoiceNumberResponse[];
}

export interface RouteNumberResult {
  number: VoiceNumberResponse;
  callbackSecret: string;
}

export const api = {
  config: () => request<PublicConfig>("/api/setup"),
  saveSetup: (input: SetupInput) =>
    request<SetupResult>("/api/setup", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  /** Checks the key and lists the account's voice numbers. Saves nothing. */
  connect: (input: Pick<SetupInput, "apiBaseUrl" | "apiKey">) =>
    request<ConnectResult>("/api/setup/connect", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /** Points the number's calls at this app and returns its callback secret. */
  routeNumber: (
    input: Pick<SetupInput, "apiBaseUrl" | "apiKey"> & { number: string }
  ) =>
    request<RouteNumberResult>("/api/setup/route-number", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  state: () => request<StateSnapshot>("/api/state"),
  routing: {
    save: (rules: RoutingRules) =>
      request<RoutingRules>("/api/voice/routing", {
        method: "PUT",
        body: JSON.stringify(rules),
      }),
  },
  presence: (identity: string, online: boolean, clientState: string | null) =>
    request<PresenceEntry[]>("/api/voice/presence", {
      method: "POST",
      body: JSON.stringify({ identity, online, clientState }),
      keepalive: true,
    }),
  currentCall: (identity: string) =>
    request<{ call: TrackedCall | null; legId: string | null }>(
      `/api/voice/calls/current?identity=${encodeURIComponent(identity)}`
    ),
  transfer: (
    callId: string,
    body: {
      identity: string;
      target: ParticipantTarget;
      callerId?: string;
    }
  ) =>
    request<TransferResult>(
      `/api/voice/calls/${encodeURIComponent(callId)}/transfer`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    ),
  proxy: (input: ProxyRequest) =>
    request<ProxyResponse>("/api/sent/proxy", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /** A Sent API call through the proxy, answered with the envelope's `data`. */
  sent: async <T = unknown>(input: ProxyRequest): Promise<T> =>
    unwrapProxy<T>(await api.proxy(input)),
  webhookSubscription: (
    body:
      | { action: "create" }
      | { action: "rotate" }
      | { action: "forget" }
      | { action: "use"; id: string; signingSecret: string }
  ) =>
    request<PublicConfig>("/api/sent/webhooks/subscription", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Compiles the callback route in development so the first real question is answered in time. */
  warmCallback: () =>
    fetch("/api/voice/callback", { cache: "no-store" }).catch(() => undefined),
};

/** Reads the `data` of a v3 envelope out of a proxy response, or throws with the API's error. */
export function unwrapProxy<T>(response: ProxyResponse): T {
  const body = response.body as Partial<ApiEnvelope<T>> | null;
  if (response.ok) {
    return (
      body && typeof body === "object" && "data" in body ? body.data : body
    ) as T;
  }
  throw new ApiClientError(
    body?.error?.message ?? `The Sent API answered ${response.status}`,
    response.status,
    body?.error?.code ?? null,
    body?.error?.details ?? null
  );
}
