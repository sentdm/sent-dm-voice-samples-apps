"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { newId } from "@/lib/utils";

export type LogKind = "sdk" | "call" | "server" | "log" | "error";

export interface LogEntry {
  id: string;
  at: string;
  kind: LogKind;
  title: string;
  detail?: unknown;
}

export interface PhoneLog {
  push: (entry: Omit<LogEntry, "id" | "at">) => void;
  clear: () => void;
}

const LIMIT = 300;
const PhoneLogContext = createContext<PhoneLog | null>(null);
const PhoneLogEntriesContext = createContext<LogEntry[]>([]);

/** The phone screen's event log: every SDK event, SDK log line and server update, newest first. */
export function PhoneLogProvider({ children }: PropsWithChildren) {
  const [entries, setEntries] = useState<LogEntry[]>([]);

  // The writer never changes, so components that only push do not re-render on every entry.
  const log = useMemo<PhoneLog>(
    () => ({
      push: (entry) =>
        setEntries((current) =>
          [
            {
              ...entry,
              id: newId(),
              at: new Date().toISOString(),
            },
            ...current,
          ].slice(0, LIMIT)
        ),
      clear: () => setEntries([]),
    }),
    []
  );

  return (
    <PhoneLogContext.Provider value={log}>
      <PhoneLogEntriesContext.Provider value={entries}>
        {children}
      </PhoneLogEntriesContext.Provider>
    </PhoneLogContext.Provider>
  );
}

export function usePhoneLog(): PhoneLog {
  const value = useContext(PhoneLogContext);
  if (!value)
    throw new Error("usePhoneLog must be used inside PhoneLogProvider");
  return value;
}

export function usePhoneLogEntries(): LogEntry[] {
  return useContext(PhoneLogEntriesContext);
}
