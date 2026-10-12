"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import type SentVoice from "@sentdm/voice";
import type { SentVoiceError } from "@sentdm/voice";
import {
  useActiveCall,
  useIncomingCall,
  useSentVoice,
} from "@sentdm/voice/react";
import { api } from "@/lib/client/api";
import { formatAddress } from "@/lib/client/format";
import { sounds } from "@/lib/client/sounds";
import { useAppEvents } from "@/lib/client/use-app-events";
import { isLive } from "@/lib/shared/snapshot";
import type { PublicConfig, TrackedCall } from "@/lib/shared/types";
import { ActiveCall } from "./active-call";
import {
  DeveloperOptionsCard,
  type DeveloperOptions,
} from "./developer-options";
import { DevicesCard } from "./devices-card";
import { Dialer } from "./dialer";
import { EventLog } from "./event-log";
import { IdleCard } from "./idle-card";
import { IncomingCall } from "./incoming-call";
import { usePhoneLog } from "./phone-log";
import { RegistrationCard, type VoiceTokenInfo } from "./registration-card";
import { errorDetail } from "./sdk-errors";

export interface ServerCall {
  call: TrackedCall;
  /** The leg this identity is in the room with: the call id itself, or a participant id. */
  legId: string;
}

const HEARTBEAT_MS = 15_000;

/**
 * Wires the SDK's events into the event log and the sounds, keeps the server informed of
 * presence, and learns Sent's call id for the call this identity is in.
 */
