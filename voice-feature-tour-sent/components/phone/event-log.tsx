"use client";

import { Badge, type BadgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { JsonView } from "@/components/json-view";
import { formatTime } from "@/lib/client/format";
import { usePhoneLog, usePhoneLogEntries, type LogKind } from "./phone-log";

const kindVariant: Record<LogKind, BadgeVariants> = {
  sdk: "secondary",
  call: "default",
  server: "outline",
  log: "ghost",
  error: "destructive",
};

export function EventLog() {
  const entries = usePhoneLogEntries();
  const { clear } = usePhoneLog();

  return (
    <Card size="sm" className="max-h-[calc(100vh-8rem)] lg:sticky lg:top-6">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Event log</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={clear}
            disabled={entries.length === 0}
          >
            Clear
          </Button>
        </CardTitle>
        <CardDescription>
          Every SDK event, SDK log line and server update, newest first.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-y-auto">
        {entries.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing yet. Go online to start.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="border-b pb-2 text-xs last:border-0"
              >
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground font-mono">
                    {formatTime(entry.at)}
                  </span>
                  <Badge variant={kindVariant[entry.kind]}>{entry.kind}</Badge>
                </div>
                <p className="mt-1 break-words">{entry.title}</p>
                {entry.detail !== undefined && (
                  <details className="mt-1">
                    <summary className="text-muted-foreground cursor-pointer">
                      details
                    </summary>
                    <JsonView
                      value={entry.detail}
                      className="mt-1"
                      maxHeight="12rem"
                    />
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
