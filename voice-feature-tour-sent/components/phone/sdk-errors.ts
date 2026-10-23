import { SentVoiceError } from "@sentdm/voice-client";
import { toast } from "sonner";
import { describeError } from "@/lib/client/format";
import type { PhoneLog } from "./phone-log";

/**
 * The details the event log shows for an SDK error. Titles and toasts use `describeError`, which
 * puts the stable code first and the message after.
 * The underlying error is not on it: the SDK keeps that to itself and reports it to Sent in
 * telemetry.
 */
export function errorDetail(error: unknown): Record<string, unknown> {
  if (error instanceof SentVoiceError) {
    return {
      code: error.code,
      category: error.category,
      retriable: error.retriable,
      message: error.message,
    };
  }
  if (error instanceof Error)
    return { name: error.name, message: error.message };
  return { error: String(error) };
}

/** A failed SDK action: logged with its details and shown as a toast. */
export function reportSdkError(
  log: PhoneLog,
  title: string,
  error: unknown
): void {
  log.push({
    kind: "error",
    title: `${title}: ${describeError(error)}`,
    detail: errorDetail(error),
  });
  toast.error(describeError(error));
}
