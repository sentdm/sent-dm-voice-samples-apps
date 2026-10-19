/**
 * Types shared by the browser and the server. Two wire formats meet here:
 *
 * - The Sent REST API and its webhooks use snake_case (`call_id`, `expires_at`).
 * - The callback contract (the questions Sent asks and the answers this app
 *   returns) uses camelCase (`callId`, `connectToUser`).
 */

// Configuration ------------------------------------------------------------------

/** Saved on the server in .data/config.json. Holds secrets, never sent to the browser as is. */
export interface AppConfig {
  /** Base URL of the Sent API, https://api.sent.dm unless you point it elsewhere. */
  apiBaseUrl: string;
  /** The customer's Sent API key. Used only on the server. */
  apiKey: string;
  /** One of the customer's voice-enabled numbers, in E.164. Tokens are bound to it. */
  phoneNumber: string;
  /** The `whsec_` secret the dashboard shows for that number. Signs the questions Sent sends. */
  callbackSigningSecret: string;
  /** The public URL the number and the webhook were set up with at the last save. */
  publicBaseUrl: string;
  /** The webhook subscription this app created for `call` events, if any. */
  webhook: SavedWebhook | null;
  updatedAt: string;
}

/** What a call to the Sent API needs. Connect uses it before anything is saved. */
export type SentCredentials = Pick<AppConfig, "apiBaseUrl" | "apiKey">;

/** The parts of `GET /v3/me` the setup screen shows. */
export interface AccountSummary {
  id: string | null;
  name: string | null;
  type: string | null;
  status: string | null;
}

/** `GET /v3/channels/voice`: one of the account's numbers with phone calls turned on. */
export interface VoiceNumberResponse {
  number: string;
  status: string;
  default_for_app_calls: boolean;
  callback_url: string | null;
}

export interface SavedWebhook {
  id: string;
  endpointUrl: string;
  signingSecret: string;
}

/** TUNNEL_PROVIDER: ngrok by default, or a Cloudflare quick tunnel. */
export type TunnelProvider = "ngrok" | "cloudflare";

/**
 * The public tunnel the server opens at start so Sent can reach it. `off` when PUBLIC_BASE_URL
 * names a fixed URL instead.
 */
export interface TunnelInfo {
  state: "off" | "opening" | "open" | "failed";
  /** Null while `off`, or when TUNNEL_PROVIDER has a value the app does not know. */
  provider: TunnelProvider | null;
  /** True when the URL stays the same on every start: an ngrok tunnel on NGROK_DOMAIN. */
  fixedUrl: boolean;
  url: string | null;
  error: string | null;
}

/** What the browser gets: the same settings with every secret masked. */
export interface PublicConfig {
  configured: boolean;
  apiBaseUrl: string;
  apiKeyMasked: string;
  phoneNumber: string;
  callbackSigningSecretMasked: string;
  /** Where Sent and other devices reach this app now: PUBLIC_BASE_URL or the tunnel's URL. */
  publicBaseUrl: string;
  /** True when the public URL is not the one saved, so the number and the webhook point elsewhere. */
  publicUrlChanged: boolean;
  tunnel: TunnelInfo;
  callbackUrl: string;
  webhookEndpointUrl: string;
  webhook: {
    id: string;
    endpointUrl: string;
    signingSecretMasked: string;
  } | null;
  updatedAt: string | null;
  /** True when SETUP_PASSWORD is set and configuration changes need it. */
  setupPasswordRequired: boolean;
}

// Callback contract: questions Sent asks ------------------------------------------

export type VoiceAddress =
  | { kind: "user"; identity: string }
  | { kind: "number"; number: string }
  | { kind: "anonymous" }
  | { kind: "conference"; name: string };

export type CallDirection = "outbound" | "inbound";

export interface CallRequestQuestion {
  version: string;
  type: "call.request";
  callId: string;
  number: string;
  timestamp: string;
  direction: CallDirection;
  from: VoiceAddress;
  to: VoiceAddress;
  /** Only on the test question `POST /v3/channels/voice/{number}/test` sends. */
  test?: boolean;
}

export interface CallInputQuestion {
  version: string;
  type: "call.input";
  callId: string;
  number: string;
  timestamp: string;
  /** What the caller pressed. Empty when the menu timed out. */
  digits: string;
  /** Everything earlier `setCookie` instructions stored on this call. */
  cookies?: Record<string, string>;
}

export type VoiceQuestion = CallRequestQuestion | CallInputQuestion;

// Callback contract: answers this app returns --------------------------------------

export type VoiceInstruction =
  | { instruction: "say"; text: string; locale?: string }
  | { instruction: "play"; url: string }
  | { instruction: "sendDigits"; digits: string }
  | { instruction: "startRecording" }
  | { instruction: "stopRecording" }
  | { instruction: "answer" }
  | { instruction: "setCookie"; key: string; value: string };

