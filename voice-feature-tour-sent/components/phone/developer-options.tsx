"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";

export type SdkLogLevel = "off" | "error" | "warn" | "info" | "debug";
export type TelemetryMode = "relay" | "direct" | "off";

/** SDK options a developer wants to change while testing. Applying them recreates the client. */
export interface DeveloperOptions {
  /** Seconds. Null asks Sent for its default of 600. A short value shows the silent refresh. */
  tokenTtl: number | null;
  logLevel: SdkLogLevel;
  registerRetries: number;
  telemetry: TelemetryMode;
}

export const DEFAULT_DEVELOPER_OPTIONS: DeveloperOptions = {
  tokenTtl: null,
  logLevel: "debug",
  registerRetries: 2,
  telemetry: "relay",
};

export function DeveloperOptionsCard({
  value,
  onApply,
}: {
  value: DeveloperOptions;
  onApply: (next: DeveloperOptions) => void;
}) {
  const [draft, setDraft] = useState<DeveloperOptions>(value);
  const changed = JSON.stringify(draft) !== JSON.stringify(value);

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Developer options</CardTitle>
        <CardDescription>
          SDK options read when the client is created. Apply recreates the
          client, as the SDK documents for changed provider props.
        </CardDescription>
      </CardHeader>
      <CardContent className="gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="ttl">
            Token TTL in seconds (empty uses Sent&apos;s default of 600)
          </Label>
          <Input
            id="ttl"
            type="number"
            min={1}
            max={3600}
            value={draft.tokenTtl ?? ""}
            placeholder="600"
            onChange={(event) =>
              setDraft({
                ...draft,
                tokenTtl: event.target.value
                  ? Number(event.target.value)
                  : null,
              })
            }
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="logLevel">SDK log level</Label>
          <NativeSelect
            className="w-full"
            id="logLevel"
            value={draft.logLevel}
            onChange={(event) =>
              setDraft({
                ...draft,
                logLevel: event.target.value as SdkLogLevel,
              })
            }
          >
            {(["off", "error", "warn", "info", "debug"] as SdkLogLevel[]).map(
              (level) => (
                <NativeSelectOption key={level} value={level}>
                  {level}
                </NativeSelectOption>
              )
            )}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="retries">Register retries</Label>
          <Input
            id="retries"
            type="number"
            min={0}
            max={10}
            value={draft.registerRetries}
            onChange={(event) =>
              setDraft({
                ...draft,
                registerRetries: Number(event.target.value) || 0,
              })
            }
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="telemetry">Telemetry</Label>
          <NativeSelect
            className="w-full"
            id="telemetry"
            value={draft.telemetry}
            onChange={(event) =>
              setDraft({
                ...draft,
                telemetry: event.target.value as TelemetryMode,
              })
            }
          >
            <NativeSelectOption value="relay">
              Through this app, visible in the console
            </NativeSelectOption>
            <NativeSelectOption value="direct">
              Straight to Sent
            </NativeSelectOption>
            <NativeSelectOption value="off">Off</NativeSelectOption>
          </NativeSelect>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={!changed}
          onClick={() => onApply(draft)}
        >
          Apply and recreate the client
        </Button>
      </CardContent>
    </Card>
  );
}
