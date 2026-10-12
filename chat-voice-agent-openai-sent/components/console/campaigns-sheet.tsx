import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Megaphone, Pause, Play, Plus, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useConsole, type CampaignInput } from "@/lib/console-context"
import { guessNameColumn, guessPhoneColumn, parseCsv } from "@/lib/csv"
import { CHANNEL_LABEL, formatClock } from "@/lib/format"
import { toE164 } from "@/lib/phone"
import type { CampaignSummary, Channel } from "@/lib/types"
import { cn } from "@/lib/utils"

export function CampaignsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [creating, setCreating] = useState(false)
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setCreating(false)
      }}
    >
      <SheetContent className="w-full gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="text-base">{creating ? "New campaign" : "Campaigns"}</SheetTitle>
          <SheetDescription>Send an approved template to a list of contacts. The agent handles their replies and calls, following your scenario.</SheetDescription>
        </SheetHeader>
        {creating ? <NewCampaign onDone={() => setCreating(false)} /> : <CampaignList onNew={() => setCreating(true)} />}
      </SheetContent>
    </Sheet>
  )
}

function CampaignList({ onNew }: { onNew: () => void }) {
  const { state, live } = useConsole()
  const ready = live.system.phase === "ready"
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
      <div className="flex items-center gap-3">
        <Button onClick={onNew} disabled={!ready || state.templates.length === 0}>
          <Plus />
          New campaign
        </Button>
        <p className="text-xs text-muted-foreground">
          {!ready
            ? "Start the agent first: replies and calls reach the app only while it runs."
            : state.templates.length === 0
              ? "You need an approved template in Sent."
              : "Your own programs can start campaigns too, with POST /api/campaigns. See the README."}
        </p>
      </div>
      {state.campaigns.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">No campaigns yet.</p>
      ) : (
        <ul className="space-y-3">
          {state.campaigns.map((campaign) => (
            <CampaignCard key={campaign.id} campaign={campaign} />
          ))}
        </ul>
      )}
    </div>
  )
}

const STATUS_LABEL: Record<CampaignSummary["status"], string> = { sending: "Sending", done: "Done", stopped: "Stopped" }