export type VoiceInstructionName = VoiceInstruction["instruction"];

export interface VoicePrompt {
  text: string;
}

export type VoiceRejectReason = "busy" | "declined";

export type VoiceAction =
  | { action: "connectToUser"; identity: string; record?: boolean }
  | {
      action: "connectToNumber";
      number: string;
      callerId?: string;
      dialTimeoutSeconds?: number;
      record?: boolean;
    }
  | { action: "connectToConference"; name: string; record?: boolean }
  | {
      action: "playMenu";
      prompt: VoicePrompt;
      maxDigits?: number;
      timeoutSeconds?: number;
      repeats?: number;
    }
  | {
      action: "park";
      introPrompt?: VoicePrompt;
      holdPrompt?: VoicePrompt;
      maxDurationSeconds?: number;
    }
  | { action: "hangup" }
  | { action: "reject"; reason: VoiceRejectReason };

export interface VoiceAnswer {
  instructions?: VoiceInstruction[];
  action: VoiceAction;
}

// Routing rules: how the callback decides -------------------------------------------

export type RoutingMode =
  | "smart"
  | "user"
  | "number"
  | "conference"
  | "menu"
  | "park"
  | "reject"
  | "hangup";

export type MenuOptionAction =
  "user" | "number" | "conference" | "park" | "hangup" | "menu";

export interface MenuOption {
  digits: string;
  action: MenuOptionAction;
  /** The identity, number or room name the option connects to. Empty means "the first online app user". */
  value: string;
}

export interface RoutingRules {
  mode: RoutingMode;
  /** Adds `record: true` to every connect answer. App-to-app calls are not recorded. */
  record: boolean;
  /**
   * Answers with a room named after the call and dials the intended party into it right after, so
   * participants and transfer work on every call. Applies to the smart, user and number modes.
   */
  roomPerCall: boolean;
  /** Caller id for phone legs. Empty uses the call's owning number. Must be a number the account owns. */
  callerId: string;
  dialTimeoutSeconds: number | null;
  smart: {
    /** Phone number to dial when the app user is offline. Empty rejects the call as busy. */
    fallbackNumber: string;
    /** App user that rings on inbound calls. Empty rings the first online app user. */
    inboundIdentity: string;
  };
  forced: {
    identity: string;
    number: string;
    conferenceName: string;
  };
  menu: {
    prompt: string;
    maxDigits: number;
    timeoutSeconds: number;
    repeats: number;
    invalidText: string;
    goodbyeText: string;
    maxAttempts: number;
    options: MenuOption[];
  };
  park: {
    introPrompt: string;
    holdPrompt: string;
    maxDurationSeconds: number;
  };
  reject: {
    reason: VoiceRejectReason;
  };
  /** Run before the action on every `call.request` answer. */
  instructions: VoiceInstruction[];
}

// Sent REST API (snake_case) -----------------------------------------------------------

export interface ApiMeta {
  request_id: string;
  timestamp: string;
  version: string;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, string[]>;
  doc_url?: string;
}

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: ApiMeta;
}

export interface PaginationMeta {
  page: number;
  page_size: number;
  total_count: number;
  total_pages: number;
  has_more: boolean;
}

export interface VoiceTokenResponse {
  token: string;
  identity: string;
  number: string;
  expires_at: string;
}

export interface VoiceCallParty {
  kind: "user" | "number" | "anonymous" | "conference" | string;
  value: string | null;
}

export type VoiceCallStatus =
  | "INITIATED"
  | "RINGING"
  | "ANSWERED"
  | "COMPLETED"
  | "FAILED"
  | "NO_ANSWER"
  | "REJECTED";

export interface VoiceCallRecord {
  id: string;
  direction: CallDirection;
  from: VoiceCallParty;
  to: VoiceCallParty;
  number: string;
  status: VoiceCallStatus | string;
  failure_reason: string | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  price: number | null;
  recording_available: boolean;
  timeline?: { status: string; timestamp: string }[];
}

export interface VoiceCallsListResponse {
  calls: VoiceCallRecord[];
  pagination: PaginationMeta;
}

export interface VoiceParticipantResponse {
  id: string;
  kind: string;
  value: string | null;
  muted: boolean;
  duration_seconds: number;
}

export interface VoiceRecordingResponse {
  /** The id the call.recording_ready webhook announced this recording under. */
  recording_id: string;
  download_url: string;
  url_expires_at: string;
}

/** `GET /v3/calls/{id}/recordings`: one item per recording, oldest first. */
export interface VoiceRecordingsResponse {
  recordings: VoiceRecordingResponse[];
}

