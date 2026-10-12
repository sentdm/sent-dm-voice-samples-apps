import { useState } from "react"
import { Ban, Bot, FileText, RotateCcw, Route, Send, TriangleAlert, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useConsole } from "@/lib/console-context"
import { useNow } from "@/hooks/use-now"
import { CHANNEL_LABEL, displayName, firstName } from "@/lib/format"
import { freeTextBlocked } from "@/lib/channels"
import type { Channel, Conversation, TemplateSummary } from "@/lib/types"
import { CHANNEL_ICON } from "./bits"

const bar = "flex shrink-0 items-center gap-3 border-t bg-panel px-4 py-3"

export function Composer({ conversation: c }: { conversation: Conversation }) {
  const { actions, live } = useConsole()
  const now = useNow(60_000)
  const [draft, setDraft] = useState("")
  const [hideSuggestion, setHideSuggestion] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  // "auto" lets Sent's routing pick the channel. It is the default every time a conversation opens.
  const [channel, setChannel] = useState<Channel | "auto">("auto")
  const name = firstName(c.contact)

  if (c.status === "resolved") {
    return (
      <div className={bar}>
        <p className="text-sm text-muted-foreground">This conversation is resolved. A new message from {name} reopens it.</p>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => actions.reopen(c.id)}>
          <RotateCcw />
          Reopen
        </Button>
      </div>
    )
  }

  if (c.contact.optedOut) {
    return (
      <div className={bar}>
        <Ban className="size-4 shrink-0 text-live" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{displayName(c.contact)} texted STOP.</span> Sent blocks texts to them until they text START. You can still call if they agreed to calls.
        </p>
      </div>
    )
  }

  if (c.owner === "agent") {
    const agentOff = live.system.phase !== "ready"
    return (
      <div className={bar}>
        <Bot className="size-4 shrink-0 text-agent" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{agentOff ? "The agent is off." : "The agent is replying."}</span>{" "}
          {agentOff ? `Start it to answer ${name}, or take over to write yourself.` : `Take over to write to ${name} yourself.`}
        </p>
        <Button size="sm" className="ml-auto shrink-0 bg-ink text-panel hover:bg-ink/85" onClick={() => actions.takeOver(c.id)}>
          Take over
        </Button>
      </div>
    )
  }

  const offline = live.system.phase !== "ready"
  const pinned = channel === "auto" ? undefined : channel
  const blocked = freeTextBlocked(c, now, pinned)
  const send = () => {
    const text = draft.trim()
    if (!text || blocked || offline) return
    actions.send(c.id, text, pinned)
    setDraft("")
  }
  const templateForm = (
    <TemplateForm
      channel={pinned}
      disabled={offline}
      onCancel={blocked ? undefined : () => setShowTemplates(false)}
      onSend={(templateId, values) => {
        actions.sendTemplate(c.id, templateId, values, pinned)
        setShowTemplates(false)
      }}
    />
  )

  return (
    <div className="shrink-0 space-y-2 border-t bg-panel px-4 py-3">
      {offline && <p className="text-xs text-warn-ink">Start the agent to send texts. Messages go through Sent while the agent is on.</p>}

      {c.suggestion && !hideSuggestion && !blocked && (
        <div className="flex items-start gap-2.5 rounded-md border border-agent/20 bg-agent-soft px-3 py-2">
          <Bot className="mt-0.5 size-3.5 shrink-0 text-agent" aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-[11px] font-medium text-agent">Agent draft</p>
            <p className="line-clamp-2 text-sm leading-relaxed">{c.suggestion}</p>
            <Button
              size="xs"
              variant="outline"
              className="bg-panel"
              onClick={() => {
                setDraft(c.suggestion ?? "")
                setHideSuggestion(true)
              }}
            >
              Use draft
            </Button>
          </div>
          <Button size="icon-xs" variant="ghost" aria-label="Hide draft" onClick={() => setHideSuggestion(true)}>
            <X />
          </Button>
        </div>
      )}

      {blocked ? (
        <>
          <div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn-soft/60 px-3 py-2 text-sm" role="status">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
            <p>
              <span className="font-medium">{pinned ? `Free text isn’t available on ${CHANNEL_LABEL[pinned]}.` : "Free text isn’t available yet."}</span> {blocked}{" "}
              {pinned ? "Send an approved template, or let Sent pick the channel." : "Send an approved template."}
            </p>
          </div>
          {templateForm}
          <div className="flex items-center gap-1.5">
            <ChannelSelect conversation={c} value={channel} onChange={setChannel} />
            <Button type="button" variant="ghost" size="sm" onClick={() => actions.handBack(c.id)}>
              <Bot />
              <span className="max-sm:sr-only">Hand back to agent</span>
            </Button>
          </div>
        </>
      ) : (
        <>
          {showTemplates && templateForm}
          <form
            className="rounded-md border border-input bg-background focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15"
            onSubmit={(e) => {
              e.preventDefault()
              send()
            }}
          >
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder={`Reply to ${name}${pinned ? ` by ${CHANNEL_LABEL[pinned]}` : ""}…`}
              aria-label="Message"
              rows={2}
              className="min-h-14 resize-none border-0 bg-transparent text-sm/relaxed shadow-none focus-visible:ring-0 md:text-sm/relaxed"
            />
            <div className="flex items-center gap-1.5 border-t px-2 py-1.5">
              <ChannelSelect conversation={c} value={channel} onChange={setChannel} />
              <Button type="button" variant="ghost" size="sm" aria-pressed={showTemplates} onClick={() => setShowTemplates(!showTemplates)}>
                <FileText />
                <span className="max-sm:sr-only">Template</span>
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => actions.handBack(c.id)}>
                <Bot />
                <span className="max-sm:sr-only">Hand back to agent</span>
              </Button>
              <KbdGroup className="ml-auto max-sm:hidden" aria-hidden="true">
                <Kbd>⌘</Kbd>
                <Kbd>Enter</Kbd>
              </KbdGroup>
              <Button type="submit" size="sm" disabled={!draft.trim() || offline} className="max-sm:ml-auto">
                <Send />
                Send
              </Button>
            </div>
          </form>
        </>
      )}
    </div>
  )
}

