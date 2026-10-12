"use client";

import { useEffect, useState } from "react";
import type { PublicConfig } from "@/lib/shared/types";
import { api } from "./api";

/**
 * The saved configuration with every secret masked: `undefined` while it loads, `null` when it
 * cannot be read. It loads again when `reloadKey` changes.
 */
export function usePublicConfig(
  reloadKey?: unknown
): [PublicConfig | null | undefined, (config: PublicConfig) => void] {
  const [config, setConfig] = useState<PublicConfig | null | undefined>(
    undefined
  );

  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch(() => setConfig(null));
  }, [reloadKey]);

  return [config, setConfig];
}
