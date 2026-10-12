"use client";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { JsonView } from "@/components/json-view";
import { formatTime } from "@/lib/client/format";
import type { TelemetryBatchEntry } from "@/lib/shared/types";

export function TelemetryFeed({ entries }: { entries: TelemetryBatchEntry[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Telemetry the SDK sends</CardTitle>
        <CardDescription>
          Every batch the SDK posted, as it left the browser, relayed unchanged
          to POST /v3/voice/telemetry on the Sent API with the voice token as
          bearer. Batches go out 3 seconds after an event, and at once when a
          call ends, when the page hides and when the client is destroyed. Turn
          the relay on in the phone screen&apos;s developer options.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No batch yet. Go online with a phone.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {entries.map((entry) => (
              <li key={entry.id} className="rounded-md border p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground font-mono">
                    {formatTime(entry.receivedAt)}
                  </span>
                  <Badge variant="secondary">
                    {entry.identity ?? "unknown identity"}
                  </Badge>
                  <span>sdk {entry.sdkVersion ?? "?"}</span>
                  <span>{entry.eventCount} events</span>
                  {entry.eventTypes.map((type) => (
                    <Badge key={type} variant="outline">
                      {type}
                    </Badge>
                  ))}
                  <span className="ml-auto flex items-center gap-2">
                    {entry.status !== null && (
                      <Badge
                        variant={
                          entry.status >= 200 && entry.status < 300
                            ? "success"
                            : "destructive"
                        }
                      >
                        Sent answered {entry.status}
                      </Badge>
                    )}
                    {entry.error && (
                      <Badge variant="destructive">{entry.error}</Badge>
                    )}
                    <span className="text-muted-foreground">
                      {entry.durationMs} ms
                    </span>
                  </span>
                </div>
                <details className="mt-2">
                  <summary className="text-muted-foreground cursor-pointer">
                    batch as sent
                  </summary>
                  <JsonView value={entry.batch} className="mt-1" />
                </details>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
