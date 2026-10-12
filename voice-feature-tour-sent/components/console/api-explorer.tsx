"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { cn } from "cn";
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
import { Textarea } from "@/components/ui/textarea";
import { JsonView } from "@/components/json-view";
import { api } from "@/lib/client/api";
import { describeError } from "@/lib/client/format";
import {
  API_CATALOG,
  type EndpointDefinition,
  type EndpointField,
} from "@/lib/shared/api-catalog";
import type {
  ProxyResponse,
  PublicConfig,
  HttpMethod,
} from "@/lib/shared/types";

const methodVariant: Record<HttpMethod, BadgeVariants> = {
  GET: "success",
  POST: "default",
  PUT: "secondary",
  PATCH: "secondary",
  DELETE: "destructive",
};

const groups: { id: EndpointDefinition["group"]; label: string }[] = [
  { id: "account", label: "Account" },
  { id: "voice", label: "Voice" },
  { id: "webhooks", label: "Webhooks" },
];

/**
 * A form for every public endpoint. The request goes through this app's server, which adds the
 * API key, and everything about the exchange comes back: the URL, both header sets, the raw
 * body and the elapsed time.
 */
export function ApiExplorer({ config }: { config: PublicConfig }) {
  const [selectedId, setSelectedId] = useState(API_CATALOG[0].id);
  const endpoint = API_CATALOG.find((entry) => entry.id === selectedId)!;
  const [values, setValues] = useState<Record<string, string>>({});
  // The body typed by hand, if any. Otherwise the body is built from the fields.
  const [bodyOverride, setBodyOverride] = useState<string | null>(null);
  const [response, setResponse] = useState<ProxyResponse | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setValues(defaultsFor(endpoint, config));
    setBodyOverride(null);
    setResponse(null);
  }, [endpoint, config]);

  const generatedBody = useMemo(
    () => buildBody(endpoint, values),
    [endpoint, values]
  );
  const rawBody =
    bodyOverride ??
    (generatedBody === undefined ? "" : JSON.stringify(generatedBody, null, 2));

  const hasBody = endpoint.fields.some((field) => field.in === "body");

  const send = async () => {
    setSending(true);
    setResponse(null);
    try {
      let body: unknown = undefined;
      if (hasBody && rawBody.trim()) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          throw new Error("The body is not valid JSON");
        }
      }
      const result = await api.proxy({
        method: endpoint.method,
        path: fillPath(endpoint.path, values),
        query: queryFor(endpoint, values),
        body,
      });
      setResponse(result);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <Card size="sm" className="self-start">
        <CardContent className="gap-4">
          {groups.map((group) => (
            <div key={group.id} className="grid gap-1">
              <p className="text-muted-foreground px-2 text-xs font-medium uppercase">
                {group.label}
              </p>
              {API_CATALOG.filter((entry) => entry.group === group.id).map(
                (entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setSelectedId(entry.id)}
                    className={cn(
                      "hover:bg-muted flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                      entry.id === selectedId && "bg-muted"
                    )}
                  >
                    <Badge
                      variant={methodVariant[entry.method]}
                      className="w-14 justify-center"
                    >
                      {entry.method}
                    </Badge>
                    <span className="truncate">{entry.summary}</span>
                  </button>
                )
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              <Badge variant={methodVariant[endpoint.method]}>
                {endpoint.method}
              </Badge>
              <code className="text-sm">{endpoint.path}</code>
            </CardTitle>
            <CardDescription>{endpoint.description}</CardDescription>
          </CardHeader>
          <CardContent className="gap-4">
            {(["path", "query", "body"] as const).map((location) => {
              const fields = endpoint.fields.filter(
                (field) => field.in === location
              );
              if (fields.length === 0) return null;
              return (
                <div key={location} className="grid gap-3">
                  <p className="text-muted-foreground text-xs font-medium uppercase">
                    {location} parameters
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {fields.map((field) => (
                      <FieldInput
                        key={field.name}
                        field={field}
                        value={values[field.name] ?? ""}
                        onChange={(next) => {
                          setValues((current) => ({
                            ...current,
                            [field.name]: next,
                          }));
                          if (field.in === "body") setBodyOverride(null);
                        }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
            {hasBody && (
              <div className="grid gap-1.5">
                <Label htmlFor="rawBody">Request body (editable JSON)</Label>
                <Textarea
                  id="rawBody"
                  className="min-h-32 font-mono text-xs"
                  value={rawBody}
                  onChange={(event) => setBodyOverride(event.target.value)}
                />
              </div>
            )}
            <div className="flex items-center gap-3">
              <Button type="button" onClick={send} disabled={sending}>
                {sending && <Spinner />}
                Send to {config.apiBaseUrl}
              </Button>
              <span className="text-muted-foreground text-xs">
                Real request with your API key. Nothing is simulated.
              </span>
            </div>
          </CardContent>
        </Card>

        {response && <ResponseCard response={response} />}
      </div>
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: EndpointField;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `field-${field.in}-${field.name}`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {field.name}
        {field.required && <span className="text-destructive">*</span>}
      </Label>
      {field.type === "enum" ? (
        <NativeSelect
          className="w-full"
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {(field.options ?? []).map((option) => (
            <NativeSelectOption key={option} value={option}>
              {option === "" ? "(any)" : option}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : field.type === "boolean" ? (
        <NativeSelect
          className="w-full"
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <NativeSelectOption value="true">true</NativeSelectOption>
          <NativeSelectOption value="false">false</NativeSelectOption>
        </NativeSelect>
      ) : (
        <Input
          id={id}
          value={value}
          placeholder={field.placeholder ?? (field.type === "json" ? "{}" : "")}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {field.description && (
        <p className="text-muted-foreground text-xs">{field.description}</p>
      )}
    </div>
  );
}

function ResponseCard({ response }: { response: ProxyResponse }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Badge variant={response.ok ? "success" : "destructive"}>
            {response.status || "no response"}
          </Badge>
          <span className="text-muted-foreground text-sm font-normal">
            {response.durationMs} ms
          </span>
          <code className="truncate text-xs font-normal">{response.url}</code>
        </CardTitle>
      </CardHeader>
      <CardContent className="gap-3">
        <details>
          <summary className="cursor-pointer text-sm">Request headers</summary>
          <JsonView value={response.requestHeaders} className="mt-1" />
        </details>
        <details>
          <summary className="cursor-pointer text-sm">Response headers</summary>
          <JsonView value={response.responseHeaders} className="mt-1" />
        </details>
        <div>
          <p className="mb-1 text-sm">Response body</p>
          <JsonView
            value={response.body ?? response.rawBody}
            maxHeight="32rem"
          />
        </div>
      </CardContent>
    </Card>
  );
}

function defaultsFor(
  endpoint: EndpointDefinition,
  config: PublicConfig
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of endpoint.fields) {
    if (field.default !== undefined) values[field.name] = String(field.default);
    else if (field.type === "enum")
      values[field.name] = field.options?.[0] ?? "";
    else if (field.type === "boolean") values[field.name] = "true";
    else values[field.name] = "";
    if (field.name === "number" && endpoint.group === "voice")
      values[field.name] = config.phoneNumber;
    if (field.name === "endpoint_url")
      values[field.name] = config.webhookEndpointUrl;
  }
  return values;
}

function fillPath(path: string, values: Record<string, string>): string {
  return path.replace(/\{(\w+)\}/g, (_, name: string) =>
    encodeURIComponent(values[name] ?? "")
  );
}

function queryFor(
  endpoint: EndpointDefinition,
  values: Record<string, string>
): Record<string, string> {
  const query: Record<string, string> = {};
  for (const field of endpoint.fields) {
    if (field.in !== "query") continue;
    const value = values[field.name];
    if (value !== undefined && value !== "") query[field.name] = value;
  }
  return query;
}

function buildBody(
  endpoint: EndpointDefinition,
  values: Record<string, string>
): unknown {
  const bodyFields = endpoint.fields.filter((field) => field.in === "body");
  if (bodyFields.length === 0) return undefined;
  const body: Record<string, unknown> = {};
  for (const field of bodyFields) {
    const raw = values[field.name];
    if (raw === undefined || raw === "") continue;
    let value: unknown = raw;
    if (field.type === "number") value = Number(raw);
    else if (field.type === "boolean") value = raw === "true";
    else if (field.type === "list")
      value = raw
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    else if (field.type === "json") {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    setNested(body, field.name.split("."), value);
  }
  return body;
}

function setNested(
  target: Record<string, unknown>,
  path: string[],
  value: unknown
): void {
  const [head, ...rest] = path;
  if (rest.length === 0) {
    target[head] = value;
    return;
  }
  const next = (target[head] ??= {}) as Record<string, unknown>;
  setNested(next, rest, value);
}