export function PhoneInner({
  identity,
  config,
  options,
  token,
  onApplyOptions,
  onResetClient,
  onChangeIdentity,
}: {
  identity: string;
  config: PublicConfig;
  options: DeveloperOptions;
  token: VoiceTokenInfo | null;
  onApplyOptions: (next: DeveloperOptions) => void;
  onResetClient: () => void;
  onChangeIdentity: () => void;
}) {
  const { client, state } = useSentVoice();
  const invite = useIncomingCall();
  const { call: activeCall } = useActiveCall();
  const log = usePhoneLog();
  const [warnings, setWarnings] = useState<Record<string, boolean>>({});
  const [serverCall, setServerCall] = useState<ServerCall | null>(null);

  // Every client and call event, into the log and the sounds.
  useEffect(() => {
    if (!client) return;

    const attach = (call: SentVoice.Call) => {
      call
        .on("ringing", () => {
          log.push({ kind: "call", title: `ringing (${call.direction})` });
          if (call.direction === "outbound") sounds().startRingback();
        })
        .on("answered", () => log.push({ kind: "call", title: "answered" }))
        .on("connected", () => {
          sounds().stop();
          log.push({ kind: "call", title: "connected" });
        })
        .on("reconnecting", () =>
          log.push({ kind: "call", title: "reconnecting: media lost" })
        )
        .on("reconnected", () =>
          log.push({ kind: "call", title: "reconnected" })
        )
        .on("muteChanged", (muted) =>
          log.push({ kind: "call", title: muted ? "muted" : "unmuted" })
        )
        .on("qualityWarning", (warning) => {
          setWarnings((current) => ({
            ...current,
            [warning.metric]: !warning.cleared,
          }));
          log.push({
            kind: "call",
            title: `qualityWarning ${warning.metric} ${warning.cleared ? "cleared" : "raised"}`,
          });
        })
        .on("error", (error) =>
          log.push({
            kind: "error",
            title: `call error: ${error.code}`,
            detail: errorDetail(error),
          })
        )
        .on("disconnected", ({ state: endState, error }) => {
          sounds().stop();
          log.push({
            kind: "call",
            title: `disconnected: ${endState}`,
            detail: error ? errorDetail(error) : undefined,
          });
        });
    };

    const onRegistering = () => log.push({ kind: "sdk", title: "registering" });
    const onRegistered = () =>
      log.push({
        kind: "sdk",
        title: "registered",
        detail: { identity: client.identity, number: client.number },
      });
    const onUnregistered = () =>
      log.push({ kind: "sdk", title: "unregistered" });
    const onOffline = (reason: SentVoiceError) => {
      log.push({
        kind: "error",
        title: `offline: ${reason.code}`,
        detail: errorDetail(reason),
      });
      toast.warning(
        "The client went offline. It retries the token every 30 seconds."
      );
    };
    const onTokenWillExpire = ({ expiresAt }: { expiresAt: number }) =>
      log.push({
        kind: "sdk",
        title: "tokenWillExpire: refreshing",
        detail: { expiresAt: new Date(expiresAt).toISOString() },
      });
    const onError = (error: SentVoiceError) =>
      log.push({
        kind: "error",
        title: `client error: ${error.code}`,
        detail: errorDetail(error),
      });
    const onIncomingCall = (incoming: SentVoice.CallInvite) => {
      log.push({
        kind: "call",
        title: `incomingCall from ${formatAddress(incoming.from)}`,
      });
      sounds().startRingtone();
      incoming
        .on("accepted", () => {
          sounds().stop();
          log.push({ kind: "call", title: "invite accepted" });
        })
        .on("rejected", () => {
          sounds().stop();
          log.push({ kind: "call", title: "invite rejected" });
        })
        .on("cancelled", (info) => {
          sounds().stop();
          log.push({
            kind: "call",
            title: "invite cancelled: the caller gave up",
            detail: info.error ? errorDetail(info.error) : undefined,
          });
        });
    };
    const onActiveCallChanged = (call: SentVoice.Call | null) => {
      if (!call) {
        sounds().stop();
        setWarnings({});
        log.push({ kind: "call", title: "activeCallChanged: no call" });
        return;
      }
      log.push({
        kind: "call",
        title: `activeCallChanged: ${call.direction} call to ${formatAddress(call.to)}`,
        detail: {
          sdkCallId: call.id,
          from: call.from,
          to: call.to,
          state: call.state,
        },
      });
      attach(call);
    };

    client
      .on("registering", onRegistering)
      .on("registered", onRegistered)
      .on("unregistered", onUnregistered)
      .on("offline", onOffline)
      .on("tokenWillExpire", onTokenWillExpire)
      .on("error", onError)
      .on("incomingCall", onIncomingCall)
      .on("activeCallChanged", onActiveCallChanged);

    return () => {
      client
        .off("registering", onRegistering)
        .off("registered", onRegistered)
        .off("unregistered", onUnregistered)
        .off("offline", onOffline)
        .off("tokenWillExpire", onTokenWillExpire)
        .off("error", onError)
        .off("incomingCall", onIncomingCall)
        .off("activeCallChanged", onActiveCallChanged);
    };
  }, [client, log]);

  // Presence: the backend's own knowledge of who can take a call in the app.
  useEffect(() => {
    const online = state === "registered";
    const send = () =>
      api.presence(identity, online, state).catch(() => undefined);
    void send();
    if (!online) return;
    const timer = setInterval(send, HEARTBEAT_MS);
    const goodbye = () =>
      void api.presence(identity, false, "closed").catch(() => undefined);
    window.addEventListener("pagehide", goodbye);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", goodbye);
    };
  }, [identity, state]);

  // Sent's call id for the call this identity is in, from the server's call map.
  const { connected } = useAppEvents((event) => {
    if (event.type !== "call.updated") return;
    const call = event.call;
    if (call.test || !call.identities.includes(identity)) return;
    if (isLive(call))
      setServerCall({ call, legId: call.legs[identity] ?? call.callId });
    else
      setServerCall((current) =>
        current?.call.callId === call.callId ? null : current
      );
  });

  const activeCallId = activeCall?.id ?? null;
  const hasInvite = invite !== null;
  useEffect(() => {
    if (!activeCallId && !hasInvite) {
      const timer = setTimeout(() => setServerCall(null), 3000);
      return () => clearTimeout(timer);
    }
    // The event stream keeps it current from here; read it again after a reconnect, which
    // can have missed events.
    if (!connected) return;
    let cancelled = false;
    api
      .currentCall(identity)
      .then((result) => {
        if (cancelled) return;
        setServerCall(
          result.call
            ? { call: result.call, legId: result.legId ?? result.call.callId }
            : null
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [identity, activeCallId, hasInvite, connected]);

  const canCall = state === "registered" && !activeCall && !invite;

  return (
    <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)_24rem]">
      <div className="flex flex-col gap-4">
        <RegistrationCard
          identity={identity}
          token={token}
          onResetClient={onResetClient}
          onChangeIdentity={onChangeIdentity}
        />
        <Dialer canCall={canCall} />
        <DevicesCard />
        <DeveloperOptionsCard value={options} onApply={onApplyOptions} />
      </div>
      <div className="flex flex-col gap-4">
        {invite && <IncomingCall invite={invite} />}
        {activeCall ? (
          <ActiveCall
            warnings={warnings}
            serverCall={serverCall}
            identity={identity}
            ownNumber={config.phoneNumber}
          />
        ) : (
          <IdleCard state={state} identity={identity} serverCall={serverCall} />
        )}
      </div>
      <EventLog />
    </div>
  );
}
