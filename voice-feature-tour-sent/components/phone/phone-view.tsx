"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SentVoiceProvider } from "@sentdm/voice-client-react";
import { Loading, NotSetUp } from "@/components/page-status";
import { api } from "@/lib/client/api";
import { useIdentity, useStoredJson } from "@/lib/client/identity";
import { usePublicConfig } from "@/lib/client/use-public-config";
import {
  DEFAULT_DEVELOPER_OPTIONS,
  type DeveloperOptions,
} from "./developer-options";
import { IdentityPicker } from "./identity-picker";
import { PhoneInner } from "./phone-inner";
import { PhoneLogProvider, usePhoneLog } from "./phone-log";
import type { VoiceTokenInfo } from "./registration-card";

const OPTIONS_KEY = "sent-voice-tour.developer-options";

export function PhoneView() {
  return (
    <PhoneLogProvider>
      <PhoneViewInner />
    </PhoneLogProvider>
  );
}

/**
 * Owns the one SentVoice client of this browser through the SDK's React provider. The provider
 * reads its props when the client is created, so changing the identity or a developer option
 * remounts it with a new key, as the SDK documents.
 */
function PhoneViewInner() {
  const { identity, setIdentity, ready } = useIdentity();
  const [config] = usePublicConfig();
  const [options, setOptions, optionsReady] = useStoredJson<DeveloperOptions>(
    OPTIONS_KEY,
    DEFAULT_DEVELOPER_OPTIONS
  );
  const [generation, setGeneration] = useState(0);
  const [token, setToken] = useState<VoiceTokenInfo | null>(null);
  const log = usePhoneLog();

  useEffect(() => {
    // Compile the callback route now, so the first question is answered inside the deadline.
    void api.warmCallback();
  }, []);

  /**
   * The SDK calls this at register() and before every expiry. The token comes from this app's
   * backend, which holds the API key and asks Sent for a token bound to the configured number.
   * The backend also sends the token's expiry and number in headers.
   */
  const tokenProvider = useCallback(async () => {
    const response = await fetch("/api/voice/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identity,
        ...(options.tokenTtl ? { ttl: options.tokenTtl } : {}),
      }),
      cache: "no-store",
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };
      const message =
        body.error ?? `The token endpoint answered ${response.status}`;
      log.push({
        kind: "error",
        title: `token request failed: ${message}`,
        detail: body,
      });
      throw new Error(message);
    }
    const expiresAt = Date.parse(
      response.headers.get("x-voice-token-expires-at") ?? ""
    );
    const minted: VoiceTokenInfo = {
      identity: identity ?? "",
      number: response.headers.get("x-voice-token-number"),
      expiresAt: Number.isNaN(expiresAt) ? null : expiresAt,
    };
    setToken(minted);
    log.push({
      kind: "server",
      title: "token minted",
      detail: {
        identity: minted.identity,
        number: minted.number,
        expiresAt: minted.expiresAt
          ? new Date(minted.expiresAt).toISOString()
          : null,
      },
    });
    return response.text();
  }, [identity, options.tokenTtl, log]);

  // Every SDK log line goes to the console and to the event log.
  const logger = useMemo(() => {
    const line =
      (level: "error" | "warn" | "info" | "debug") => (message: string) => {
        console[level](message);
        log.push({ kind: "log", title: `sdk ${level}: ${message}` });
      };
    return {
      error: line("error"),
      warn: line("warn"),
      info: line("info"),
      debug: line("debug"),
    };
  }, [log]);

  if (!ready || config === undefined || !optionsReady) {
    return <Loading>Loading</Loading>;
  }

  if (!config?.configured) {
    return (
      <NotSetUp>
        to enter the API key, the voice number and this app&apos;s public URL.
      </NotSetUp>
    );
  }

  if (!identity) return <IdentityPicker onPick={setIdentity} />;

  // The SDK sends its own requests to Sent under `baseURL`: the token exchange, then telemetry.
  // The relay is this app's route in front of the API: it forwards them and records each
  // telemetry batch for the Telemetry tab.
  const baseURL =
    options.sdkRequests === "relay"
      ? `${window.location.origin}/api/sdk-relay`
      : config.apiBaseUrl;

  const key = [
    identity,
    generation,
    JSON.stringify(options),
    config.apiBaseUrl,
  ].join("|");

  return (
    <SentVoiceProvider
      key={key}
      baseURL={baseURL}
      tokenProvider={tokenProvider}
      autoRegister={false}
      logLevel={options.logLevel}
      logger={logger}
      registerRetries={options.registerRetries}
      serviceWorker={{ url: "/sw.js", scope: "/" }}
      telemetry={{ disabled: options.sdkRequests === "no-telemetry" }}
    >
      <PhoneInner
        identity={identity}
        config={config}
        options={options}
        token={token}
        onApplyOptions={setOptions}
        onResetClient={() => setGeneration((value) => value + 1)}
        onChangeIdentity={() => setIdentity(null)}
      />
    </SentVoiceProvider>
  );
}
