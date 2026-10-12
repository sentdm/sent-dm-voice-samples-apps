"use client";

import { useCallback, useEffect, useState } from "react";

const IDENTITY_KEY = "sent-voice-tour.identity";

/**
 * The identity this browser registers as. Kept per browser, so two PCs against the same
 * server are two different app users.
 */
export function useIdentity(): {
  identity: string | null;
  setIdentity: (value: string | null) => void;
  ready: boolean;
} {
  const [identity, setIdentityState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setIdentityState(window.localStorage.getItem(IDENTITY_KEY));
    setReady(true);
  }, []);

  const setIdentity = useCallback((value: string | null) => {
    if (value) window.localStorage.setItem(IDENTITY_KEY, value);
    else window.localStorage.removeItem(IDENTITY_KEY);
    setIdentityState(value);
  }, []);

  return { identity, setIdentity, ready };
}

/** A small persisted JSON value, for the developer options on the phone screen. */
export function useStoredJson<T>(
  key: string,
  fallback: T
): [T, (value: T) => void, boolean] {
  const [value, setValue] = useState<T>(fallback);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored) setValue({ ...fallback, ...(JSON.parse(stored) as T) });
    } catch {
      // A broken value falls back to the defaults.
    }
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const update = useCallback(
    (next: T) => {
      window.localStorage.setItem(key, JSON.stringify(next));
      setValue(next);
    },
    [key]
  );

  return [value, update, ready];
}
