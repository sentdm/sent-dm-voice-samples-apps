import type { HttpMethod } from "./types";

/**
 * Every public endpoint the API explorer offers. The explorer renders a form from these
 * definitions and sends the request through the server proxy, which adds the API key.
 * Field names with dots build nested body objects (`to.kind` becomes `{ to: { kind } }`).
 */

export type FieldLocation = "path" | "query" | "body";
export type FieldType =
  "string" | "number" | "boolean" | "enum" | "json" | "list";

export interface EndpointField {
  name: string;
  in: FieldLocation;
  type: FieldType;
  required?: boolean;
  description?: string;
  placeholder?: string;
  default?: string | number | boolean;
  options?: string[];
}

export interface EndpointDefinition {
  id: string;
  group: "account" | "voice" | "webhooks";
  method: HttpMethod;
  path: string;
  summary: string;
  description: string;
  fields: EndpointField[];
}

const callIdField: EndpointField = {
  name: "id",
  in: "path",
  type: "string",
  required: true,
  placeholder: "call_9f2ab000-0000-4000-8000-000000000001",
  description:
    "The call id from the callback question, a webhook or the calls list",
};

const participantIdField: EndpointField = {
  name: "participantId",
  in: "path",
  type: "string",
  required: true,
  placeholder: "call_9f2ab000-0000-4000-8000-000000000002",
  description:
    "The participant's own call id, as listed by the participants endpoint",
};

const numberPathField: EndpointField = {
  name: "number",
  in: "path",
  type: "string",
  required: true,
  placeholder: "+14155551234",
  description:
    "One of your voice numbers in E.164; the plus sign is URL-encoded",
};

const webhookIdField: EndpointField = {
  name: "id",
  in: "path",
  type: "string",
  required: true,
  description: "The webhook id",
};

const pagingFields: EndpointField[] = [
  { name: "page", in: "query", type: "number", default: 1 },
  {
    name: "page_size",
    in: "query",
    type: "number",
    default: 20,
    description: "1 to 100",
  },
];

