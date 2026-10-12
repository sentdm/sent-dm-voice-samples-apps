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
import { Spinner } from "@/components/ui/spinner";
import { JsonView } from "@/components/json-view";
import { api } from "@/lib/client/api";
import { describeError, formatAddress, formatTime } from "@/lib/client/format";
import type {
  CallbackLogEntry,
  PublicConfig,
  RoutingRules,
  VoiceAction,
} from "@/lib/shared/types";
import { RoutingPanel } from "./routing-panel";
import { signatureVariant } from "./webhooks-inbox";

interface TestVerdict {
  outcome: string;
  call_id: string;
  request: {
    url: string;
    headers: Record<string, string>;
    body: string;
  } | null;
  response: { status_code: number; body: string | null } | null;
  answer: unknown;
  error: { reason: string; path: string | null; message: string } | null;
}

/**
 * Everything about the questions Sent asks: the rules that answer them, a test button that
 * makes Sent send a synthetic question, and the log of every question with its verdict.
 */
export function CallbackStudio({
  config,
  entries,
  rules,
}: {
  config: PublicConfig;
  entries: CallbackLogEntry[];
  rules: RoutingRules | null;
}) {
  const [testing, setTesting] = useState(false);
  const [verdict, setVerdict] = useState<TestVerdict | null>(null);

  const test = async () => {
    setTesting(true);
    setVerdict(null);
    try {
      await api.warmCallback();
      const result = await api.sent<TestVerdict>({
        method: "POST",
        path: `/v3/channels/voice/${encodeURIComponent(config.phoneNumber)}/test`,
      });
      setVerdict(result);
      if (result.outcome === "ok")
        toast.success("Sent reached the callback and accepted the answer");
      else toast.error(`Test outcome: ${result.outcome}`);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <RoutingPanel rules={rules} />
        <Card size="sm" className="self-start">
          <CardHeader>
            <CardTitle>Test the callback</CardTitle>
            <CardDescription>
              POST /v3/channels/voice/{"{number}"}/test makes Sent send a signed
              synthetic call.request to the number&apos;s callback URL,{" "}
              {config.callbackUrl}, and report what came back. No call is
              placed.
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-3">
            <Button type="button" onClick={test} disabled={testing}>
              {testing && <Spinner />}
              Send a test question
            </Button>
            {verdict && (
              <div className="grid gap-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={
                      verdict.outcome === "ok" ? "success" : "destructive"
                    }
                  >
                    {verdict.outcome}
                  </Badge>
                  <code>{verdict.call_id}</code>
                  {verdict.response && (
                    <Badge variant="outline">
                      answered {verdict.response.status_code}
                    </Badge>
                  )}
                </div>
                {verdict.error && (
                  <p className="text-destructive">
                    {verdict.error.reason}
                    {verdict.error.path
                      ? ` at ${verdict.error.path}`
                      : ""}: {verdict.error.message}
                  </p>
                )}
                {verdict.answer !== null && verdict.answer !== undefined && (
                  <details open>
                    <summary className="cursor-pointer">
                      Answer as Sent read it
                    </summary>
                    <JsonView value={verdict.answer} className="mt-1" />
                  </details>
                )}
                {verdict.request && (
                  <details>
                    <summary className="cursor-pointer">
                      What Sent sent (headers and body)
                    </summary>
                    <JsonView
                      value={{
                        url: verdict.request.url,
                        headers: verdict.request.headers,
                      }}
                      className="mt-1"
                    />
                    <JsonView value={verdict.request.body} className="mt-1" />
                  </details>
                )}
                {verdict.response?.body && (
                  <details>
                    <summary className="cursor-pointer">
                      Raw response body
                    </summary>
                    <JsonView value={verdict.response.body} className="mt-1" />
                  </details>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Questions received</CardTitle>
          <CardDescription>
            Every call.request and call.input Sent asked, with the signature
            verdict, the answer given and how long the answer took. Sent waits
            2.5 seconds per attempt.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {entries.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No question yet. Place a call or send a test question.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {entries.map((entry) => (
                <QuestionRow key={entry.id} entry={entry} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function summarizeAction(action: VoiceAction | undefined): string {
  if (!action) return "no answer";
  switch (action.action) {
    case "connectToUser":
      return `connectToUser ${action.identity}`;
    case "connectToNumber":
      return `connectToNumber ${action.number}`;
    case "connectToConference":
      return `connectToConference ${action.name}`;
    case "reject":
      return `reject ${action.reason}`;
    default:
      return action.action;
  }
}

const statusVariant = (status: number): BadgeVariants =>
  status === 200 ? "success" : "destructive";

function QuestionRow({ entry }: { entry: CallbackLogEntry }) {
  const question = entry.question;
  const summary =
    question?.type === "call.request"
      ? `${question.direction}: ${formatAddress(question.from)} to ${formatAddress(question.to)}${question.test ? " (test)" : ""}`
      : question?.type === "call.input"
        ? `keypress: ${question.digits || "(none)"}${question.cookies ? ` cookies ${JSON.stringify(question.cookies)}` : ""}`
        : "unreadable question";
  const actionSummary = summarizeAction(entry.answer?.action);

  return (
    <li className="rounded-md border p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground font-mono">
          {formatTime(entry.receivedAt)}
        </span>
        <Badge variant="outline">{question?.type ?? "invalid"}</Badge>
        <Badge variant={signatureVariant[entry.signature]}>
          signature {entry.signature}
        </Badge>
        {entry.retry && <Badge variant="secondary">retry</Badge>}
        <span>{summary}</span>
        <span className="ml-auto flex items-center gap-2">
          <Badge>{actionSummary}</Badge>
          <Badge variant={statusVariant(entry.statusCode)}>
            {entry.statusCode}
          </Badge>
          <span className="text-muted-foreground">{entry.durationMs} ms</span>
        </span>
      </div>
      <p className="text-muted-foreground mt-1">{entry.explanation}</p>
      {entry.signatureDetail && (
        <p className="text-destructive mt-1">{entry.signatureDetail}</p>
      )}
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <details>
          <summary className="text-muted-foreground cursor-pointer">
            question
          </summary>
          <JsonView value={entry.question ?? entry.rawBody} className="mt-1" />
        </details>
        <details>
          <summary className="text-muted-foreground cursor-pointer">
            answer
          </summary>
          <JsonView value={entry.answer} className="mt-1" />
        </details>
      </div>
      {question?.callId && (
        <p className="text-muted-foreground mt-2 font-mono">
          {question.callId}
        </p>
      )}
    </li>
  );
}
