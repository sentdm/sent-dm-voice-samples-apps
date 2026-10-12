import type { TrackedCall } from "./types";

/** How many entries each log in the state snapshot keeps, on the server and in the browser. */
export const LOG_LIMIT = 200;

export function isLive(call: TrackedCall): boolean {
  return (
    call.status === "asking" ||
    call.status === "connecting" ||
    call.status === "answered"
  );
}

export function newestFirst(a: TrackedCall, b: TrackedCall): number {
  return b.startedAt.localeCompare(a.startedAt);
}
