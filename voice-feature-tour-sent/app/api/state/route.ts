import { NextResponse } from "next/server";
import { readRoutingRules } from "@/lib/server/config-store";
import { handleRouteError } from "@/lib/server/http";
import { snapshot } from "@/lib/server/state";

export const dynamic = "force-dynamic";

/** Everything a page needs when it opens; the event stream keeps it current afterwards. */
export async function GET() {
  try {
    return NextResponse.json(snapshot(await readRoutingRules()));
  } catch (error) {
    return handleRouteError(error);
  }
}
