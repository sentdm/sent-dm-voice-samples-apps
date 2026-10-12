import { NextResponse } from "next/server";
import {
  credentialsFor,
  credentialsInputSchema,
  readConfig,
} from "@/lib/server/config-store";
import { handleRouteError, jsonError, readJsonBody } from "@/lib/server/http";
import { assertSetupPassword } from "@/lib/server/setup-password";
import { getAccount, listVoiceNumbers } from "@/lib/server/sent-api";

export const dynamic = "force-dynamic";

/**
 * Connect on the setup screen: checks the API key against `GET /v3/me` and lists the
 * account's voice numbers with `GET /v3/channels/voice`. Nothing is saved.
 */
export async function POST(request: Request) {
  try {
    assertSetupPassword(request);
    const input = credentialsInputSchema.parse(await readJsonBody(request));
    const credentials = credentialsFor(input, await readConfig());
    if (!credentials) return jsonError(400, "An API key is required");

    const [account, numbers] = await Promise.all([
      getAccount(credentials),
      listVoiceNumbers(credentials),
    ]);
    return NextResponse.json({ account, numbers });
  } catch (error) {
    return handleRouteError(error);
  }
}
