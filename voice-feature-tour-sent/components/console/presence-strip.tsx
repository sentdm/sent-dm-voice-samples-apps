"use client";

import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { formatAddress } from "@/lib/client/format";
import { isLive } from "@/lib/shared/snapshot";
import type { PresenceEntry, TrackedCall } from "@/lib/shared/types";

export function PresenceStrip({
  presence,
  calls,
  connected,
}: {
  presence: PresenceEntry[];
  calls: TrackedCall[];
  connected: boolean;
}) {
  const live = calls.filter((call) => !call.test && isLive(call));

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm">
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            "size-2 rounded-full",
            connected ? "bg-green-500" : "bg-red-500"
          )}
        />
        {connected ? "Live updates connected" : "Live updates reconnecting"}
      </span>
      <span className="text-muted-foreground">Presence:</span>
      {presence.length === 0 ? (
        <span className="text-muted-foreground">
          no app user has registered yet
        </span>
      ) : (
        presence.map((entry) => (
          <Badge
            key={entry.identity}
            variant={entry.online ? "success" : "outline"}
          >
            {entry.identity} {entry.online ? "online" : "offline"}
          </Badge>
        ))
      )}
      <span className="text-muted-foreground ml-auto">
        {live.length === 0
          ? "No live call"
          : live
              .map(
                (call) =>
                  `${call.callId.slice(0, 13)} ${formatAddress(call.from)} to ${formatAddress(call.to)} (${call.status})`
              )
              .join(", ")}
      </span>
    </div>
  );
}
