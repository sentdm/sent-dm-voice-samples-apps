import type {
  AppEvent,
  AppEventMessage,
  CallbackLogEntry,
  PresenceEntry,
  RoutingRules,
  StateSnapshot,
  TelemetryBatchEntry,
  TrackedCall,
  TunnelInfo,
  WebhookInboxEntry,
} from "@/lib/shared/types";
import { isLive, LOG_LIMIT, newestFirst } from "@/lib/shared/snapshot";

/**
 * Everything the server learns at runtime, kept in memory and streamed to the browser.
 * Stored on `globalThis` so the Next.js dev server's hot reloads do not wipe it.
 */

/** Receives each event as a ready server-sent events frame. */
type Listener = (frame: string) => void;

interface RuntimeState {
  presence: Map<string, PresenceEntry>;
  /** The presence list last sent to the browsers, to skip heartbeats that change nothing. */
  publishedPresence: string;
  calls: Map<string, TrackedCall>;
  /** Voice tokens this server minted, so the telemetry relay can name the identity. */
  tokens: Map<string, { identity: string; expiresAt: number }>;
  callbackLog: CallbackLogEntry[];
  webhookInbox: WebhookInboxEntry[];
  telemetry: TelemetryBatchEntry[];
  listeners: Set<Listener>;
  sequence: number;
  tunnel: TunnelInfo;
}

const PRESENCE_TTL_MS = 45_000;
const PRESENCE_FORGET_MS = 60 * 60 * 1000;
const CALL_RETENTION_MS = 6 * 60 * 60 * 1000;
const CALL_LIMIT = 500;

const globalState = globalThis as unknown as {
  __sentVoiceTourState?: RuntimeState;
};

const state: RuntimeState = (globalState.__sentVoiceTourState ??= {
  presence: new Map(),
  publishedPresence: "",
  calls: new Map(),
  tokens: new Map(),
  callbackLog: [],
  webhookInbox: [],
  telemetry: [],
  listeners: new Set(),
  sequence: 0,
  tunnel: {
    state: "off",
    provider: null,
    fixedUrl: false,
    url: null,
    error: null,
  },
});

export function publish(event: AppEvent): void {
  const message: AppEventMessage = {
    ...event,
    id: ++state.sequence,
    at: new Date().toISOString(),
  };
  const frame = `id: ${message.id}\ndata: ${JSON.stringify(message)}\n\n`;
  for (const listener of state.listeners) {
    try {
      listener(frame);
    } catch {
      // A broken stream is dropped by its own route.
    }
  }
}

