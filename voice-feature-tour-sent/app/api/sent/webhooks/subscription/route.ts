import { NextResponse } from "next/server";
import { z } from "zod";
import type { SavedWebhook, WebhookResponse } from "@/lib/shared/types";
import {
  currentPublicBaseUrl,
  requireConfig,
  toPublicConfig,
  updateConfig,
} from "@/lib/server/config-store";
import { webhookUrlFor } from "@/lib/shared/urls";
import { handleRouteError, jsonError, readJsonBody } from "@/lib/server/http";
import { assertSetupPassword } from "@/lib/server/setup-password";
import { sentData, webhookSettings } from "@/lib/server/sent-api";
import { publish } from "@/lib/server/state";

export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create") }),
  z.object({ action: z.literal("rotate") }),
  z.object({
    action: z.literal("use"),
    id: z.string().trim().min(1),
    signingSecret: z.string().trim().min(1),
  }),
  z.object({ action: z.literal("forget") }),
]);

/**
 * Manages the one webhook subscription this app receives call events on. `create` asks
 * Sent for a subscription on the `call` group pointing at this app and stores the secret
 * from the response, the only time Sent shows it. `use` stores a subscription created
 * elsewhere. `rotate` asks for a new secret and stores it.
 */
export async function POST(request: Request) {
  try {
    assertSetupPassword(request);
    const body = bodySchema.parse(await readJsonBody(request));
    const config = await requireConfig();

    switch (body.action) {
      case "create": {
        const endpointUrl = webhookUrlFor(
          currentPublicBaseUrl() || config.publicBaseUrl
        );
        const webhook = await sentData<WebhookResponse>(config, {
          method: "POST",
          path: "/v3/webhooks",
          body: webhookSettings(endpointUrl),
        });
        if (!webhook.signing_secret) {
          return jsonError(
            502,
            "Sent did not return a signing secret for the new webhook"
          );
        }
        return saved({
          id: webhook.id,
          endpointUrl: webhook.endpoint_url ?? endpointUrl,
          signingSecret: webhook.signing_secret,
        });
      }
      case "rotate": {
        if (!config.webhook)
          return jsonError(400, "No webhook subscription is stored yet");
        const rotated = await sentData<{ signing_secret?: string }>(config, {
          method: "POST",
          path: `/v3/webhooks/${encodeURIComponent(config.webhook.id)}/rotate-secret`,
        });
        if (!rotated.signing_secret) {
          return jsonError(
            502,
            "Sent did not return the rotated signing secret"
          );
        }
        return saved({
          ...config.webhook,
          signingSecret: rotated.signing_secret,
        });
      }
      case "use": {
        const webhook = await sentData<WebhookResponse>(config, {
          method: "GET",
          path: `/v3/webhooks/${encodeURIComponent(body.id)}`,
        });
        return saved({
          id: webhook.id,
          endpointUrl: webhook.endpoint_url,
          signingSecret: body.signingSecret,
        });
      }
      case "forget":
        return saved(null);
    }
  } catch (error) {
    return handleRouteError(error);
  }
}

async function saved(webhook: SavedWebhook | null) {
  const next = await updateConfig({ webhook });
  publish({ type: "config.changed" });
  return NextResponse.json(toPublicConfig(next));
}
