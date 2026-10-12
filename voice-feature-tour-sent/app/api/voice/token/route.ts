import { z } from "zod";
import { requireConfig } from "@/lib/server/config-store";
import { IDENTITY_PATTERN } from "@/lib/shared/validation";
import { handleRouteError, readJsonBody } from "@/lib/server/http";
import { mintVoiceToken } from "@/lib/server/sent-api";
import { rememberToken } from "@/lib/server/state";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  identity: z
    .string()
    .regex(
      IDENTITY_PATTERN,
      "Letters, digits, - and _ only, up to 200 characters"
    ),
  ttl: z.number().int().min(1).max(3600).optional(),
});

/**
 * The SDK's `tokenProvider` calls this. The backend holds the API key, asks Sent for a
 * token bound to the configured number and returns the token as plain text, which is what
 * the SDK expects. Called at register() and again before every expiry.
 */
export async function POST(request: Request) {
  try {
    const { identity, ttl } = bodySchema.parse(await readJsonBody(request));
    const config = await requireConfig();
    const token = await mintVoiceToken(config, identity, ttl);
    rememberToken(token.token, token.identity, token.expires_at);
    return new Response(token.token, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-voice-token-expires-at": token.expires_at,
        "x-voice-token-number": token.number,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