export const API_CATALOG: EndpointDefinition[] = [
  {
    id: "account.me",
    group: "account",
    method: "GET",
    path: "/v3/me",
    summary: "Get the account",
    description:
      "The account the API key belongs to. The setup screen uses it to validate the key.",
    fields: [],
  },
  {
    id: "voice.tokens.create",
    group: "voice",
    method: "POST",
    path: "/v3/voice/tokens",
    summary: "Create a voice token",
    description:
      "Mints a short-lived token for one of your app users. Your backend calls this and hands the token to the SDK unchanged: it is an opaque vt_ string the SDK exchanges with Sent. The response also carries the identity, number and expires_at. Omit number to bind the identity to your default voice number.",
    fields: [
      {
        name: "identity",
        in: "body",
        type: "string",
        required: true,
        placeholder: "agent-42",
        description: "Letters, digits, - and _, up to 200 characters",
      },
      {
        name: "number",
        in: "body",
        type: "string",
        placeholder: "+14155551234",
        description: "One of your numbers with phone calls turned on, in E.164",
      },
      {
        name: "ttl",
        in: "body",
        type: "number",
        placeholder: "600",
        description: "Seconds, 1 to 3600, default 600",
      },
    ],
  },
  {
    id: "voice.channels.create",
    group: "voice",
    method: "POST",
    path: "/v3/channels/voice",
    summary: "Turn phone calls on for a number",
    description:
      "Adds voice to one of the numbers you hold, with the callback URL Sent asks what to do with each call. The 201 response carries the callback_secret once; the same number again with another callback_url updates the URL.",
    fields: [
      {
        name: "number",
        in: "body",
        type: "string",
        required: true,
        placeholder: "+14155551234",
        description: "One of your numbers in E.164",
      },
      {
        name: "callback_url",
        in: "body",
        type: "string",
        required: true,
        placeholder: "https://example.com/api/voice/callback",
        description:
          "Absolute http or https URL on a public address; this app's is on the setup screen",
      },
      {
        name: "default_for_app_calls",
        in: "body",
        type: "boolean",
        default: false,
        description: "Make this the line app-originated calls are placed from",
      },
    ],
  },
  {
    id: "voice.channels.rotateSecret",
    group: "voice",
    method: "POST",
    path: "/v3/channels/voice/{number}/rotate-secret",
    summary: "Rotate a number's callback secret",
    description:
      "Issues a new callback_secret for the number. The old one stops signing at once; paste the new one into the setup screen.",
    fields: [numberPathField],
  },
  {
    id: "voice.channels.test",
    group: "voice",
    method: "POST",
    path: "/v3/channels/voice/{number}/test",
    summary: "Test a number's callback URL",
    description:
      "Sends a signed synthetic call.request to the number's callback URL and reports the verdict: what was sent, what came back, and what was wrong when the answer was not usable. No call is placed.",
    fields: [numberPathField],
  },
  {
    id: "voice.calls.list",
    group: "voice",
    method: "GET",
    path: "/v3/voice/calls",
    summary: "List calls",
    description: "Your calls, most recent first, with filters.",
    fields: [
      ...pagingFields,
      {
        name: "direction",
        in: "query",
        type: "enum",
        options: ["", "outbound", "inbound"],
      },
      {
        name: "status",
        in: "query",
        type: "enum",
        options: [
          "",
          "INITIATED",
          "RINGING",
          "ANSWERED",
          "COMPLETED",
          "FAILED",
          "NO_ANSWER",
          "REJECTED",
        ],
        description: "Upper-case; the API accepts any casing",
      },
      {
        name: "number",
        in: "query",
        type: "string",
        placeholder: "+14155551234",
        description: "The owning number",
      },
      {
        name: "from",
        in: "query",
        type: "string",
        placeholder: "2026-09-24T00:00:00Z",
        description: "Started at or after (ISO 8601)",
      },
      {
        name: "to",
        in: "query",
        type: "string",
        placeholder: "2026-09-25T00:00:00Z",
        description: "Started at or before (ISO 8601)",
      },
    ],
  },
  {
    id: "voice.calls.get",
    group: "voice",
    method: "GET",
    path: "/v3/voice/calls/{id}",
    summary: "Get a call",
    description:
      "One call with its parties, owning number, status, failure reason, price and status timeline.",
    fields: [callIdField],
  },
  {
    id: "voice.calls.hangup",
    group: "voice",
    method: "POST",
    path: "/v3/voice/calls/{id}/hangup",
    summary: "Hang up a call",
    description: "Ends one of your live calls. Answers 204.",
    fields: [callIdField],
  },
  {
    id: "voice.calls.record",
    group: "voice",
    method: "POST",
    path: "/v3/voice/calls/{id}/recordings",
    summary: "Start or stop recording",
    description:
      "Starts or stops recording a live call. The recording is announced by the call.recording_ready webhook. Answers 204.",
    fields: [
      callIdField,
      {
        name: "action",
        in: "body",
        type: "enum",
        required: true,
        options: ["start", "stop"],
        default: "start",
      },
    ],
  },
  {
    id: "voice.calls.recordings",
    group: "voice",
    method: "GET",
    path: "/v3/voice/calls/{id}/recordings",
    summary: "List call recordings",
    description:
      "The call's recordings as { recordings: [ { recording_id, download_url, url_expires_at } ] }, one item per recording, oldest first; recording_id is the id the call.recording_ready webhook carried. Each pre-signed link is valid until url_expires_at.",
    fields: [callIdField],
  },
  {
    id: "voice.participants.add",
    group: "voice",
    method: "POST",
    path: "/v3/voice/calls/{id}/participants",
    summary: "Add a participant",
    description:
      "Dials one of your app users or a phone number into the room a live call is in. Answers 202 with the participant's own call record. The call must already be in a room.",
    fields: [
      callIdField,
      {
        name: "to.kind",
        in: "body",
        type: "enum",
        required: true,
        options: ["user", "number"],
        default: "user",
      },
      {
        name: "to.value",
        in: "body",
        type: "string",
        required: true,
        placeholder: "agent-42 or +14155551234",
      },
      {
        name: "caller_id",
        in: "body",
        type: "string",
        placeholder: "+14155551234",
        description:
          "Shown to a phone participant. Must be one of your numbers",
      },
    ],
  },
  {
    id: "voice.participants.list",
    group: "voice",
    method: "GET",
    path: "/v3/voice/calls/{id}/participants",
    summary: "List participants",
    description:
      "Who is in the room a live call is in, with each participant's own call id and muted state.",
    fields: [callIdField],
  },
  {
    id: "voice.participants.mute",
    group: "voice",
    method: "PATCH",
    path: "/v3/voice/calls/{id}/participants/{participantId}",
    summary: "Mute or unmute a participant",
    description: "Body { muted: true | false }. Answers 204.",
    fields: [
      callIdField,
      participantIdField,
      {
        name: "muted",
        in: "body",
        type: "boolean",
        required: true,
        default: true,
      },
    ],
  },
  {
    id: "voice.participants.remove",
    group: "voice",
    method: "DELETE",
    path: "/v3/voice/calls/{id}/participants/{participantId}",
    summary: "Remove a participant",
    description: "Removes one participant from the room. Answers 204.",
    fields: [callIdField, participantIdField],
  },
  {
    id: "voice.participants.removeAll",
    group: "voice",
    method: "DELETE",
    path: "/v3/voice/calls/{id}/participants",
    summary: "Remove every participant",
    description: "Empties the room, the call itself included. Answers 204.",
    fields: [callIdField],
  },
  {
    id: "webhooks.eventTypes",
    group: "webhooks",
    method: "GET",
    path: "/v3/webhooks/event-types",
    summary: "List event types",
    description: "The event catalog, with the call group and its sub-types.",
    fields: [],
  },
  {
    id: "webhooks.list",
    group: "webhooks",
    method: "GET",
    path: "/v3/webhooks",
    summary: "List webhooks",
    description: "Your webhook subscriptions.",
    fields: [
      ...pagingFields,
      { name: "search", in: "query", type: "string" },
      {
        name: "is_active",
        in: "query",
        type: "enum",
        options: ["", "true", "false"],
      },
    ],
  },
  {
    id: "webhooks.create",
    group: "webhooks",
    method: "POST",
    path: "/v3/webhooks",
    summary: "Create a webhook",
    description:
      "Subscribes an endpoint to event types. The response carries the signing secret once.",
    fields: [
      {
        name: "display_name",
        in: "body",
        type: "string",
        required: true,
        default: "Sent voice feature tour",
      },
      {
        name: "endpoint_url",
        in: "body",
        type: "string",
        required: true,
        placeholder: "https://example.com/webhooks",
      },
      {
        name: "event_types",
        in: "body",
        type: "list",
        required: true,
        default: "call",
        description: "Comma separated, for example call",
      },
      {
        name: "event_filters",
        in: "body",
        type: "json",
        placeholder: '{"call": ["completed", "failed"]}',
        description: "Optional sub-type filter per group",
      },
      { name: "retry_count", in: "body", type: "number", default: 3 },
      { name: "timeout_seconds", in: "body", type: "number", default: 30 },
    ],
  },
  {
    id: "webhooks.get",
    group: "webhooks",
    method: "GET",
    path: "/v3/webhooks/{id}",
    summary: "Get a webhook",
    description: "One subscription.",
    fields: [webhookIdField],
  },
  {
    id: "webhooks.update",
    group: "webhooks",
    method: "PUT",
    path: "/v3/webhooks/{id}",
    summary: "Update a webhook",
    description: "Replaces the subscription's settings.",
    fields: [
      webhookIdField,
      { name: "display_name", in: "body", type: "string", required: true },
      { name: "endpoint_url", in: "body", type: "string", required: true },
      {
        name: "event_types",
        in: "body",
        type: "list",
        required: true,
        default: "call",
      },
      { name: "event_filters", in: "body", type: "json" },
      { name: "retry_count", in: "body", type: "number", default: 3 },
      { name: "timeout_seconds", in: "body", type: "number", default: 30 },
    ],
  },
  {
    id: "webhooks.delete",
    group: "webhooks",
    method: "DELETE",
    path: "/v3/webhooks/{id}",
    summary: "Delete a webhook",
    description: "Removes the subscription.",
    fields: [webhookIdField],
  },
  {
    id: "webhooks.toggle",
    group: "webhooks",
    method: "PATCH",
    path: "/v3/webhooks/{id}/toggle-status",
    summary: "Enable or disable a webhook",
    description: "Pauses or resumes deliveries.",
    fields: [
      webhookIdField,
      {
        name: "is_active",
        in: "body",
        type: "boolean",
        required: true,
        default: true,
      },
    ],
  },
  {
    id: "webhooks.rotateSecret",
    group: "webhooks",
    method: "POST",
    path: "/v3/webhooks/{id}/rotate-secret",
    summary: "Rotate the signing secret",
    description: "Issues a new secret. The old one stops working at once.",
    fields: [webhookIdField],
  },
  {
    id: "webhooks.test",
    group: "webhooks",
    method: "POST",
    path: "/v3/webhooks/{id}/test",
    summary: "Send a test event",
    description:
      "Delivers a sample event of the given type to the subscription's endpoint.",
    fields: [
      webhookIdField,
      {
        name: "event_type",
        in: "body",
        type: "string",
        required: true,
        default: "call.completed",
      },
    ],
  },
  {
    id: "webhooks.events",
    group: "webhooks",
    method: "GET",
    path: "/v3/webhooks/{id}/events",
    summary: "List delivery attempts",
    description:
      "The events delivered to the subscription and how each delivery went.",
    fields: [
      webhookIdField,
      ...pagingFields,
      { name: "search", in: "query", type: "string" },
    ],
  },
];

/** Path patterns the server proxy forwards. Anything else is refused. */
export const PROXY_ALLOWLIST: RegExp[] = [
  /^\/v3\/me$/,
  /^\/v3\/channels\/voice$/,
  /^\/v3\/channels\/voice\/[A-Za-z0-9%+_-]+\/(rotate-secret|test)$/,
  /^\/v3\/voice\/tokens$/,
  /^\/v3\/voice\/calls$/,
  /^\/v3\/voice\/calls\/[A-Za-z0-9_-]+$/,
  /^\/v3\/voice\/calls\/[A-Za-z0-9_-]+\/(hangup|recordings|participants)$/,
  /^\/v3\/voice\/calls\/[A-Za-z0-9_-]+\/participants\/[A-Za-z0-9_-]+$/,
  /^\/v3\/webhooks$/,
  /^\/v3\/webhooks\/event-types$/,
  /^\/v3\/webhooks\/[A-Za-z0-9_-]+$/,
  /^\/v3\/webhooks\/[A-Za-z0-9_-]+\/(events|rotate-secret|test|toggle-status)$/,
];

export function isProxyPathAllowed(path: string): boolean {
  return PROXY_ALLOWLIST.some((pattern) => pattern.test(path));
}
