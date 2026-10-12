import { NextResponse } from "next/server";
import { z } from "zod";
import {
  credentialsFor,
  credentialsInputSchema,
  currentPublicBaseUrl,
  readConfig,
  TUNNEL_NOT_OPEN,
} from "@/lib/server/config-store";
import { handleRouteError, jsonError, readJsonBody } from "@/lib/server/http";
import { assertSetupPassword } from "@/lib/server/setup-password";
import { routeVoiceNumber } from "@/lib/server/sent-api";
import { callbackUrlFor } from "@/lib/shared/urls";
import { E164_PATTERN } from "@/lib/shared/validation";

export const dynamic = "force-dynamic";

const bodySchema = credentialsInputSchema.extend({
  number: z.string().trim().regex(E164_PATTERN),
});

/**
 * Route to this app on the setup screen: sets the number's callback URL to this app's with
 * `POST /v3/channels/voice`. Sent answers with the number's callback secret, which goes back
 * to the setup form so Save stores it with the rest.
 */
export async function POST(request: Request) {
  try {
    assertSetupPassword(request);
    const input = bodySchema.parse(await readJsonBody(request));
    const credentials = credentialsFor(input, await readConfig());
    if (!credentials) return jsonError(400, "An API key is required");
    const publicBaseUrl = currentPublicBaseUrl();
    if (!publicBaseUrl) return jsonError(503, TUNNEL_NOT_OPEN);

    const { callback_secret: callbackSecret, ...number } =
      await routeVoiceNumber(
        credentials,
        input.number,
        callbackUrlFor(publicBaseUrl)
      );
    if (!callbackSecret) {
      return jsonError(502, "Sent did not return the number's callback secret");
    }
    return NextResponse.json({ number, callbackSecret });
  } catch (error) {
    return handleRouteError(error);
  }
}
