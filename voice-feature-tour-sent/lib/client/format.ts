import type {
  TrackedCall,
  VoiceAddress,
  VoiceCallParty,
} from "@/lib/shared/types";

export function formatAddress(
  address: VoiceAddress | null | undefined
): string {
  if (!address) return "unknown";
  switch (address.kind) {
    case "user":
      return `${address.identity} (app user)`;
    case "number":
      return address.number;
    case "conference":
      return `room ${address.name}`;
    case "anonymous":
      return "withheld number";
  }
}

export function formatParty(party: VoiceCallParty | null | undefined): string {
  if (!party) return "unknown";
  if (party.kind === "anonymous") return "withheld number";
  if (party.kind === "user") return `${party.value ?? ""} (app user)`;
  if (party.kind === "conference") return `room ${party.value ?? ""}`;
  return party.value ?? party.kind;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, { hour12: false });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { hour12: false });
}

export function shortCallId(callId: string): string {
  return callId.length > 18
    ? `${callId.slice(0, 13)}...${callId.slice(-4)}`
    : callId;
}

export function callOtherParty(call: TrackedCall, identity: string): string {
  if (call.from.kind === "user" && call.from.identity === identity)
    return formatAddress(call.to);
  return formatAddress(call.from);
}

export function describeError(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as {
      code?: unknown;
      message?: unknown;
      name?: unknown;
    };
    const code = typeof record.code === "string" ? record.code : null;
    const message =
      typeof record.message === "string"
        ? record.message
        : String(record.name ?? "error");
    return code ? `${code}: ${message}` : message;
  }
  return String(error);
}

export function pretty(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2) ?? "";
}