const CHANNELS: Channel[] = ["sms", "whatsapp", "rcs"]

/**
 * The channel for the next message. "Sent picks" is the default: Sent's routing
 * chooses the channel and the sender. Choosing a channel pins only the channel;
 * Sent still picks the sender.
 */
function ChannelSelect({ conversation: c, value, onChange }: { conversation: Conversation; value: Channel | "auto"; onChange: (value: Channel | "auto") => void }) {
  const Icon = value === "auto" ? Route : CHANNEL_ICON[value]
  return (
    <Select value={value} onValueChange={(next) => onChange(next as Channel | "auto")}>
      <SelectTrigger size="sm" className="w-auto gap-1.5 border-0 bg-transparent shadow-none" aria-label="Channel">
        <Icon className="size-3.5" aria-hidden="true" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto">Sent picks</SelectItem>
        {CHANNELS.map((ch) => (
          <SelectItem key={ch} value={ch}>
            {CHANNEL_LABEL[ch]}
            {!c.contact.channels.includes(ch) && <span className="text-muted-foreground">not used yet</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** "meetingDetails" → "Meeting details", "var_1" → "Var 1". */
function label(variable: string) {
  const words = variable.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Pick an approved Sent template, fill its variables, and send it. Without a chosen channel, Sent picks one among the template's channels. */
function TemplateForm({
  channel,
  disabled,
  onSend,
  onCancel,
}: {
  channel?: Channel
  disabled: boolean
  onSend: (templateId: string, values: Record<string, string>) => void
  onCancel?: () => void
}) {
  const { state } = useConsole()
  const usable = channel ? state.templates.filter((t) => t.channels.includes(channel)) : state.templates
  const [templateId, setTemplateId] = useState(usable[0]?.id ?? "")
  const [values, setValues] = useState<Record<string, string>>({})
  const template: TemplateSummary | undefined = usable.find((t) => t.id === templateId) ?? usable[0]
  const ready = !!template && template.variables.every((v) => values[v]?.trim())

  if (usable.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
        {channel ? `None of your approved templates can be sent by ${CHANNEL_LABEL[channel]}. Let Sent pick the channel, or create one in Sent.` : "You have no approved templates yet. Create one in Sent, then reload this page."}
      </p>
    )
  }

  return (
    <form
      className="space-y-2.5 rounded-md border bg-background p-3"
      aria-label="Send a template"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready && !disabled) onSend(template.id, values)
      }}
    >
      <div className="flex items-center gap-2">
        <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Select
          value={template?.id}
          onValueChange={(value) => {
            setTemplateId(value)
            setValues({})
          }}
        >
          <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label="Template">
            <SelectValue placeholder="Choose a template" />
          </SelectTrigger>
          <SelectContent>
            {usable.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
                <span className="text-muted-foreground">{t.category.toLowerCase()}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {template && template.variables.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center">
          {template.variables.map((variable) => (
            <div key={variable} className="contents">
              <label htmlFor={`tpl-${variable}`} className="text-xs font-medium">
                {label(variable)}
              </label>
              <Input id={`tpl-${variable}`} value={values[variable] ?? ""} onChange={(e) => setValues({ ...values, [variable]: e.target.value })} />
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Sent fills in the template&rsquo;s approved text. The thread shows it once it&rsquo;s sent.
      </p>
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="sm" disabled={!ready || disabled}>
          <Send />
          Send template
        </Button>
      </div>
    </form>
  )
}
