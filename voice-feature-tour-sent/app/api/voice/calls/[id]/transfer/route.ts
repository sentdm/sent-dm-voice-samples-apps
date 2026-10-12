import { NextResponse } from "next/server";
import { z } from "zod";
import { requireConfig } from "@/lib/server/config-store";
import { E164_PATTERN, IDENTITY_PATTERN } from "@/lib/shared/validation";
import { handleRouteError, readJsonBody } from "@/lib/server/http";
import { findCallByAnyId, upsertCall } from "@/lib/server/state";
import { transferCall } from "@/lib/server/transfer";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  identity: z.string().regex(IDENTITY_PATTERN),
  target: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("user"),
      value: z.string().regex(IDENTITY_PATTERN),
    }),
    z.object({
      kind: z.literal("number"),
      value: z.string().regex(E164_PATTERN),
    }),
  ]),
  callerId: z.string().regex(E164_PATTERN).optional(),
});

/**
 * Transfers the identity's call to someone else: the target is dialed into the room, and once
 * the roster lists them the identity's own leg is removed. Built from the participant commands,
 * which is how Sent Voice offers transfer.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { identity, target, callerId } = bodySchema.parse(
      await readJsonBody(request)
    );
    const config = await requireConfig();

    const tracked = findCallByAnyId(id);
    const agentLegId = tracked?.legs[identity] ?? id;

    const result = await transferCall(config, id, agentLegId, target, callerId);

    if (tracked) {
      const legs: Record<string, string> = {};
      for (const [who, legId] of Object.entries(tracked.legs)) {
        if (who !== identity) legs[who] = legId;
      }
      if (target.kind === "user") legs[target.value] = result.participantId;
      upsertCall(tracked.callId, {
        callId: tracked.callId,
        identities: [
          ...tracked.identities.filter((entry) => entry !== identity),
          ...(target.kind === "user" ? [target.value] : []),
        ],
        legs,
      });
    }

    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
