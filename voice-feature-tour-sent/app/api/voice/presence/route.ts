import { NextResponse } from "next/server";
import { z } from "zod";
import { IDENTITY_PATTERN } from "@/lib/shared/validation";
import { handleRouteError, readJsonBody } from "@/lib/server/http";
import { setPresence } from "@/lib/server/state";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  identity: z.string().regex(IDENTITY_PATTERN),
  online: z.boolean(),
  clientState: z.string().max(40).nullable().optional(),
});

/**
 * Presence is the customer backend's own knowledge of who is reachable in the app. Each
 * browser sends a heartbeat while it is registered, and the callback uses it to decide
 * whether to ring the app or fall back to a phone.
 */
export async function POST(request: Request) {
  try {
    const { identity, online, clientState } = bodySchema.parse(
      await readJsonBody(request)
    );
    return NextResponse.json(
      setPresence(identity, online, clientState ?? null)
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
