"use client";

import { useState } from "react";
import type SentVoice from "@sentdm/voice-client";
import { useSentVoice } from "@sentdm/voice-client-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePhoneLog } from "./phone-log";
import { reportSdkError } from "./sdk-errors";

export function Dialer({ canCall }: { canCall: boolean }) {
  const { client } = useSentVoice();
  const log = usePhoneLog();
  const [destination, setDestination] = useState("");
  const [room, setRoom] = useState("demo-room");
  const [busy, setBusy] = useState(false);

  const run = async (label: string, action: () => Promise<SentVoice.Call>) => {
    if (!client) return;
    setBusy(true);
    try {
      const call = await action();
      log.push({
        kind: "call",
        title: `${label} placed`,
        detail: { sdkCallId: call.id, to: call.to },
      });
    } catch (error) {
      reportSdkError(log, `${label} failed`, error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Dialer</CardTitle>
        <CardDescription>
          connect() takes a phone number in E.164 or another app user&apos;s
          identity. joinConference() takes a room name. Your backend&apos;s
          answer decides what rings.
        </CardDescription>
      </CardHeader>
      <CardContent className="gap-4">
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(`call to ${destination}`, () =>
              client!.connect({ to: destination.trim() })
            );
          }}
        >
          <Label htmlFor="destination">Phone number or identity</Label>
          <div className="flex gap-2">
            <Input
              id="destination"
              value={destination}
              placeholder="+14155551234 or agent-2"
              onChange={(event) => setDestination(event.target.value)}
            />
            <Button
              type="submit"
              disabled={!canCall || busy || !destination.trim()}
            >
              Call
            </Button>
          </div>
        </form>
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(`join room ${room}`, () =>
              client!.joinConference({ name: room.trim() })
            );
          }}
        >
          <Label htmlFor="room">Conference room</Label>
          <div className="flex gap-2">
            <Input
              id="room"
              value={room}
              placeholder="demo-room"
              onChange={(event) => setRoom(event.target.value)}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={!canCall || busy || !room.trim()}
            >
              Join
            </Button>
          </div>
        </form>
        {!canCall && (
          <p className="text-muted-foreground text-xs">
            Calls can be placed while registered and not in a call. The SDK
            handles one call at a time.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