export function subscribe(listener: Listener): () => void {
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

// Presence ---------------------------------------------------------------------

export function setPresence(
  identity: string,
  online: boolean,
  clientState: string | null
): PresenceEntry[] {
  state.presence.set(identity, {
    identity,
    online,
    lastSeenAt: new Date().toISOString(),
    clientState,
  });
  const presence = listPresence();
  const key = JSON.stringify(
    presence.map((entry) => [entry.identity, entry.online, entry.clientState])
  );
  if (key !== state.publishedPresence) {
    state.publishedPresence = key;
    publish({ type: "presence.changed", presence });
  }
  return presence;
}

export function listPresence(): PresenceEntry[] {
  const now = Date.now();
  const entries: PresenceEntry[] = [];
  for (const entry of state.presence.values()) {
    const age = now - Date.parse(entry.lastSeenAt);
    if (age > PRESENCE_FORGET_MS) {
      state.presence.delete(entry.identity);
      continue;
    }
    const stale = age > PRESENCE_TTL_MS;
    entries.push(stale && entry.online ? { ...entry, online: false } : entry);
  }
  return entries.sort((a, b) => a.identity.localeCompare(b.identity));
}

export function onlineIdentities(): string[] {
  return listPresence()
    .filter((entry) => entry.online)
    .map((entry) => entry.identity);
}

// Calls --------------------------------------------------------------------------

export function getCall(callId: string): TrackedCall | undefined {
  return state.calls.get(callId);
}

export function upsertCall(
  callId: string,
  patch: Partial<TrackedCall> & Pick<TrackedCall, "callId">
): TrackedCall {
  const existing = state.calls.get(callId);
  const now = new Date().toISOString();
  const call: TrackedCall = existing
    ? { ...existing, ...patch, updatedAt: now }
    : {
        number: "",
        direction: "outbound",
        from: { kind: "anonymous" },
        to: { kind: "anonymous" },
        identities: [],
        legs: {},
        conferenceName: null,
        status: "asking",
        answer: null,
        startedAt: now,
        updatedAt: now,
        endedAt: null,
        durationSeconds: null,
        price: null,
        failureReason: null,
        recordingAvailable: false,
        test: false,
        followUp: null,
        ...patch,
      };
  call.identities = Array.from(new Set(call.identities));
  state.calls.set(callId, call);
  pruneCalls();
  publish({ type: "call.updated", call });
  return call;
}

/** Finds the call a leg id belongs to, whether it is the parent call or a participant leg. */
export function findCallByAnyId(id: string): TrackedCall | undefined {
  const direct = state.calls.get(id);
  if (direct) return direct;
  for (const call of state.calls.values()) {
    if (Object.values(call.legs).includes(id)) return call;
  }
  return undefined;
}

/** The most recent live call an identity takes part in. */
export function findLiveCallForIdentity(
  identity: string
): TrackedCall | undefined {
  let best: TrackedCall | undefined;
  for (const call of state.calls.values()) {
    if (call.test || !isLive(call) || !call.identities.includes(identity))
      continue;
    if (!best || call.updatedAt > best.updatedAt) best = call;
  }
  return best;
}

export function listCalls(): TrackedCall[] {
  return Array.from(state.calls.values()).sort(newestFirst);
}

/**
 * Forgets calls with no update for a while, whatever their status: a call can stay
 * `connecting` for good when no webhook subscription reports its end.
 */
function pruneCalls(): void {
  const cutoff = Date.now() - CALL_RETENTION_MS;
  for (const [id, call] of state.calls) {
    if (Date.parse(call.updatedAt) < cutoff) state.calls.delete(id);
  }
  if (state.calls.size <= CALL_LIMIT) return;
  const oldestFirst = Array.from(state.calls.values()).sort((a, b) =>
    a.updatedAt.localeCompare(b.updatedAt)
  );
  for (const call of oldestFirst.slice(0, state.calls.size - CALL_LIMIT))
    state.calls.delete(call.callId);
}

// Tokens ---------------------------------------------------------------------------

export function rememberToken(
  token: string,
  identity: string,
  expiresAt: string
): void {
  const now = Date.now();
  for (const [key, entry] of state.tokens) {
    if (entry.expiresAt < now) state.tokens.delete(key);
  }
  state.tokens.set(token, { identity, expiresAt: Date.parse(expiresAt) });
}

export function identityForToken(token: string): string | null {
  return state.tokens.get(token)?.identity ?? null;
}

// Logs -----------------------------------------------------------------------------

export function appendCallbackLog(entry: CallbackLogEntry): void {
  pushCapped(state.callbackLog, entry);
  publish({ type: "callback.question", entry });
}

export function appendWebhook(entry: WebhookInboxEntry): void {
  pushCapped(state.webhookInbox, entry);
  publish({ type: "webhook.received", entry });
}

export function appendTelemetry(entry: TelemetryBatchEntry): void {
  pushCapped(state.telemetry, entry);
  publish({ type: "telemetry.batch", entry });
}

function pushCapped<T>(list: T[], entry: T): void {
  list.unshift(entry);
  list.length = Math.min(list.length, LOG_LIMIT);
}

export function snapshot(routing: RoutingRules): StateSnapshot {
  return {
    presence: listPresence(),
    calls: listCalls(),
    callbackLog: state.callbackLog,
    webhookInbox: state.webhookInbox,
    telemetry: state.telemetry,
    routing,
  };
}

// Public tunnel ------------------------------------------------------------------------

export function tunnelInfo(): TunnelInfo {
  return state.tunnel;
}

/** The public URL is part of the configuration the screens show, so they reload it. */
export function setTunnelInfo(tunnel: TunnelInfo): void {
  state.tunnel = tunnel;
  publish({ type: "config.changed" });
}
