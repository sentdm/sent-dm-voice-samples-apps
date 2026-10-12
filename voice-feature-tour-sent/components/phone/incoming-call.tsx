"use client";

import { useState } from "react";
import { toast } from "sonner";
import type SentVoice from "@sentdm/voice";
import { PhoneIncomingIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { describeError, formatAddress } from "@/lib/client/format";
import { usePhoneLog } from "./phone-log";
import { reportSdkError } from "./sdk-errors";

export function IncomingCall({ invite }: { invite: SentVoice.CallInvite }) {
  const log = usePhoneLog();
  const [busy, setBusy] = useState(false);

  const accept = async () => {
    setBusy(true);
    try {
      await invite.accept();
    } catch (error) {
      // MEDIA_PERMISSION_DENIED leaves the invite pending, so the user can allow the microphone and try again.
      reportSdkError(log, `accept failed`, error);
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    setBusy(true);
    try {
      await invite.reject();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-green-500/40 ring-green-500/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PhoneIncomingIcon className="size-5 animate-pulse text-green-600" />
          Incoming call
          <Badge variant="secondary">{invite.state}</Badge>
        </CardTitle>
        <CardDescription>
          From {formatAddress(invite.from)}. The ringtone plays until you answer
          or decline.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2">
          <Button type="button" onClick={accept} disabled={busy}>
            {busy && <Spinner />}
            Accept
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={decline}
            disabled={busy}
          >
            Decline
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
