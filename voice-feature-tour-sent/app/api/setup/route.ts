import { NextResponse } from "next/server";
import type { AppConfig } from "@/lib/shared/types";
import {
  credentialsFor,
  currentPublicBaseUrl,
  readConfig,
  TUNNEL_NOT_OPEN,
  setupInputSchema,
  toPublicConfig,
  writeConfig,
} from "@/lib/server/config-store";
import { handleRouteError, jsonError, readJsonBody } from "@/lib/server/http";
import { assertSetupPassword } from "@/lib/server/setup-password";
import { getAccount, updateWebhookEndpoint } from "@/lib/server/sent-api";
import { webhookUrlFor } from "@/lib/shared/urls";
import { publish } from "@/lib/server/state";

export const dynamic = "force-dynamic";

/** The saved configuration with every secret masked. */
export async function GET() {
  try {
    return NextResponse.json(toPublicConfig(await readConfig()));
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Saves the configuration. The API key is checked against `GET /v3/me` before anything
 * is written, so a wrong key or base URL is refused here.
 */
export async function PUT(request: Request) {
  try {
    assertSetupPassword(request);
    const input = setupInputSchema.parse(await readJsonBody(request));
    const current = await readConfig();

    const credentials = credentialsFor(input, current);
    if (!credentials) return jsonError(400, "An API key is required");

    const callbackSigningSecret =
      input.callbackSigningSecret || current?.callbackSigningSecret || "";
    if (!callbackSigningSecret) {
      return jsonError(
        400,
        "The callback signing secret of the number is required"
      );
    }

    const publicBaseUrl = currentPublicBaseUrl();
    if (!publicBaseUrl) return jsonError(503, TUNNEL_NOT_OPEN);
    const warnings: string[] = [];
    if (!publicBaseUrl.startsWith("https://")) {
      warnings.push(
        "PUBLIC_BASE_URL is not HTTPS. Sent accepts it, but the browser phone on another device needs a secure context."
      );
    }

    const account = await getAccount(credentials);

    // The webhook follows the public URL, so a new tunnel URL does not stop the deliveries.
    let webhook = current?.webhook ?? null;
    if (webhook && current?.publicBaseUrl !== publicBaseUrl) {
      const endpointUrl = webhookUrlFor(publicBaseUrl);
      try {
        await updateWebhookEndpoint(credentials, webhook.id, endpointUrl);
        webhook = { ...webhook, endpointUrl };
      } catch (error) {
        webhook = null;
        warnings.push(
          `The webhook subscription could not be moved to the new public URL (${error instanceof Error ? error.message : String(error)}), so it was forgotten. Create it again from the Webhooks tab.`
        );
      }
    }

    const candidate: AppConfig = {
      ...credentials,
      phoneNumber: input.phoneNumber,
      callbackSigningSecret,
      publicBaseUrl,
      webhook,
      updatedAt: new Date().toISOString(),
    };

    await writeConfig(candidate);
    publish({ type: "config.changed" });

    return NextResponse.json({
      config: toPublicConfig(candidate),
      account,
      warnings,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
