"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { LOG_LIMIT, newestFirst } from "@/lib/shared/snapshot";
import type { AppEventMessage, StateSnapshot } from "@/lib/shared/types";
import { api } from "./api";

/**
 * One EventSource on `/api/events`. Every event is handed to `onEvent`; the browser
 * reconnects by itself when the connection drops.
 */
export function useAppEvents(onEvent: (event: AppEventMessage) => void): {
  connected: boolean;
} {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onmessage = (raw: MessageEvent<string>) => {
      try {
        handler.current(JSON.parse(raw.data) as AppEventMessage);
      } catch {
        // Ignore a malformed frame.
      }
    };
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, []);

  return { connected };
}

function reduce(
  state: StateSnapshot | null,
  event: AppEventMessage | { type: "snapshot"; snapshot: StateSnapshot }
): StateSnapshot | null {
  if (event.type === "snapshot") return event.snapshot;
  if (!state) return state;
  switch (event.type) {
    case "callback.question":
      return {
        ...state,
        callbackLog: [event.entry, ...state.callbackLog].slice(0, LOG_LIMIT),
      };
    case "webhook.received":
      return {
        ...state,
        webhookInbox: [event.entry, ...state.webhookInbox].slice(0, LOG_LIMIT),
      };
    case "telemetry.batch":
      return {
        ...state,
        telemetry: [event.entry, ...state.telemetry].slice(0, LOG_LIMIT),
      };
    case "presence.changed":
      return { ...state, presence: event.presence };
    case "call.updated": {
      const others = state.calls.filter(
        (call) => call.callId !== event.call.callId
      );
      return {
        ...state,
        calls: [event.call, ...others].sort(newestFirst),
      };
    }
    case "routing.changed":
      return { ...state, routing: event.rules };
    case "config.changed":
      return state;
  }
}

/** The server's snapshot, kept current by the event stream. */
export function useAppState(): {
  state: StateSnapshot | null;
  connected: boolean;
  configVersion: number;
} {
  const [state, dispatch] = useReducer(reduce, null);
  const [configVersion, setConfigVersion] = useState(0);

  const refresh = useCallback(async () => {
    const snapshot = await api.state();
    dispatch({ type: "snapshot", snapshot });
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const { connected } = useAppEvents((event) => {
    dispatch(event);
    if (event.type === "config.changed")
      setConfigVersion((version) => version + 1);
  });

  // A reconnect can have missed events: reload the snapshot when the stream comes back.
  const wasConnected = useRef(false);
  useEffect(() => {
    if (connected && wasConnected.current)
      void refresh().catch(() => undefined);
    wasConnected.current = connected;
  }, [connected, refresh]);

  return { state, connected, configVersion };
}
