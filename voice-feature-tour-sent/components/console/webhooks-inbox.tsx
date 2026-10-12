"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Badge, type BadgeVariants } from "@/components/ui/badge";
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
import { Spinner } from "@/components/ui/spinner";
import { JsonView } from "@/components/json-view";
import { api } from "@/lib/client/api";
import { describeError, formatTime } from "@/lib/client/format";
import type {
  CallWebhookPayload,
  PublicConfig,
  SignatureStatus,
  WebhookInboxEntry,
} from "@/lib/shared/types";

const CALL_EVENT_TYPES = [
  "call.completed",
  "call.initiated",
  "call.answered",
  "call.failed",
  "call.recording_ready",
];

export const signatureVariant: Record<SignatureStatus, BadgeVariants> = {
  valid: "success",
  invalid: "destructive",
  missing: "destructive",
  unverified: "destructive",
};

/**
 * The subscription this app receives call webhooks on, and every delivery with its signature
 * verdict. The secret only ever leaves Sent once, in the create response, so the app stores it
 * right then; a subscription made elsewhere can be used by pasting its id and secret.
 */
export function WebhooksInbox({
  config,
  entries,
  onConfigChange,
}: {
  config: PublicConfig;
  entries: WebhookInboxEntry[];
  onConfigChange: (config: PublicConfig) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [existingId, setExistingId] = useState("");
  const [existingSecret, setExistingSecret] = useState("");
  const [testType, setTestType] = useState(CALL_EVENT_TYPES[0]);

  const run = async (
    label: string,
    action: () => Promise<PublicConfig | void>
  ) => {
    setBusy(label);
    try {
      const next = await action();
      if (next) onConfigChange(next);
      toast.success(label);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  const sendTest = () =>
    run(`Test ${testType} sent`, async () => {
      if (!config.webhook) return;
      await api.sent({
        method: "POST",
        path: `/v3/webhooks/${config.webhook.id}/test`,
        body: { event_type: testType },
      });
    });

  return (
    <div className="grid gap-4 lg:grid-cols-[24rem_minmax(0,1fr)]">
      <Card size="sm" className="self-start">
        <CardHeader>
          <CardTitle>Subscription</CardTitle>
          <CardDescription>
            A webhook on the call group pointing at {config.webhookEndpointUrl}.
            Deliveries are verified with its signing secret.
          </CardDescription>
        </CardHeader>
        <CardContent className="gap-3">
          {config.webhook ? (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Id</dt>
                <dd className="truncate font-mono">{config.webhook.id}</dd>
                <dt className="text-muted-foreground">Endpoint</dt>
                <dd className="truncate">{config.webhook.endpointUrl}</dd>
                <dt className="text-muted-foreground">Secret</dt>
                <dd className="font-mono">
                  {config.webhook.signingSecretMasked}
                </dd>
              </dl>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    run("Secret rotated", () =>
                      api.webhookSubscription({ action: "rotate" })
                    )
                  }
                >
                  Rotate secret
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    run("Subscription forgotten", () =>
                      api.webhookSubscription({ action: "forget" })
                    )
                  }
                >
                  Forget
                </Button>
              </div>
              <div className="grid gap-1.5 border-t pt-3">
                <Label htmlFor="testType">Send a test event</Label>
                <div className="flex gap-2">
                  <NativeSelect
                    className="flex-1"
                    id="testType"
                    value={testType}
                    onChange={(event) => setTestType(event.target.value)}
                  >
                    {CALL_EVENT_TYPES.map((type) => (
                      <NativeSelectOption key={type} value={type}>
                        {type}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy !== null}
                    onClick={sendTest}
                  >
                    {busy?.startsWith("Test") && <Spinner />}
                    Send
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  Sent delivers the sample through the real delivery path, so it
                  lands in the inbox below.
                </p>
              </div>
            </>
          ) : (
            <>
              <Button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  run("Subscription created", () =>
                    api.webhookSubscription({ action: "create" })
                  )
                }
              >
                {busy === "Subscription created" && <Spinner />}
                Create a call subscription
              </Button>
              <div className="grid gap-2 border-t pt-3">
                <Label>Or use an existing webhook</Label>
                <Input
                  value={existingId}
                  placeholder="webhook id"
                  onChange={(event) => setExistingId(event.target.value)}
                />
                <Input
                  type="password"
                  value={existingSecret}
                  placeholder="whsec_..."
                  onChange={(event) => setExistingSecret(event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    busy !== null ||
                    !existingId.trim() ||
                    !existingSecret.trim()
                  }
                  onClick={() =>
                    run("Subscription stored", () =>
                      api.webhookSubscription({
                        action: "use",
                        id: existingId.trim(),
                        signingSecret: existingSecret.trim(),
                      })
                    )
                  }
                >
                  Use it
                </Button>
                <p className="text-muted-foreground text-xs">
                  Its endpoint URL must be {config.webhookEndpointUrl} for
                  deliveries to arrive here.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Inbox</CardTitle>
          <CardDescription>
            Every delivery to this app, newest first. A delivery that does not
            verify is refused with 401 and shown in red.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {entries.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing delivered yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {entries.map((entry) => {
                const payload = entry.envelope?.payload as
                  Partial<CallWebhookPayload> | undefined;
                return (
                  <li key={entry.id} className="rounded-md border p-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-muted-foreground font-mono">
                        {formatTime(entry.receivedAt)}
                      </span>
                      <Badge variant={signatureVariant[entry.signature]}>
                        signature {entry.signature}
                      </Badge>
                      <Badge>{entry.event ?? "unknown event"}</Badge>
                      {payload?.call_id && <code>{payload.call_id}</code>}
                      {payload?.duration_seconds !== undefined && (
                        <span>{payload.duration_seconds}s</span>
                      )}
                      {payload?.price !== undefined && (
                        <span>price {payload.price}</span>
                      )}
                      {payload?.reason && (
                        <Badge variant="destructive">{payload.reason}</Badge>
                      )}
                      <Badge variant="outline" className="ml-auto">
                        answered {entry.statusCode}
                      </Badge>
                    </div>
                    {entry.signatureDetail && (
                      <p className="text-destructive mt-1">
                        {entry.signatureDetail}
                      </p>
                    )}
                    <details className="mt-2">
                      <summary className="text-muted-foreground cursor-pointer">
                        payload
                      </summary>
                      <JsonView
                        value={entry.envelope ?? entry.rawBody}
                        className="mt-1"
                      />
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
