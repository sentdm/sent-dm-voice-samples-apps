"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import type SentVoice from "@sentdm/voice-client";
import { useActiveCall } from "@sentdm/voice-client-react";
import { CopyIcon, MicIcon, MicOffIcon, PhoneOffIcon } from "lucide-react";
import { Badge, type BadgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { RecordingLinks } from "@/components/recording-links";
import { api, unwrapProxy } from "@/lib/client/api";
import {
  describeError,
  formatAddress,
  formatDuration,
} from "@/lib/client/format";
import type {
  VoiceRecordingResponse,
  VoiceRecordingsResponse,
} from "@/lib/shared/types";
import { ParticipantsPanel } from "./participants-panel";
import type { ServerCall } from "./phone-inner";
import { usePhoneLog } from "./phone-log";
import { reportSdkError } from "./sdk-errors";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

const stateVariant: Record<string, BadgeVariants> = {
  initiated: "secondary",
  ringing: "secondary",
  answered: "secondary",
  connected: "success",
  reconnecting: "destructive",
};

export function ActiveCall({
  warnings,
  serverCall,
  identity,
  ownNumber,
}: {
  warnings: Record<string, boolean>;
  serverCall: ServerCall | null;
  identity: string;
  ownNumber: string;
}) {
  const { call, state, isMuted, mute, hangup, sendDigits, duration } =
    useActiveCall();
  const log = usePhoneLog();
  const [stats, setStats] = useState<SentVoice.CallStats | null>(null);
  const [digits, setDigits] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<VoiceRecordingResponse[]>([]);

  // getStats() every two seconds while connected: jitter, packet loss and round trip time.
  useEffect(() => {
    if (!call || state !== "connected") return;
    let cancelled = false;
    const read = () =>
      call.getStats().then(
        (next) => {
          if (!cancelled) setStats(next);
        },
        () => undefined
      );
    void read();
    const timer = setInterval(read, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [call, state]);

  const press = (key: string) => {
    try {
      sendDigits(key);
      setDigits((current) => current + key);
      log.push({ kind: "call", title: `sendDigits ${key}` });
    } catch (error) {
      toast.error(describeError(error));
    }
  };

  const endCall = async () => {
    setBusy("hangup");
    try {
      await hangup();
    } catch (error) {
      reportSdkError(log, `hangup failed`, error);
    } finally {
      setBusy(null);
    }
  };

  /** Commands that go through this app's backend to the Sent API, using Sent's call id. */
  const command = async (label: string, path: string, body?: unknown) => {
    if (!serverCall) return;
    setBusy(label);
    try {
      const response = await api.proxy({
        method: "POST",
        path: `/v3/voice/calls/${serverCall.legId}${path}`,
        body,
      });
      unwrapProxy(response);
      log.push({
        kind: "server",
        title: `${label}: ${response.status}`,
        detail: { path: response.url },
      });
      toast.success(`${label}: ${response.status}`);
    } catch (error) {
      log.push({
        kind: "error",
        title: `${label} failed: ${describeError(error)}`,
        detail: error,
      });
      toast.error(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  const listRecordings = async () => {
    if (!serverCall) return;
    setBusy("recording");
    try {
      // One item per recording, oldest first. Each link is valid until
      // url_expires_at.
      const { recordings: list = [] } = await api.sent<VoiceRecordingsResponse>(
        {
          method: "GET",
          path: `/v3/voice/calls/${serverCall.call.callId}/recordings`,
        }
      );
      setRecordings(list);
      if (list.length === 0) {
        toast.info("No recording yet");
        return;
      }
      const noun = list.length === 1 ? "recording link" : "recording links";
      log.push({
        kind: "server",
        title: `${list.length} ${noun} issued`,
        detail: list,
      });
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  if (!call) return null;

  const activeWarnings = Object.entries(warnings).filter(
    ([, active]) => active
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span>
            {call.direction === "outbound" ? "Outbound call" : "Inbound call"}
          </span>
          <Badge variant={stateVariant[state ?? ""] ?? "outline"}>
            {state ?? call.state}
          </Badge>
          {state === "connected" && (
            <Badge variant="outline">{formatDuration(duration)}</Badge>
          )}
          {activeWarnings.map(([metric]) => (
            <Badge key={metric} variant="destructive">
              poor {metric}
            </Badge>
          ))}
        </CardTitle>
        <CardDescription>
          {formatAddress(call.from)} to {formatAddress(call.to)}. SDK call id{" "}
          {call.id}.
        </CardDescription>
      </CardHeader>
      <CardContent className="gap-4">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={isMuted ? "secondary" : "outline"}
            onClick={() => mute()}
          >
            {isMuted ? <MicOffIcon /> : <MicIcon />}
            {isMuted ? "Unmute" : "Mute"}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={endCall}
            disabled={busy === "hangup"}
          >
            <PhoneOffIcon />
            Hang up
          </Button>
        </div>

        <div className="grid gap-2 sm:grid-cols-[auto_1fr]">
          <div className="grid w-44 grid-cols-3 gap-1">
            {KEYS.map((key) => (
              <Button
                key={key}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => press(key)}
              >
                {key}
              </Button>
            ))}
          </div>
          <div className="text-sm">
            <p className="text-muted-foreground">DTMF sent</p>
            <p className="font-mono">{digits || "none"}</p>
            <p className="text-muted-foreground mt-3">
              Stats (getStats every 2 s)
            </p>
            {stats ? (
              <p className="font-mono">
                jitter {stats.jitter.toFixed(1)} ms, loss{" "}
                {(stats.packetLoss * 100).toFixed(2)}%, rtt{" "}
                {stats.rtt.toFixed(0)} ms
              </p>
            ) : (
              <p className="font-mono">available once connected</p>
            )}
          </div>
        </div>

        <Separator />

        <div className="grid gap-2 text-sm">
          <p className="font-medium">Through the Sent API</p>
          {serverCall ? (
            <>
              <p className="text-muted-foreground flex flex-wrap items-center gap-2">
                <span>Sent call id</span>
                <code className="bg-muted rounded px-1.5 py-0.5 text-xs">
                  {serverCall.call.callId}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Copy call id"
                  onClick={() =>
                    void navigator.clipboard.writeText(serverCall.call.callId)
                  }
                >
                  <CopyIcon />
                </Button>
                {serverCall.legId !== serverCall.call.callId && (
                  <span>
                    your leg{" "}
                    <code className="bg-muted rounded px-1.5 py-0.5 text-xs">
                      {serverCall.legId}
                    </code>
                  </span>
                )}
                <Badge variant="outline">{serverCall.call.status}</Badge>
                {serverCall.call.conferenceName && (
                  <Badge variant="secondary">
                    room {serverCall.call.conferenceName}
                  </Badge>
                )}
                {serverCall.call.recordingAvailable && (
                  <Badge variant="success">recording ready</Badge>
                )}
              </p>
              {serverCall.call.followUp && (
                <p className="text-muted-foreground text-xs">
                  Room per call: dialing {serverCall.call.followUp.target.value}{" "}
                  is {serverCall.call.followUp.status}
                  {serverCall.call.followUp.message
                    ? `: ${serverCall.call.followUp.message}`
                    : ""}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => command("Hang up via API", "/hangup")}
                >
                  Hang up via API
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    command("Start recording", "/recordings", {
                      action: "start",
                    })
                  }
                >
                  Start recording
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    command("Stop recording", "/recordings", { action: "stop" })
                  }
                >
                  Stop recording
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    busy !== null || !serverCall.call.recordingAvailable
                  }
                  onClick={listRecordings}
                >
                  Recording links
                </Button>
              </div>
              {recordings.length > 0 && (
                <RecordingLinks recordings={recordings} />
              )}
              <p className="text-muted-foreground text-xs">
                Recording needs a phone leg: app-to-app calls are not recorded.
              </p>
              <ParticipantsPanel
                roomCallId={serverCall.legId}
                identity={identity}
                conferenceName={serverCall.call.conferenceName}
                ownNumber={ownNumber}
              />
            </>
          ) : (
            <p className="text-muted-foreground">
              Waiting for the call.request question to reach this app&apos;s
              backend. Sent&apos;s call id is only known there, and the API
              commands need it.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
