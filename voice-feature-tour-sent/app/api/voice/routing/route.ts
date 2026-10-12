import { NextResponse } from "next/server";
import { writeRoutingRules } from "@/lib/server/config-store";
import { handleRouteError, readJsonBody } from "@/lib/server/http";
import { assertSetupPassword } from "@/lib/server/setup-password";
import { routingRulesSchema } from "@/lib/server/routing";
import { publish } from "@/lib/server/state";

export const dynamic = "force-dynamic";

/** Saves the rules the callback follows. Edited from the routing panel in the console. */
export async function PUT(request: Request) {
  try {
    assertSetupPassword(request);
    const rules = routingRulesSchema.parse(await readJsonBody(request));
    await writeRoutingRules(rules);
    publish({ type: "routing.changed", rules });
    return NextResponse.json(rules);
  } catch (error) {
    return handleRouteError(error);
  }
}
