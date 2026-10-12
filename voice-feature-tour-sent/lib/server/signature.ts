import { createHmac, timingSafeEqual } from "node:crypto";
import type { SignatureStatus } from "@/lib/shared/types";

/**
 * Verifies the signature Sent puts on the questions it asks and on the webhooks it
 * delivers. Both use the same scheme, so this one function covers both:
 *
 *   signed content = `${X-Webhook-ID}.${X-Webhook-Timestamp}.${raw body}`
 *   key            = Base64-decode(secret without the `whsec_` prefix)
 *   header         = `X-Webhook-Signature: v1,${Base64(HMAC-SHA256(key, signed content))}`
 *
 * The timestamp is unix seconds and is refused when it is too far from now, which
 * stops a captured request from being replayed later.
 */

export interface SignatureHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export type SignatureVerdict =
  | { ok: true; detail: null }
  | {
      ok: false;
      reason:
        | "no_secret"
        | "missing_headers"
        | "bad_secret"
        | "timestamp_out_of_range"
        | "mismatch";
      detail: string;
    };

/** What the callback studio and the webhooks inbox show for a verdict. */
export function signatureStatusOf(verdict: SignatureVerdict): SignatureStatus {
  if (verdict.ok) return "valid";
  if (verdict.reason === "missing_headers") return "missing";
  if (verdict.reason === "no_secret") return "unverified";
  return "invalid";
}

const SECRET_PREFIX = "whsec_";
const DEFAULT_TOLERANCE_SECONDS = 300;

export function readSignatureHeaders(headers: Headers): SignatureHeaders {
  return {
    id: headers.get("x-webhook-id"),
    timestamp: headers.get("x-webhook-timestamp"),
    signature: headers.get("x-webhook-signature"),
  };
}

export function verifySentSignature(
  headers: SignatureHeaders,
  rawBody: string,
  secret: string | null | undefined,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS
): SignatureVerdict {
  if (!secret) {
    return {
      ok: false,
      reason: "no_secret",
      detail: "No signing secret is configured for this endpoint.",
    };
  }
  if (!headers.id || !headers.timestamp || !headers.signature) {
    return {
      ok: false,
      reason: "missing_headers",
      detail:
        "X-Webhook-ID, X-Webhook-Timestamp and X-Webhook-Signature are all required.",
    };
  }

  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp)) {
    return {
      ok: false,
      reason: "timestamp_out_of_range",
      detail: `X-Webhook-Timestamp "${headers.timestamp}" is not a number.`,
    };
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (skew > toleranceSeconds) {
    return {
      ok: false,
      reason: "timestamp_out_of_range",
      detail: `The timestamp is ${skew} seconds away from now; the limit is ${toleranceSeconds}.`,
    };
  }

  const key = Buffer.from(
    secret.startsWith(SECRET_PREFIX)
      ? secret.slice(SECRET_PREFIX.length)
      : secret,
    "base64"
  );
  if (key.length === 0) {
    return {
      ok: false,
      reason: "bad_secret",
      detail: "The configured secret is not valid Base64.",
    };
  }

  const expected = createHmac("sha256", key)
    .update(`${headers.id}.${headers.timestamp}.${rawBody}`)
    .digest();

  // The header may carry several space-separated signatures during a rotation.
  const candidates = headers.signature
    .split(/\s+/)
    .filter((part) => part.startsWith("v1,"))
    .map((part) => part.slice(3));

  for (const candidate of candidates) {
    const provided = Buffer.from(candidate, "base64");
    if (
      provided.length === expected.length &&
      timingSafeEqual(provided, expected)
    ) {
      return { ok: true, detail: null };
    }
  }

  return {
    ok: false,
    reason: "mismatch",
    detail:
      candidates.length === 0
        ? "The signature header carries no v1 signature."
        : "The signature does not match the body, id and timestamp.",
  };
}
