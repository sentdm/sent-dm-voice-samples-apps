"use client";

import type SentVoice from "@sentdm/voice";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { callOtherParty } from "@/lib/client/format";
import type { ServerCall } from "./phone-inner";

export function IdleCard({
  state,
  identity,
  serverCall,
}: {
  state: SentVoice.ClientState;
  identity: string;
  serverCall: ServerCall | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No call</CardTitle>
        <CardDescription>
          {state === "registered"
            ? "Registered. Place a call from the dialer, or wait for one. Incoming calls need this tab open and notifications allowed."
            : "Go online first. Incoming calls are delivered through the service worker once registered."}
        </CardDescription>
      </CardHeader>
      {serverCall && (
        <CardContent>
          <p className="text-muted-foreground text-sm">
            The server still tracks {serverCall.call.callId} with{" "}
            {callOtherParty(serverCall.call, identity)} as{" "}
            {serverCall.call.status}. It clears when the call.completed or
            call.failed webhook arrives.
          </p>
        </CardContent>
      )}
    </Card>
  );
}