function CampaignCard({ campaign: c }: { campaign: CampaignSummary }) {
  const { actions } = useConsole()
  const handled = c.sent + c.failed + c.skipped
  const stats: Array<[string, number, string?]> = [
    ["Sent", c.sent],
    ["Replied", c.replied, "text-agent"],
    ["Called", c.called, "text-ok"],
    ["Failed", c.failed, c.failed ? "text-live" : undefined],
    ["Skipped", c.skipped],
  ]
  return (
    <li className="space-y-3 rounded-md border bg-panel p-3.5">
      <div className="flex items-start gap-2">
        <Megaphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{c.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            Template “{c.templateName}”{c.channel ? ` by ${CHANNEL_LABEL[c.channel]}` : ""}, started {formatClock(c.createdAt)}
          </p>
        </div>
        <span className={cn("rounded-sm px-1.5 py-0.5 text-[11px] font-medium", c.status === "sending" ? "bg-agent-soft text-agent" : c.status === "done" ? "bg-ok-soft text-ok" : "bg-muted text-muted-foreground")}>
          {STATUS_LABEL[c.status]}
        </span>
      </div>
      <div className="space-y-1">
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={c.total} aria-valuenow={handled} aria-label="Contacts handled">
          <div className="h-full bg-agent transition-[width]" style={{ width: `${c.total ? (handled / c.total) * 100 : 0}%` }} />
        </div>
        <p className="font-mono text-[11px] text-muted-foreground">
          {handled} of {c.total} contacts handled{c.queued ? `, ${c.queued} to go` : ""}
        </p>
      </div>
      <dl className="grid grid-cols-5 gap-2 text-center">
        {stats.map(([label, value, tone]) => (
          <div key={label} className="rounded-sm bg-muted/60 px-1 py-1.5">
            <dd className={cn("font-mono text-sm font-semibold", tone)}>{value}</dd>
            <dt className="text-[11px] text-muted-foreground">{label}</dt>
          </div>
        ))}
      </dl>
      <p className="line-clamp-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Scenario: </span>
        {c.scenario}
      </p>
      <div className="flex gap-2">
        {c.status === "sending" && (
          <Button size="sm" variant="outline" onClick={() => actions.stopCampaign(c.id)}>
            <Pause />
            Stop sending
          </Button>
        )}
        {c.status === "stopped" && c.queued > 0 && (
          <Button size="sm" variant="outline" onClick={() => actions.resumeCampaign(c.id)}>
            <Play />
            Resume
          </Button>
        )}
        <p className="ml-auto self-center text-[11px] text-muted-foreground">Search the inbox for “{c.name}” to see its conversations.</p>
      </div>
    </li>
  )
}

const SAME = "__same__"
const NONE = "__none__"

function NewCampaign({ onDone }: { onDone: () => void }) {
  const { state, actions } = useConsole()
  const [name, setName] = useState(`Campaign ${new Date().toLocaleDateString()}`)
  const [templateId, setTemplateId] = useState(state.templates[0]?.id ?? "")
  const [csv, setCsv] = useState("")
  const [phoneColumn, setPhoneColumn] = useState("")
  const [nameColumn, setNameColumn] = useState("")
  const [mapping, setMapping] = useState<Record<string, { column: string; value: string }>>({})
  const [channel, setChannel] = useState<Channel | "auto">("auto")
  const [scenario, setScenario] = useState("")
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)

  const template = state.templates.find((t) => t.id === templateId)
  const parsed = useMemo(() => parseCsv(csv), [csv])
  const phoneCol = phoneColumn || guessPhoneColumn(parsed.headers) || ""
  const nameCol = nameColumn === NONE ? "" : nameColumn || guessNameColumn(parsed.headers) || ""
  /** A template variable takes a column with the same name, unless you chose otherwise. */
  const sourceFor = (variable: string) =>
    mapping[variable] ?? { column: parsed.headers.find((h) => h.toLowerCase() === variable.toLowerCase()) ?? SAME, value: "" }

  const recipients: CampaignInput["recipients"] = parsed.rows.map((row) => ({
    phone: row[phoneCol] ?? "",
    name: nameCol ? row[nameCol] || undefined : undefined,
    variables: Object.fromEntries((template?.variables ?? []).map((v) => {
      const source = sourceFor(v)
      return [v, source.column === SAME ? source.value : (row[source.column] ?? "")]
    })),
  }))
  const valid = recipients.filter((r) => toE164(r.phone.replace(/^00/, "+"))).length
  const missingValue = (template?.variables ?? []).find((v) => sourceFor(v).column === SAME && !sourceFor(v).value.trim())
  const canSend = !!template && valid > 0 && scenario.trim().length > 0 && !missingValue && recipients.length <= 1000

  const submit = async () => {
    if (!template || !canSend) return
    if (!armed) return setArmed(true)
    setBusy(true)
    try {
      await actions.createCampaign({ name, templateId: template.id, scenario, channel: channel === "auto" ? undefined : channel, recipients })
      toast.success(`Campaign started: sending to ${valid} contact${valid === 1 ? "" : "s"}.`)
      onDone()
    } catch (error) {
      toast.error((error as Error).message)
      setArmed(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="campaign-name">Name</FieldLabel>
            <Input id="campaign-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            <FieldDescription>Each contact’s conversation is tagged with it, so the inbox search finds them.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="campaign-template">First message: an approved template</FieldLabel>
            <Select value={templateId} onValueChange={(v) => { setTemplateId(v); setMapping({}); setArmed(false) }}>
              <SelectTrigger id="campaign-template" className="w-full">
                <SelectValue placeholder="Choose a template" />
              </SelectTrigger>
              <SelectContent>
                {state.templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                    <span className="text-muted-foreground">{t.category.toLowerCase()}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>Sent requires a template to text people who haven’t written to you.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="campaign-csv">Contacts (CSV)</FieldLabel>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" asChild>
                <label className="cursor-pointer">
                  <Upload />
                  Choose a file
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="sr-only"
                    onChange={async (e) => {
                      const file = e.target.files?.[0]
                      if (file) {
                        setCsv(await file.text())
                        setPhoneColumn("")
                        setNameColumn("")
                        setMapping({})
                        setArmed(false)
                      }
                    }}
                  />
                </label>
              </Button>
              <span className="text-xs text-muted-foreground">or paste it below</span>
            </div>
            <Textarea
              id="campaign-csv"
              rows={4}
              className="font-mono text-xs"
              placeholder={"phone,name,meetingDetails\n+14155550142,Ana,Tuesday 10:00"}
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value)
                setArmed(false)
              }}
            />
            <FieldDescription>
              {parsed.rows.length
                ? `${parsed.rows.length} rows, ${valid} with a number in international format.${parsed.rows.length > 1000 ? " A campaign can have at most 1,000 contacts." : ""}`
                : "The first row names the columns. Numbers need + and the country code, for example +14155551234."}
            </FieldDescription>
          </Field>

          {parsed.headers.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="phone-column">Phone column</FieldLabel>
                <Select value={phoneCol} onValueChange={(v) => { setPhoneColumn(v); setArmed(false) }}>
                  <SelectTrigger id="phone-column" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {parsed.headers.map((h) => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="name-column">Name column</FieldLabel>
                <Select value={nameCol || NONE} onValueChange={setNameColumn}>
                  <SelectTrigger id="name-column" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>None</SelectItem>
                    {parsed.headers.map((h) => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )}

          {template && template.variables.length > 0 && (
            <Field>
              <FieldLabel>Template variables</FieldLabel>
              <div className="space-y-2">
                {template.variables.map((variable) => {
                  const source = sourceFor(variable)
                  return (
                    <div key={variable} className="grid items-center gap-2 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)]">
                      <span className="font-mono text-xs">{variable}</span>
                      <Select value={source.column} onValueChange={(column) => setMapping({ ...mapping, [variable]: { ...source, column } })}>
                        <SelectTrigger size="sm" className="w-full" aria-label={`Source for ${variable}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={SAME}>Same for everyone</SelectItem>
                          {parsed.headers.map((h) => (
                            <SelectItem key={h} value={h}>
                              Column: {h}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {source.column === SAME && (
                        <Input aria-label={`Value for ${variable}`} value={source.value} onChange={(e) => setMapping({ ...mapping, [variable]: { ...source, value: e.target.value } })} />
                      )}
                    </div>
                  )
                })}
              </div>
            </Field>
          )}

          <Field>
            <FieldLabel htmlFor="campaign-channel">Channel for the first message</FieldLabel>
            <Select value={channel} onValueChange={(v) => setChannel(v as Channel | "auto")}>
              <SelectTrigger id="campaign-channel" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Sent picks</SelectItem>
                {(template?.channels ?? []).map((ch) => (
                  <SelectItem key={ch} value={ch}>
                    {CHANNEL_LABEL[ch]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>Sent picks falls back to another channel when one can’t reach a contact. A chosen channel doesn’t.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="campaign-scenario">Scenario for the agent</FieldLabel>
            <Textarea
              id="campaign-scenario"
              rows={4}
              value={scenario}
              maxLength={2000}
              placeholder="Ask whether they'd like a quick call about their renewal. If they agree, call them. If they say no, thank them and stop."
              onChange={(e) => setScenario(e.target.value)}
            />
            <FieldDescription>The agent follows it in every reply and on every call with these contacts.</FieldDescription>
          </Field>

          {valid > 0 && template && (
            <div className="space-y-1.5 rounded-md border bg-muted/40 p-3 text-xs">
              <p className="font-medium">First contacts</p>
              {recipients.slice(0, 3).map((r, i) => (
                <p key={i} className="truncate font-mono text-muted-foreground">
                  {r.phone || "(no number)"}
                  {r.name ? ` (${r.name})` : ""}
                  {template.variables.length ? `: ${template.variables.map((v) => `${v}=${r.variables[v] || "…"}`).join(", ")}` : ""}
                </p>
              ))}
            </div>
          )}
        </FieldGroup>
      </div>
      <SheetFooter className="flex-row items-center justify-end gap-2 border-t px-5 py-3">
        {armed && <p className="mr-auto text-xs text-warn-ink">Sent bills each message. Click again to send.</p>}
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSend || busy} className={cn(armed && "bg-ink text-panel hover:bg-ink/85")}>
          {busy ? "Starting…" : armed ? `Confirm: send ${valid} message${valid === 1 ? "" : "s"}` : `Send to ${valid} contact${valid === 1 ? "" : "s"}`}
        </Button>
      </SheetFooter>
    </form>
  )
}
