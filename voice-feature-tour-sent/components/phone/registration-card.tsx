"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import SentVoice from "@sentdm/voice";
import { useSentVoice } from "@sentdm/voice/react";
import { Badge, type BadgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { sounds } from "@/lib/client/sounds";
import { describeError } from "@/lib/client/format";
import { usePhoneLog } from "./phone-log";
import { reportSdkError } from "./sdk-errors";

/** What the token endpoint said about the last token it minted. */
export interface VoiceTokenInfo {
  identity: string;
  number: string | null;
  /** Unix milliseconds. */
  expiresAt: number | null;
}

const stateVariant: Record<SentVoice.ClientState, BadgeVariants> = {
  unregistered: "outline",
  registering: "secondary",
  registered: "success",
  offline: "destructive",
  destroyed: "destructive",
};

export function RegistrationCard({
  identity,
  token,
  onResetClient,
  onChangeIdentity,
}: {
  identity: string;
  token: VoiceTokenInfo | null;
  onResetClient: () => void;
  onChangeIdentity: () => void;
}) {
  const { client, state, register, unregister } = useSentVoice();
  const log = usePhoneLog();
  const [busy, setBusy] = useState<
    "register" | "unregister" | "destroy" | null
  >(null);
  const [destroyed, setDestroyed] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (
      !token?.expiresAt ||
      state === "unregistered" ||
      state === "destroyed"
    ) {
      setRemaining(null);
      return;
    }
    const tick = () =>
      setRemaining(
        Math.max(0, Math.round((token.expiresAt! - Date.now()) / 1000))
      );
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [token, state]);

  const goOnline = async () => {
    // Registering asks for the notification permission, which Firefox and Safari only show after
    // a click. The same click unlocks audio for the ringtones.
    sounds().unlock();
    setBusy("register");
    try {
      await register();
    } catch (error) {
      reportSdkError(log, `register failed`, error);
    } finally {
      setBusy(null);
    }
  };

  const goOffline = async () => {
    setBusy("unregister");
    try {
      await unregister();
    } catch (error) {
      reportSdkError(log, `unregister failed`, error);
    } finally {
      setBusy(null);
    }
  };

  const destroy = async () => {
    if (!client) return;
    setBusy("destroy");
    try {
      await client.destroy();
      setDestroyed(true);
      log.push({
        kind: "sdk",
        title:
          "client destroyed: every call ended, later calls throw NOT_REGISTERED",
      });
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Registration</span>
          <Badge variant={stateVariant[destroyed ? "destroyed" : state]}>
            {destroyed ? "destroyed" : state}
          </Badge>
        </CardTitle>
        <CardDescription>
          register() fetches a token from this app&apos;s backend and goes
          online. The token is refreshed before it expires.
        </CardDescription>
      </CardHeader>
      <CardContent className="gap-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Identity</dt>
          <dd className="truncate">{client?.identity ?? identity}</dd>
          <dt className="text-muted-foreground">Bound number</dt>
          <dd>{client?.number ?? token?.number ?? "after registering"}</dd>
          <dt className="text-muted-foreground">Token expires</dt>
          <dd>{remaining === null ? "no token yet" : `in ${remaining}s`}</dd>
          <dt className="text-muted-foreground">SDK</dt>
          <dd>@sentdm/voice {SentVoice.version}</dd>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={goOnline}
            disabled={
              destroyed ||
              busy !== null ||
              state === "registered" ||
              state === "registering"
            }
          >
            {busy === "register" && <Spinner />}
            Go online
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={goOffline}
            disabled={destroyed || busy !== null || state === "unregistered"}
          >
            {busy === "unregister" && <Spinner />}
            Go offline
          </Button>
          {destroyed ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={onResetClient}
            >
              Create a new client
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={destroy}
              disabled={busy !== null}
            >
              Destroy client
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onChangeIdentity}
          >
            Change identity
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
