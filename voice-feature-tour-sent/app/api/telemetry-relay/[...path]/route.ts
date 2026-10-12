import type { TelemetryBatchEntry } from "@/lib/shared/types";
import { readConfig } from "@/lib/server/config-store";
import { buildUrl } from "@/lib/server/sent-api";
import { appendTelemetry, identityForToken } from "@/lib/server/state";
import { newId } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Telemetry relay. The SDK is given `<origin>/api/telemetry-relay` as its telemetry base URL,
 * so its batches arrive here first, with the SDK's own path after the prefix. The batch is
 * recorded for the Telemetry tab and forwarded unchanged, with the same bearer token, to
 * that path on the Sent API. Sent receives exactly what the SDK would have sent it directly.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const startedAt = Date.now();
  const { path } = await params;
  const rawBody = await request.text();
  const authorization = request.headers.get("authorization");
  const token = authorization?.replace(/^Bearer\s+/i, "") ?? "";

  const config = await readConfig();
  if (!config)
    return new Response("The app is not set up yet", { status: 503 });

  const target = buildUrl(config.apiBaseUrl, `/${path.join("/")}`);
  const entry: TelemetryBatchEntry = {
    id: newId(),
    receivedAt: new Date(startedAt).toISOString(),
    identity: token ? identityForToken(token) : null,
    sdkVersion: null,
    eventCount: 0,
    eventTypes: [],
    batch: null,
    forwardedTo: target,
    status: null,
    durationMs: 0,
    error: null,
  };

  try {
    const batch = JSON.parse(rawBody) as {
      sdk_version?: string;
      events?: { type?: string }[];
    };
    entry.batch = batch;
    entry.sdkVersion = batch.sdk_version ?? null;
    entry.eventCount = batch.events?.length ?? 0;
    entry.eventTypes = Array.from(
      new Set((batch.events ?? []).map((event) => event.type ?? "unknown"))
    );
  } catch {
    entry.error = "The batch is not valid JSON";
  }

  let status = 502;
  let responseBody = "";
  try {
    const forwarded = await fetch(target, {
      method: "POST",
      headers: {
        ...(authorization ? { authorization } : {}),
        "content-type":
          request.headers.get("content-type") ?? "application/json",
      },
      body: rawBody,
      cache: "no-store",
    });
    status = forwarded.status;
    responseBody = await forwarded.text();
    entry.status = status;
  } catch (error) {
    entry.error = error instanceof Error ? error.message : "Forwarding failed";
  }

  entry.durationMs = Date.now() - startedAt;
  appendTelemetry(entry);

  return new Response(responseBody || null, { status });
}
