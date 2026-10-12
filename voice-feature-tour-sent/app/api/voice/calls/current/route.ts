import { NextResponse } from "next/server";
import { findLiveCallForIdentity } from "@/lib/server/state";

export const dynamic = "force-dynamic";

/**
 * The live call the server knows for an identity, with the leg id that identity is in the
 * room with. The browser cannot see Sent's call id itself, so this is how the phone screen
 * gets the id it needs for the API commands.
 */
export async function GET(request: Request) {
  const identity = new URL(request.url).searchParams.get("identity") ?? "";
  const call = identity ? findLiveCallForIdentity(identity) : undefined;
  return NextResponse.json({
    call: call ?? null,
    legId: call ? (call.legs[identity] ?? call.callId) : null,
  });
}
