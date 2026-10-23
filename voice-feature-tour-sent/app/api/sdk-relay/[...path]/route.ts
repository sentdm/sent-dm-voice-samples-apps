import type { TelemetryBatchEntry } from "@/lib/shared/types";
import { readConfig } from "@/lib/server/config-store";
import {
  buildUrl,
  DEFAULT_TIMEOUT_MS,
  USER_AGENT,
} from "@/lib/server/sent-api";
import { appendTelemetry, identityForToken } from "@/lib/server/state";
import { newId } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** The SDK's own routes on the Sent API, all authenticated with the voice token. */
const SDK_PREFIX = "v3/voice/";
const TELEMETRY_PATH = "v3/voice/telemetry";

/**
 * Relays the SDK's requests to Sent. The SDK is given `<origin>/api/sdk-relay` as its `baseURL`,
 * so its requests arrive here first, with the SDK's own path after the prefix: the token exchange
 * when it registers, then the telemetry batches. Each is forwarded with the same body and bearer
 * token to that path on the Sent API. Only telemetry batches are recorded for the Telemetry tab,
 * never the exchange, whose response holds a provider credential.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const startedAt = Date.now();
  const path = (await params).path.join("/");

  const config = await readConfig();
  if (!config)
    return new Response("The app is not set up yet", { status: 503 });

  // Compared once resolved, so a `..` segment cannot step outside the prefix.
  const target = buildUrl(config.apiBaseUrl, path);
  if (!target.startsWith(buildUrl(config.apiBaseUrl, SDK_PREFIX)))
    return new Response(`The relay does not forward /${path}`, { status: 404 });

  const rawBody = await request.text();
  const authorization = request.headers.get("authorization");
  const headers = new Headers({ "user-agent": USER_AGENT });
  if (authorization) headers.set("authorization", authorization);
  // The token exchange has no body, and the API refuses a Content-Type without one.
  if (rawBody) {
    headers.set(
      "content-type",
      request.headers.get("content-type") ?? "application/json"
    );
  }

  let status: number | null = null;
  let contentType: string | null = null;
  let responseBody = "";
  let forwardError: string | null = null;
  try {
    const forwarded = await fetch(target, {
      method: "POST",
      headers,
      body: rawBody || undefined,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      cache: "no-store",
    });
    status = forwarded.status;
    contentType = forwarded.headers.get("content-type");
    responseBody = await forwarded.text();
  } catch (error) {
    forwardError = error instanceof Error ? error.message : "Forwarding failed";
  }

  if (path === TELEMETRY_PATH) {
    appendTelemetry(
      telemetryEntry({
        rawBody,
        authorization,
        target,
        startedAt,
        status,
        forwardError,
      })
    );
  }

  return new Response(responseBody || null, {
    status: status ?? 502,
    headers: contentType ? { "content-type": contentType } : undefined,
  });
}

/** What the Telemetry tab shows for one forwarded batch. */
function telemetryEntry({
  rawBody,
  authorization,
  target,
  startedAt,
  status,
  forwardError,
}: {
  rawBody: string;
  authorization: string | null;
  target: string;
  startedAt: number;
  status: number | null;
  forwardError: string | null;
}): TelemetryBatchEntry {
  let batch: { sdk_version?: string; events?: { type?: string }[] } | null =
    null;
  try {
    batch = JSON.parse(rawBody);
  } catch {
    // Recorded anyway, with the error below.
  }
  const events = batch?.events ?? [];
  const token = authorization?.replace(/^Bearer\s+/i, "") ?? "";

  return {
    id: newId(),
    receivedAt: new Date(startedAt).toISOString(),
    identity: token ? identityForToken(token) : null,
    sdkVersion: batch?.sdk_version ?? null,
    eventCount: events.length,
    eventTypes: Array.from(
      new Set(events.map((event) => event.type ?? "unknown"))
    ),
    batch,
    forwardedTo: target,
    status,
    durationMs: Date.now() - startedAt,
    error: forwardError ?? (batch ? null : "The batch is not valid JSON"),
  };
}