export interface WebhookResponse {
  id: string;
  customer_id?: string;
  display_name: string;
  endpoint_url: string;
  signing_secret?: string;
  is_active: boolean;
  event_types: string[];
  event_filters?: Record<string, string[]> | null;
  retry_count: number;
  timeout_seconds: number;
  created_at?: string;
  updated_at?: string;
}

// Webhooks Sent delivers (snake_case) ---------------------------------------------------

export interface CallWebhookPayload {
  /** The account the call belongs to. */
  account_id: string;
  call_id: string;
  /** Always "voice". */
  channel: string;
  number: string;
  /** The call's status, upper-case (INITIATED ... REJECTED). */
  status: string;
  /** When the change happened on the call. */
  updated_at: string;
  /** Only on call.completed */
  duration_seconds?: number;
  /** Only on call.completed, once billing recorded it */
  price?: number;
  /** Only on call.failed. `callback_not_configured` means the number had no callback URL. */
  reason?: string | null;
  /** Only on call.recording_ready: the id `GET /v3/calls/{id}/recordings` lists the recording under. */
  recording_id?: string;
}

export interface WebhookEnvelope<T = unknown> {
  field: string;
  event: string;
  timestamp: string;
  request_id?: string;
  payload: T;
}

// Runtime state the server keeps and streams to the browser ------------------------------

export type SignatureStatus = "valid" | "invalid" | "missing" | "unverified";

export interface CallbackLogEntry {
  id: string;
  receivedAt: string;
  requestId: string | null;
  retry: boolean;
  signature: SignatureStatus;
  signatureDetail: string | null;
  question: VoiceQuestion | null;
  rawBody: string;
  answer: VoiceAnswer | null;
  explanation: string;
  statusCode: number;
  durationMs: number;
}

export interface WebhookInboxEntry {
  id: string;
  receivedAt: string;
  signature: SignatureStatus;
  signatureDetail: string | null;
  event: string | null;
  envelope: WebhookEnvelope | null;
  rawBody: string;
  statusCode: number;
}

export interface TelemetryBatchEntry {
  id: string;
  receivedAt: string;
  identity: string | null;
  sdkVersion: string | null;
  eventCount: number;
  eventTypes: string[];
  batch: unknown;
  forwardedTo: string;
  status: number | null;
  durationMs: number;
  error: string | null;
}

export interface PresenceEntry {
  identity: string;
  online: boolean;
  lastSeenAt: string;
  clientState: string | null;
}

export type TrackedCallStatus =
  | "asking"
  | "connecting"
  | "answered"
  | "completed"
  | "failed"
  | "rejected"
  | "no_answer";

/**
 * What this app knows about a call, put together from the question Sent asked,
 * the answer this app gave, and the webhooks that followed. The `call_` id is
 * only visible server-side, so this is how the phone screen learns it.
 */
export interface TrackedCall {
  callId: string;
  number: string;
  direction: CallDirection;
  from: VoiceAddress;
  to: VoiceAddress;
  /** App users involved: the caller, the callee the answer rang, and menu targets. */
  identities: string[];
  /** Room legs by identity: the participant call id each app user is in the room with. */
  legs: Record<string, string>;
  conferenceName: string | null;
  status: TrackedCallStatus;
  answer: VoiceAction | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  price: number | null;
  failureReason: string | null;
  recordingAvailable: boolean;
  test: boolean;
  /** Room per call: the party the server dials into the room after answering, and how that went. */
  followUp: CallFollowUp | null;
}

/** Who a participant command dials: an app user by identity, or a phone number. */
export interface ParticipantTarget {
  kind: "user" | "number";
  value: string;
}

export interface CallFollowUp {
  target: ParticipantTarget;
  status: "pending" | "done" | "failed";
  participantId: string | null;
  message: string | null;
}

export interface StateSnapshot {
  presence: PresenceEntry[];
  calls: TrackedCall[];
  callbackLog: CallbackLogEntry[];
  webhookInbox: WebhookInboxEntry[];
  telemetry: TelemetryBatchEntry[];
  routing: RoutingRules;
}

export type AppEvent =
  | { type: "callback.question"; entry: CallbackLogEntry }
  | { type: "webhook.received"; entry: WebhookInboxEntry }
  | { type: "telemetry.batch"; entry: TelemetryBatchEntry }
  | { type: "presence.changed"; presence: PresenceEntry[] }
  | { type: "call.updated"; call: TrackedCall }
  | { type: "routing.changed"; rules: RoutingRules }
  | { type: "config.changed" };

export type AppEventMessage = AppEvent & { id: number; at: string };

// Requests the browser makes to this app's own API --------------------------------------------

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface TransferResult {
  participantId: string;
  steps: string[];
}

export interface ProxyRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface ProxyResponse {
  ok: boolean;
  status: number;
  url: string;
  durationMs: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  body: unknown;
  rawBody: string;
}
