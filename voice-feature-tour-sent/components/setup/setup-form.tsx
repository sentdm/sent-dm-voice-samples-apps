"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Loading } from "@/components/page-status";
import {
  api,
  setSetupPassword,
  type ConnectResult,
  type SetupInput,
  type SetupResult,
} from "@/lib/client/api";
import { describeError } from "@/lib/client/format";
import { useAppEvents } from "@/lib/client/use-app-events";
import { usePublicConfig } from "@/lib/client/use-public-config";
import type {
  PublicConfig,
  TunnelInfo,
  VoiceNumberResponse,
} from "@/lib/shared/types";

export function SetupForm() {
  // Reloaded on config.changed, which also announces the tunnel opening.
  const [configVersion, setConfigVersion] = useState(0);
  useAppEvents((event) => {
    if (event.type === "config.changed") setConfigVersion((v) => v + 1);
  });
  const [config, setConfig] = usePublicConfig(configVersion);
  // Only what the user typed is state; the rest of the form comes from the saved configuration.
  const [edits, setEdits] = useState<Partial<SetupInput>>({});
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Connect: the account and its voice numbers, for the key and base URL in the form.
  const [connection, setConnection] = useState<ConnectResult | null>(null);
  const [busy, setBusy] = useState<"connect" | "route" | null>(null);

  // With a key already saved, load the voice numbers at once so the number is picked from a list.
  const savedBaseUrl = config?.configured ? config.apiBaseUrl : null;
  useEffect(() => {
    if (!savedBaseUrl) return;
    let cancelled = false;
    api
      .connect({ apiBaseUrl: savedBaseUrl, apiKey: "" })
      .then((result) => !cancelled && setConnection(result))
      .catch(() => undefined); // Connect shows the error when pressed.
    return () => {
      cancelled = true;
    };
  }, [savedBaseUrl]);

  if (!config) return <Loading>Loading configuration</Loading>;

  const form: SetupInput = {
    apiBaseUrl: config.apiBaseUrl,
    apiKey: "",
    phoneNumber: config.phoneNumber,
    callbackSigningSecret: "",
    ...edits,
  };
  const update = (patch: Partial<SetupInput>) =>
    setEdits({ ...edits, ...patch });
  // Another key or base URL can mean another account, so the loaded numbers no longer apply.
  const updateCredentials = (patch: Partial<SetupInput>) => {
    setConnection(null);
    update(patch);
  };

  const { callbackUrl } = config;
  const selected = connection?.numbers.find(
    (number) => number.number === form.phoneNumber
  );

  const connect = async () => {
    setBusy("connect");
    try {
      const result = await api.connect({
        apiBaseUrl: form.apiBaseUrl,
        apiKey: form.apiKey,
      });
      setConnection(result);
      // Keep the number in the form when the account has it; otherwise take the line for
      // app calls, or the first number.
      if (!result.numbers.some((n) => n.number === form.phoneNumber)) {
        const pick =
          result.numbers.find((n) => n.default_for_app_calls) ??
          result.numbers[0];
        if (pick) update({ phoneNumber: pick.number });
      }
      toast.success(
        `Connected to ${result.account.name ?? "your account"}: ${result.numbers.length} voice ${result.numbers.length === 1 ? "number" : "numbers"}.`
      );
    } catch (connectError) {
      setConnection(null);
      toast.error(describeError(connectError));
    } finally {
      setBusy(null);
    }
  };

  const routeToThisApp = async () => {
    if (!connection) return;
    setBusy("route");
    try {
      const routed = await api.routeNumber({
        apiBaseUrl: form.apiBaseUrl,
        apiKey: form.apiKey,
        number: form.phoneNumber,
      });
      update({ callbackSigningSecret: routed.callbackSecret });
      setConnection({
        ...connection,
        numbers: [
          ...connection.numbers.filter(
            (n) => n.number !== routed.number.number
          ),
          routed.number,
        ].sort((a, b) => a.number.localeCompare(b.number)),
      });
      toast.success(
        `Calls to ${routed.number.number} now come to this app. Save to keep its signing secret.`
      );
    } catch (routeError) {
      toast.error(describeError(routeError));
    } finally {
      setBusy(null);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveSetup(form);
      setResult(saved);
      setConfig(saved.config);
      setEdits({});
      toast.success(
        `Saved. The API key belongs to ${saved.account.name ?? "your account"}.`
      );
    } catch (saveError) {
      setError(describeError(saveError));
      toast.error(describeError(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <form onSubmit={submit} className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Sent API</CardTitle>
            <CardDescription>
              The API key from the dashboard&apos;s API keys page. The key stays
              on this server and is only ever shown masked.
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-4">
            <div className="grid gap-2">
              <Label htmlFor="apiBaseUrl">API base URL</Label>
              <Input
                id="apiBaseUrl"
                value={form.apiBaseUrl}
                placeholder="https://api.sent.dm"
                onChange={(event) =>
                  updateCredentials({ apiBaseUrl: event.target.value })
                }
                aria-invalid={!form.apiBaseUrl}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="apiKey">API key</Label>
              <Input
                id="apiKey"
                type="password"
                autoComplete="off"
                value={form.apiKey}
                placeholder={config.apiKeyMasked || "sntdm_..."}
                onChange={(event) =>
                  updateCredentials({ apiKey: event.target.value })
                }
              />
              {config.configured && (
                <p className="text-muted-foreground text-xs">
                  Leave empty to keep the saved key.
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={busy !== null || !form.apiBaseUrl}
                onClick={connect}
              >
                {busy === "connect" && <Spinner />}
                {connection ? "Reconnect" : "Connect"}
              </Button>
              <span className="text-muted-foreground text-sm">
                {connection ? (
                  <>
                    Connected to {connection.account.name ?? "your account"}
                    {connection.account.type && (
                      <Badge variant="secondary" className="ml-2">
                        {connection.account.type}
                      </Badge>
                    )}
                  </>
                ) : (
                  "Checks the key and loads your voice numbers. Nothing is saved yet."
                )}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Voice number</CardTitle>
            <CardDescription>
              The voice-enabled number from the dashboard&apos;s Voice tab.
              Tokens minted here are bound to it, and its signing secret
              verifies the questions Sent sends to this app.
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-4">
            <div className="grid gap-2">
              <Label htmlFor="phoneNumber">Phone number (E.164)</Label>
              {connection && connection.numbers.length > 0 ? (
                <NativeSelect
                  className="w-full"
                  id="phoneNumber"
                  value={form.phoneNumber}
                  onChange={(event) =>
                    update({ phoneNumber: event.target.value })
                  }
                >
                  {!selected && (
                    <NativeSelectOption value={form.phoneNumber}>
                      {form.phoneNumber || "Pick a number"}
                    </NativeSelectOption>
                  )}
                  {connection.numbers.map((number) => (
                    <NativeSelectOption
                      key={number.number}
                      value={number.number}
                    >
                      {numberLabel(number)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : (
                <Input
                  id="phoneNumber"
                  value={form.phoneNumber}
                  placeholder="+14155551234"
                  onChange={(event) =>
                    update({ phoneNumber: event.target.value })
                  }
                />
              )}
              {connection && connection.numbers.length === 0 && (
                <p className="text-muted-foreground text-xs">
                  No number on this account has phone calls turned on. Enter one
                  you hold, and Route to this app turns them on for it.
                </p>
              )}
            </div>
            {connection && form.phoneNumber && (
              <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
                <p>{routingSummary(selected, callbackUrl)}</p>
                <div>
                  <Button
                    type="button"
                    size="sm"
                    variant={
                      selected?.callback_url === callbackUrl
                        ? "outline"
                        : "default"
                    }
                    disabled={busy !== null || !config.publicBaseUrl}
                    onClick={routeToThisApp}
                  >
                    {busy === "route" && <Spinner />}
                    Route to this app
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  {callbackUrl
                    ? `Sets the number's callback URL to ${callbackUrl} and fills in the signing secret Sent returns.`
                    : "Waits for the public URL below."}
                </p>
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="secret">Callback signing secret</Label>
              <Input
                id="secret"
                type="password"
                autoComplete="off"
                value={form.callbackSigningSecret}
                placeholder={config.callbackSigningSecretMasked || "whsec_..."}
                onChange={(event) =>
                  update({ callbackSigningSecret: event.target.value })
                }
              />
              <p className="text-muted-foreground text-xs">
                Filled in by Route to this app, or copy it from the
                number&apos;s page in the dashboard. Paste it again after
                rotating it there.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Public URL</CardTitle>
            <CardDescription>
              Sent sends call questions and webhooks here, and other devices
              open the phone here.
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-4">
            <PublicUrl config={config} />
            {config.configured && config.publicUrlChanged && (
              <Alert>
                <AlertTitle>
                  The public URL changed since the last save
                </AlertTitle>
                <AlertDescription>
                  The tunnel opens a new URL each time the app starts. Press
                  Route to this app, then Save, so calls and webhooks come to
                  this URL.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {config.setupPasswordRequired && (
          <Card size="sm">
            <CardHeader>
              <CardTitle>Setup password</CardTitle>
              <CardDescription>
                This server has SETUP_PASSWORD set. Configuration changes need
                it; it is kept for this browser session only.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Input
                type="password"
                autoComplete="off"
                placeholder="Setup password"
                onChange={(event) => setSetupPassword(event.target.value)}
              />
            </CardContent>
          </Card>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Not saved</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {result && (
          <Alert>
            <AlertTitle>
              Saved for {result.account.name ?? "your account"}{" "}
              {result.account.type && (
                <Badge variant="secondary">{result.account.type}</Badge>
              )}
            </AlertTitle>
            <AlertDescription>
              {result.warnings.length === 0
                ? "The API key was accepted by the Sent API."
                : result.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
            </AlertDescription>
          </Alert>
        )}

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={saving}>
            {saving && <Spinner />}
            {config.configured ? "Save changes" : "Save and validate"}
          </Button>
          {config.updatedAt && (
            <span className="text-muted-foreground text-xs">
              Last saved {new Date(config.updatedAt).toLocaleString()}
            </span>
          )}
        </div>
      </form>

      <Card size="sm" className="self-start">
        <CardHeader>
          <CardTitle>Before the first call</CardTitle>
          <CardDescription>What has to exist on the Sent side.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="text-muted-foreground list-decimal space-y-2 pl-4 text-sm">
            <li>Voice is enabled for your account.</li>
            <li>
              A number you hold. Connect loads your voice numbers, and Route to
              this app points one at this app and fills in its signing secret.
            </li>
            <li>An API key from the dashboard&apos;s API keys page.</li>
            <li>{publicUrlNeeds(config.tunnel)}</li>
            <li>A positive balance for calls that reach a phone.</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

/** The public URL, or how far the tunnel has got. */
function PublicUrl({ config }: { config: PublicConfig }) {
  const { publicBaseUrl, tunnel } = config;
  if (publicBaseUrl) {
    return (
      <CopyRow
        label={
          tunnel.state === "off"
            ? "From PUBLIC_BASE_URL"
            : tunnel.provider === "cloudflare"
              ? "Cloudflare quick tunnel, a new URL on every start"
              : tunnel.fixedUrl
                ? "ngrok tunnel on NGROK_DOMAIN, the same URL on every start"
                : "ngrok tunnel, a new URL on every start"
        }
        value={publicBaseUrl}
      />
    );
  }
  if (tunnel.state === "opening") {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner /> Opening{" "}
        {tunnel.provider === "cloudflare"
          ? "a Cloudflare quick tunnel"
          : "an ngrok tunnel"}{" "}
        to this app
      </p>
    );
  }
  return (
    <p className="text-destructive text-sm">
      {tunnel.error ?? "This app has no public URL."} Set PUBLIC_BASE_URL in
      .env to use a URL of your own.
    </p>
  );
}

/** What the public URL needs, for the checklist. */
function publicUrlNeeds(tunnel: TunnelInfo): string {
  if (tunnel.state === "off")
    return "A public HTTPS URL, from PUBLIC_BASE_URL.";
  if (tunnel.provider === "cloudflare") {
    return "Internet access to Cloudflare. The app opens its public URL by itself.";
  }
  return "A free ngrok account, with its authtoken in NGROK_AUTHTOKEN or saved by the ngrok CLI. The app opens its public URL by itself.";
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="grid gap-1">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <code className="bg-muted flex-1 truncate rounded-md px-2 py-1.5 text-xs">
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={copy}
          aria-label="Copy"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
    </div>
  );
}

function numberLabel(number: VoiceNumberResponse): string {
  const notes = [
    number.default_for_app_calls ? "line for app calls" : null,
    number.status.toUpperCase() === "ACTIVE"
      ? null
      : number.status.toLowerCase(),
  ].filter(Boolean);
  return notes.length
    ? `${number.number} (${notes.join(", ")})`
    : number.number;
}

/** Where calls to the number go now, next to where Route to this app would send them. */
function routingSummary(
  number: VoiceNumberResponse | undefined,
  callbackUrl: string
): string {
  if (!number)
    return "Phone calls are not on for this number yet. Route to this app turns them on.";
  if (number.callback_url === callbackUrl)
    return "Calls to this number already come to this app.";
  if (number.callback_url)
    return `Calls to this number go to ${number.callback_url}. Route to this app sends them here instead.`;
  return "This number has no callback URL yet. Route to this app sets this app's.";
}
