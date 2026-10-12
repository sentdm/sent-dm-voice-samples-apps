"use client";

import { useCallback, useEffect, useState } from "react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { JsonView } from "@/components/json-view";
import { RecordingLinks } from "@/components/recording-links";
import { api, unwrapProxy } from "@/lib/client/api";
import {
  describeError,
  formatDateTime,
  formatDuration,
  formatParty,
  shortCallId,
} from "@/lib/client/format";
import type {
  PublicConfig,
  VoiceCallRecord,
  VoiceCallsListResponse,
  VoiceRecordingResponse,
  VoiceRecordingsResponse,
} from "@/lib/shared/types";

const statusVariant: Record<string, BadgeVariants> = {
  INITIATED: "secondary",
  RINGING: "secondary",
  ANSWERED: "success",
  COMPLETED: "outline",
  FAILED: "destructive",
  NO_ANSWER: "destructive",
  REJECTED: "destructive",
};

interface Filters {
  direction: string;
  status: string;
  number: string;
  page: number;
  page_size: number;
}

/** Browses GET /v3/calls with every filter, and runs the call commands on one call. */
export function CallLog({ config }: { config: PublicConfig }) {
  const [filters, setFilters] = useState<Filters>({
    direction: "",
    status: "",
    number: "",
    page: 1,
    page_size: 20,
  });
  // The text filters as typed. They reach `filters`, and so the API, 300 ms after the last key.
  const [typed, setTyped] = useState({ number: "", page_size: 20 });
  const [list, setList] = useState<VoiceCallsListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<VoiceCallRecord | null>(null);
  const [actionResult, setActionResult] = useState<{
    label: string;
    result: unknown;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<{
    callId: string;
    items: VoiceRecordingResponse[];
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query: Record<string, string> = {
        page: String(filters.page),
        page_size: String(filters.page_size),
      };
      if (filters.direction) query.direction = filters.direction;
      if (filters.status) query.status = filters.status;
      if (filters.number) query.number = filters.number;
      setList(
        await api.sent<VoiceCallsListResponse>({
          method: "GET",
          path: "/v3/calls",
          query,
        })
      );
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setTimeout(
      () =>
        setFilters((current) =>
          current.number === typed.number &&
          current.page_size === typed.page_size
            ? current
            : { ...current, ...typed, page: 1 }
        ),
      300
    );
    return () => clearTimeout(timer);
  }, [typed]);

  const open = async (id: string) => {
    setActionResult(null);
    try {
      setSelected(
        await api.sent<VoiceCallRecord>({
          method: "GET",
          path: `/v3/calls/${id}`,
        })
      );
    } catch (error) {
      toast.error(describeError(error));
    }
  };

  const act = async (
    label: string,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown
  ) => {
    if (!selected) return;
    setBusy(label);
    try {
      const response = await api.proxy({
        method,
        path: `/v3/calls/${selected.id}${path}`,
        body,
      });
      const result = unwrapProxy<unknown>(response);
      setActionResult({
        label: `${label}: ${response.status}`,
        result: result ?? "(no body)",
      });
      if (label === "Recording links") {
        // One item per recording, oldest first; shown as links under the buttons.
        const items =
          (result as VoiceRecordingsResponse | null)?.recordings ?? [];
        setRecordings({ callId: selected.id, items });
        if (items.length === 0) toast.info("No recording yet");
      }
      toast.success(`${label}: ${response.status}`);
      void open(selected.id);
    } catch (error) {
      setActionResult({
        label: `${label} failed`,
        result: describeError(error),
      });
      toast.error(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_26rem]">
      <Card>
        <CardHeader>
          <CardTitle>Calls</CardTitle>
          <CardDescription>
            GET /v3/calls on {config.apiBaseUrl}, most recent first.
          </CardDescription>
        </CardHeader>
        <CardContent className="gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label>Direction</Label>
              <NativeSelect
                value={filters.direction}
                onChange={(event) =>
                  setFilters({
                    ...filters,
                    direction: event.target.value,
                    page: 1,
                  })
                }
              >
                <NativeSelectOption value="">any</NativeSelectOption>
                <NativeSelectOption value="outbound">
                  outbound
                </NativeSelectOption>
                <NativeSelectOption value="inbound">inbound</NativeSelectOption>
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label>Status</Label>
              <NativeSelect
                value={filters.status}
                onChange={(event) =>
                  setFilters({
                    ...filters,
                    status: event.target.value,
                    page: 1,
                  })
                }
              >
                <NativeSelectOption value="">any</NativeSelectOption>
                {Object.keys(statusVariant).map((status) => (
                  <NativeSelectOption key={status} value={status}>
                    {status}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label>Owning number</Label>
              <Input
                className="w-44"
                value={typed.number}
                placeholder={config.phoneNumber}
                onChange={(event) =>
                  setTyped({ ...typed, number: event.target.value })
                }
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Page size</Label>
              <Input
                className="w-20"
                type="number"
                min={1}
                max={100}
                value={typed.page_size}
                onChange={(event) =>
                  setTyped({
                    ...typed,
                    page_size: Number(event.target.value) || 20,
                  })
                }
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void load()}
              disabled={loading}
            >
              {loading && <Spinner />}
              Refresh
            </Button>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Call</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Price</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list?.calls.map((call) => (
                <TableRow
                  key={call.id}
                  className="cursor-pointer"
                  onClick={() => void open(call.id)}
                >
                  <TableCell className="font-mono text-xs">
                    {shortCallId(call.id)}
                  </TableCell>
                  <TableCell>{call.direction}</TableCell>
                  <TableCell>{formatParty(call.from)}</TableCell>
                  <TableCell>{formatParty(call.to)}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant[call.status] ?? "outline"}>
                      {call.status}
                    </Badge>
                    {call.recording_available && (
                      <Badge variant="success" className="ml-1">
                        recording
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{formatDateTime(call.started_at)}</TableCell>
                  <TableCell>
                    {call.duration_seconds === null
                      ? ""
                      : formatDuration(call.duration_seconds)}
                  </TableCell>
                  <TableCell>{call.price ?? ""}</TableCell>
                </TableRow>
              ))}
              {list && list.calls.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="text-muted-foreground text-center"
                  >
                    No calls match.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {list && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Page {list.pagination.page} of {list.pagination.total_pages} (
                {list.pagination.total_count} calls)
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={filters.page <= 1}
                  onClick={() =>
                    setFilters({ ...filters, page: filters.page - 1 })
                  }
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!list.pagination.has_more}
                  onClick={() =>
                    setFilters({ ...filters, page: filters.page + 1 })
                  }
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card size="sm" className="self-start">
        <CardHeader>
          <CardTitle>Call detail</CardTitle>
          <CardDescription>
            GET /v3/calls/{"{id}"} with the status timeline, and the call
            commands.
          </CardDescription>
        </CardHeader>
        <CardContent className="gap-3">
          {!selected ? (
            <p className="text-muted-foreground text-sm">
              Pick a call from the list.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-xs">{selected.id}</code>
                <Badge variant={statusVariant[selected.status] ?? "outline"}>
                  {selected.status}
                </Badge>
                {selected.failure_reason && (
                  <Badge variant="destructive">{selected.failure_reason}</Badge>
                )}
              </div>
              {selected.timeline && (
                <ol className="text-xs">
                  {selected.timeline.map((entry) => (
                    <li
                      key={`${entry.status}-${entry.timestamp}`}
                      className="flex justify-between gap-2"
                    >
                      <span>{entry.status}</span>
                      <span className="text-muted-foreground">
                        {formatDateTime(entry.timestamp)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => act("Hang up", "POST", "/hangup")}
                >
                  Hang up
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    act("Start recording", "POST", "/recordings", {
                      action: "start",
                    })
                  }
                >
                  Record
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    act("Stop recording", "POST", "/recordings", {
                      action: "stop",
                    })
                  }
                >
                  Stop recording
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={busy !== null || !selected.recording_available}
                  onClick={() => act("Recording links", "GET", "/recordings")}
                >
                  Recording links
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => act("Participants", "GET", "/participants")}
                >
                  Participants
                </Button>
              </div>
              {recordings?.callId === selected.id &&
                recordings.items.length > 0 && (
                  <RecordingLinks recordings={recordings.items} />
                )}
              {actionResult && (
                <div>
                  <p className="text-xs font-medium">{actionResult.label}</p>
                  <JsonView
                    value={actionResult.result}
                    className="mt-1"
                    maxHeight="14rem"
                  />
                </div>
              )}
              <details>
                <summary className="text-muted-foreground cursor-pointer text-xs">
                  full record
                </summary>
                <JsonView value={selected} className="mt-1" />
              </details>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
