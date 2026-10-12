"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { api, ApiClientError } from "@/lib/client/api";
import { describeError, formatDuration } from "@/lib/client/format";
import type {
  VoiceCallRecord,
  VoiceParticipantResponse,
} from "@/lib/shared/types";
import { usePhoneLog } from "./phone-log";

const ROSTER_REFRESH_MS = 5000;

/**
 * Everything the SDK leaves to the API for a call in a room: the roster, adding an app user or
 * a phone, mute and unmute, remove one or all, and transfer (add the new party, then remove
 * your own leg). A call outside a room has none of this, which the API answers with 409; a call
 * never enters a room after it is answered, so that verdict is final and the roster is not polled
 * again for it.
 */
export function ParticipantsPanel({
  roomCallId,
  identity,
  conferenceName,
  ownNumber,
}: {
  roomCallId: string;
  identity: string;
  conferenceName: string | null;
  ownNumber: string;
}) {
  const log = usePhoneLog();
  const [roster, setRoster] = useState<VoiceParticipantResponse[] | null>(null);
  const [notInRoom, setNotInRoom] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [kind, setKind] = useState<"user" | "number">("user");
  const [value, setValue] = useState("");
  const [callerId, setCallerId] = useState("");
  const [transferKind, setTransferKind] = useState<"user" | "number">("user");
  const [transferValue, setTransferValue] = useState("");
  const [transferSteps, setTransferSteps] = useState<string[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRoster(
        await api.sent<VoiceParticipantResponse[]>({
          method: "GET",
          path: `/v3/calls/${roomCallId}/participants`,
        })
      );
      setNotInRoom(null);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 409) {
        setNotInRoom(error.message);
        setRoster(null);
      } else if (error instanceof ApiClientError && error.status === 404) {
        setRoster(null);
      }
    }
  }, [roomCallId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (notInRoom !== null) return;
    const timer = setInterval(() => void refresh(), ROSTER_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh, notInRoom]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    try {
      const result = await action();
      log.push({ kind: "server", title: label, detail: result ?? undefined });
      toast.success(label);
      await refresh();
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

  const add = () =>
    run(`Add ${value}`, async () => {
      const leg = await api.sent<VoiceCallRecord>({
        method: "POST",
        path: `/v3/calls/${roomCallId}/participants`,
        body: {
          to: { kind, value: value.trim() },
          ...(kind === "number" && callerId.trim()
            ? { caller_id: callerId.trim() }
            : {}),
        },
      });
      setValue("");
      return leg;
    });

  const setMuted = (participant: VoiceParticipantResponse, muted: boolean) =>
    run(
      `${muted ? "Mute" : "Unmute"} ${participant.value ?? participant.kind}`,
      async () => {
        return api.sent({
          method: "PATCH",
          path: `/v3/calls/${roomCallId}/participants/${participant.id}`,
          body: { muted },
        });
      }
    );

  const remove = (participant: VoiceParticipantResponse) =>
    run(`Remove ${participant.value ?? participant.kind}`, async () => {
      return api.sent({
        method: "DELETE",
        path: `/v3/calls/${roomCallId}/participants/${participant.id}`,
      });
    });

  const removeAll = () =>
    run("Remove every participant", async () => {
      return api.sent({
        method: "DELETE",
        path: `/v3/calls/${roomCallId}/participants`,
      });
    });

  const transfer = async () => {
    setBusy("transfer");
    setTransferSteps(null);
    try {
      const result = await api.transfer(roomCallId, {
        identity,
        target: { kind: transferKind, value: transferValue.trim() },
        ...(transferKind === "number" && callerId.trim()
          ? { callerId: callerId.trim() }
          : {}),
      });
      setTransferSteps(result.steps);
      log.push({
        kind: "server",
        title: `Transferred to ${transferValue}`,
        detail: result,
      });
      toast.success("Transferred. Your leg was removed from the room.");
    } catch (error) {
      const details = error instanceof ApiClientError ? error.details : null;
      setTransferSteps(Array.isArray(details) ? (details as string[]) : null);
      log.push({
        kind: "error",
        title: `Transfer failed: ${describeError(error)}`,
        detail: error,
      });
      toast.error(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  if (notInRoom || (!conferenceName && roster === null)) {
    return (
      <div className="bg-muted/50 rounded-md p-3 text-xs">
        <p className="font-medium">Participants and transfer need a room</p>
        <p className="text-muted-foreground mt-1">
          {notInRoom ?? "This call is a direct connection."} The API can only
          add people to a call that is in a conference room: join a room from
          the dialer, or turn on &quot;room per call&quot; in the console&apos;s
          routing panel so every call starts in one.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-3 rounded-md border p-3 text-sm">
      <div className="flex items-center justify-between">
        <p className="font-medium">
          Room {conferenceName ?? ""}{" "}
          {roster ? (
            <Badge variant="outline">{roster.length} in room</Badge>
          ) : (
            <Spinner className="inline size-3" />
          )}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => void refresh()}
            disabled={busy !== null}
          >
            Refresh
          </Button>
          <Button
            type="button"
            size="xs"
            variant="destructive"
            onClick={removeAll}
            disabled={busy !== null}
          >
            Remove all
          </Button>
        </div>
      </div>

      {roster && roster.length > 0 && (
        <ul className="grid gap-1">
          {roster.map((participant) => (
            <li
              key={participant.id}
              className="flex flex-wrap items-center gap-2 text-xs"
            >
              <Badge variant="secondary">{participant.kind}</Badge>
              <span className="font-medium">
                {participant.value ?? "withheld"}
              </span>
              <span className="text-muted-foreground">
                {formatDuration(participant.duration_seconds)}
              </span>
              {participant.muted && <Badge variant="destructive">muted</Badge>}
              <code className="text-muted-foreground">{participant.id}</code>
              <span className="ml-auto flex gap-1">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => setMuted(participant, !participant.muted)}
                >
                  {participant.muted ? "Unmute" : "Mute"}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => remove(participant)}
                >
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-2 border-t pt-3">
        <Label>Add a participant</Label>
        <div className="flex flex-wrap gap-2">
          <NativeSelect
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as "user" | "number")
            }
          >
            <NativeSelectOption value="user">App user</NativeSelectOption>
            <NativeSelectOption value="number">Phone number</NativeSelectOption>
          </NativeSelect>
          <Input
            className="w-48"
            value={value}
            placeholder={kind === "user" ? "agent-2" : "+14155551234"}
            onChange={(event) => setValue(event.target.value)}
          />
          {kind === "number" && (
            <Input
              className="w-44"
              value={callerId}
              placeholder={`caller id, default ${ownNumber}`}
              onChange={(event) => setCallerId(event.target.value)}
            />
          )}
          <Button
            type="button"
            size="sm"
            disabled={busy !== null || !value.trim()}
            onClick={add}
          >
            {busy === `Add ${value}` && <Spinner />}
            Add
          </Button>
        </div>
      </div>

      <div className="grid gap-2 border-t pt-3">
        <Label>Transfer this call</Label>
        <p className="text-muted-foreground text-xs">
          Dials the new party into the room, waits until they are on the roster,
          then removes your leg.
        </p>
        <div className="flex flex-wrap gap-2">
          <NativeSelect
            value={transferKind}
            onChange={(event) =>
              setTransferKind(event.target.value as "user" | "number")
            }
          >
            <NativeSelectOption value="user">App user</NativeSelectOption>
            <NativeSelectOption value="number">Phone number</NativeSelectOption>
          </NativeSelect>
          <Input
            className="w-48"
            value={transferValue}
            placeholder={transferKind === "user" ? "agent-2" : "+14155551234"}
            onChange={(event) => setTransferValue(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy !== null || !transferValue.trim()}
            onClick={transfer}
          >
            {busy === "transfer" && <Spinner />}
            Transfer
          </Button>
        </div>
        {transferSteps && (
          <ol className="text-muted-foreground list-decimal pl-4 text-xs">
            {transferSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
