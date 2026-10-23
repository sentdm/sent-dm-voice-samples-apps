import { NextResponse } from "next/server";
import { z } from "zod";
import { HTTP_METHODS, type ProxyResponse } from "@/lib/shared/types";
import { isProxyPathAllowed } from "@/lib/shared/api-catalog";
import { mask, requireConfig } from "@/lib/server/config-store";
import { handleRouteError, jsonError, readJsonBody } from "@/lib/server/http";
import { callSentApi } from "@/lib/server/sent-api";
import { assertSetupPassword } from "@/lib/server/setup-password";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  method: z.enum(HTTP_METHODS),
  path: z.string().startsWith("/v3/"),
  query: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
});

/**
 * The API explorer's way to the Sent API. The browser never holds the API key: it sends the
 * request it wants to make, the server adds the key and forwards it to the Sent API, and
 * everything about the exchange comes back for display.
 */
export async function POST(request: Request) {
  try {
    const input = bodySchema.parse(await readJsonBody(request));
    const path = input.path.split("?")[0];
    if (!isProxyPathAllowed(path)) {
      return jsonError(403, `The proxy does not forward ${path}`);
    }
    // Calls that change configuration, such as webhooks and voice channels, need the setup
    // password. The call commands stay open.
    if (input.method !== "GET" && !path.startsWith("/v3/voice/calls/"))
      assertSetupPassword(request);

    const config = await requireConfig();
    const result = await callSentApi(config, {
      method: input.method,
      path,
      query: input.query,
      body: input.body,
    });

    const response: ProxyResponse = {
      ...result,
      requestHeaders: {
        ...result.requestHeaders,
        "x-api-key": mask(config.apiKey),
      },
    };
    return NextResponse.json(response);
  } catch (error) {
    return handleRouteError(error);
  }
}
