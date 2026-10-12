import { useState } from "react"
import {
  Ban,
  Bot,
  Building2,
  Check,
  ChevronDown,
  CircleCheck,
  Hand,
  Info,
  Mic,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  RotateCcw,
  ShieldCheck,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useConsole, useLineBusy } from "@/lib/console-context"
import { useNow } from "@/hooks/use-now"
import { cn } from "@/lib/utils"
import { CHANNEL_LABEL, firstName, formatClock, formatDuration } from "@/lib/format"
import { callChecks, canCall } from "@/lib/policy"
import type { CallItem, CallOutcome, Conversation, EventItem, MessageItem, ProposalItem, Speaker } from "@/lib/types"
import { LiveDot, Waveform } from "./bits"

const STATUS_LABEL: Record<NonNullable<MessageItem["status"]>, string> = {
  sending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Not delivered",
}

function Meta({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex items-center gap-2 font-mono text-[10px] text-muted-foreground", className)}>{children}</div>
}

function AuthorLabel({ author, fromHistory }: { author: Exclude<Speaker, "contact">; fromHistory?: boolean }) {
  if (fromHistory) {
    return (
      <span className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
        <Building2 className="size-3" aria-hidden="true" />
        Your account
      </span>
    )
  }
  return author === "agent" ? (
    <span className="flex items-center gap-1 text-[11px] font-medium text-agent">
      <Bot className="size-3" aria-hidden="true" />
      Agent
    </span>
  ) : (
    <span className="flex items-center gap-1 text-[11px] font-medium">
      <UserRound className="size-3" aria-hidden="true" />
      You
    </span>
  )
}

export function MessageBubble({ item, showAuthor }: { item: MessageItem; showAuthor: boolean }) {
  const fromUs = item.author !== "contact"
  return (
    <div className={cn("flex flex-col gap-1", fromUs ? "items-end" : "items-start")}>
      {fromUs && showAuthor && <AuthorLabel author={item.author as Exclude<Speaker, "contact">} fromHistory={item.fromHistory} />}
      <div
        className={cn(
          "max-w-[min(34rem,88%)] rounded-md px-3 py-2 text-sm leading-relaxed text-pretty whitespace-pre-wrap",
          item.author === "contact" && "border bg-panel",
          item.author === "agent" && "border border-agent/20 bg-agent-soft",
          item.author === "human" && !item.fromHistory && "bg-ink text-panel",
          item.fromHistory && item.author !== "contact" && "border border-dashed bg-panel",
          item.status === "failed" && "opacity-70"
        )}
      >
        {item.text}
      </div>
      <Meta className={fromUs ? "justify-end" : undefined}>
        <time>{formatClock(item.at)}</time>
        <span>{item.routing ? "Sent routing" : CHANNEL_LABEL[item.channel]}</span>
        {item.template && <span className="max-w-48 truncate">Template: {item.template}</span>}
        {item.status && <span className={item.status === "failed" ? "text-live" : undefined}>{STATUS_LABEL[item.status]}</span>}
      </Meta>
      {item.status === "failed" && item.error && <p className="max-w-[min(34rem,88%)] text-right text-xs text-live">{item.error}</p>}
    </div>
  )
}

const OUTCOME_LABEL: Record<CallOutcome, string> = {
  resolved: "Resolved",
  callback_requested: "Callback requested",
  handed_over: "Handed over",
  voicemail: "Voicemail",
  no_answer: "No answer",
  not_interested: "Not interested",
}

function speakerName(speaker: Speaker, c: Conversation) {
  if (speaker === "agent") return "Agent"
  if (speaker === "human") return "You"
  return c.contact.name?.split(" ")[0] ?? "Caller"
}

/**
 * A call drawn as a strip of tape among the messages. It stays in the thread
 * after the call ends, with the outcome, the summary, and the transcript.
 */
export function CallTape({ call, conversation: c }: { call: CallItem; conversation: Conversation }) {
  if (call.state === "missed" || call.state === "declined") return <MissedCall call={call} conversation={c} />
  return <RecordedCall call={call} conversation={c} />
}

function MissedCall({ call, conversation: c }: { call: CallItem; conversation: Conversation }) {
  return (
    <div className="flex max-w-xl items-start gap-3 rounded-md border border-dashed border-live/40 bg-panel px-3 py-2.5">
      <PhoneMissed className="mt-0.5 size-4 shrink-0 text-live" aria-hidden="true" />
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">
          {call.state === "missed" ? "Missed call" : "Declined call"} from {firstName(c.contact)}
        </p>
        {call.summary && <p className="text-xs text-muted-foreground">{call.summary}</p>}
        <Meta>
          <time>{formatClock(call.at)}</time>
          <span>Rang {formatDuration((call.endedAt ?? call.at) - call.at)}</span>
        </Meta>
      </div>
    </div>
  )
}

function RecordedCall({ call, conversation: c }: { call: CallItem; conversation: Conversation }) {
  const live = call.state === "live"
  const ringing = call.state === "ringing"
  // Tick with the call bar while the call is active, so both timers agree.
  const now = useNow(live || ringing ? 250 : 60_000)
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? live
  const Icon = call.direction === "inbound" ? PhoneIncoming : PhoneOutgoing
  const who = call.handledBy === "agent" ? "the agent" : "you"
  const title =
    call.direction === "inbound"
      ? `${firstName(c.contact)} called`
      : call.handledBy === "agent"
        ? `Agent called ${firstName(c.contact)}`
        : `You called ${firstName(c.contact)}`
  const subtitle = ringing ? "Ringing" : call.direction === "inbound" ? `Answered by ${who}` : live ? "Connected" : "Call ended"
  const duration = call.answeredAt ? (call.endedAt ?? now) - call.answeredAt : (call.endedAt ?? now) - call.at

  return (
    <article className="max-w-xl overflow-hidden rounded-md bg-ink text-panel" aria-label={title}>
      <header className="flex items-center gap-3 px-3.5 pt-3">
        <Icon className="size-4 shrink-0 text-panel/70" aria-hidden="true" />
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="text-[11px] text-panel/60">{subtitle}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {(live || ringing) && (
            <span className="flex items-center gap-1.5 rounded-sm bg-panel/10 px-1.5 py-0.5 font-mono text-[10px] tracking-wide">
              <LiveDot className={live ? "text-[#ff6b5e]" : "text-[#ffb347]"} />
              {live ? "LIVE" : "RINGING"}
            </span>
          )}
          {call.outcome && (
            <span className={cn("rounded-sm px-1.5 py-0.5 text-[11px] font-medium", call.outcome === "resolved" ? "bg-ok text-panel" : "bg-panel/15")}>
              {OUTCOME_LABEL[call.outcome]}
            </span>
          )}
          <span className="font-mono text-xs text-panel/70 tabular-nums">{formatDuration(duration)}</span>
        </div>
      </header>

      <div className="px-3.5 py-3">
        <Waveform seed={call.id} live={live} bars={110} className={cn("w-full justify-between", live ? "text-panel/60" : ringing ? "text-panel/10" : "text-panel/30")} />
      </div>

      {(call.reason || call.summary) && (
        <div className="space-y-1.5 px-3.5 pb-3 text-[13px] leading-relaxed">
          {call.reason && call.handledBy === "agent" && call.direction === "outbound" && (
            <p className="text-panel/60">
              <span className="text-panel/80">Why the agent called: </span>
              {call.reason}
            </p>
          )}
          {call.summary && <p className="text-panel/90">{call.summary}</p>}
        </div>
      )}

      {(call.transcript.length > 0 || (live && call.handledBy === "agent")) && (
        <Collapsible open={open} onOpenChange={setUserOpen}>
          <CollapsibleTrigger className="flex w-full items-center gap-2 border-t border-panel/10 px-3.5 py-2 text-left text-xs text-panel/70 outline-none hover:bg-panel/5 focus-visible:bg-panel/10">
            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />
            Transcript
            <span className="font-mono text-panel/50">{call.transcript.length} lines</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ol className="space-y-2.5 border-t border-panel/10 px-3.5 py-3" aria-live={live ? "polite" : undefined}>
              {call.transcript.map((line) => (
                <li key={line.id} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 text-[13px] leading-relaxed">
                  <span className={cn("pt-px font-mono text-[11px]", line.speaker === "agent" ? "text-[#9db8f0]" : line.speaker === "human" ? "text-panel" : "text-panel/55")}>
                    {speakerName(line.speaker, c)}
                  </span>
                  <span className="text-panel/90">{line.text}</span>
                </li>
              ))}
              {live && (
                <li className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 text-[13px]">
                  <span />
                  <span className="text-panel/40">Listening…</span>
                </li>
              )}
            </ol>
          </CollapsibleContent>
        </Collapsible>
      )}
    </article>
  )
}

const EVENT_ICON: Record<EventItem["icon"], LucideIcon> = {
  handover: Hand,
  takeover: UserRound,
  handback: Bot,
  resolved: CircleCheck,
  reopened: RotateCcw,
  consent: ShieldCheck,
  join: Mic,
  optout: Ban,
  info: Info,
}

export function EventRow({ item }: { item: EventItem }) {
  const Icon = EVENT_ICON[item.icon]
  return (
    <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
      <Icon className={cn("size-3.5 shrink-0", item.icon === "consent" && "text-ok")} aria-hidden="true" />
      <span>{item.text}</span>
      <time className="font-mono text-[10px]">{formatClock(item.at)}</time>
    </div>
  )
}

function Signals({ signals, tone }: { signals: string[]; tone: "agent" | "warn" }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Signals the agent noticed">
      {signals.map((signal) => (
        <li
          key={signal}
          className={cn("rounded-sm px-1.5 py-0.5 text-[11px] font-medium", tone === "agent" ? "bg-agent-soft text-agent" : "bg-warn-soft text-warn-ink")}
        >
          {signal}
        </li>
      ))}
    </ul>
  )
}

/** The agent asks a person before it calls or when it needs help. */
export function ProposalCard({ item, conversation: c }: { item: ProposalItem; conversation: Conversation }) {
  if (item.status !== "pending") {
    const Icon = item.action === "call" ? PhoneOutgoing : Hand
    return (
      <div className="flex items-start gap-2 pt-1 text-xs text-muted-foreground">
        <Icon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        <p className="min-w-0">
          {item.action === "call" ? "The agent suggested a call" : "The agent asked for a person"}: {item.reason}{" "}
          <span className="text-foreground">{item.resolution}</span>
        </p>
      </div>
    )
  }
  return item.action === "call" ? <CallProposal item={item} conversation={c} /> : <HandoverProposal item={item} conversation={c} />
}

function CallProposal({ item, conversation: c }: { item: ProposalItem; conversation: Conversation }) {
  const { state, actions, live } = useConsole()
  const now = useNow(15_000)
  const lineBusy = useLineBusy(c)
  const checks = callChecks(c, state.settings, now, "agent", lineBusy)
  const offline = live.system.phase !== "ready"
  const blocked = offline || checks.some((check) => !check.ok)
  // A person talks through the phone tab, so only that tab can place their call.
  const youCan = !offline && live.isPhone && canCall(c, state.settings, now, "human", lineBusy)

  return (
    <section className="max-w-xl space-y-3 rounded-md border border-agent/40 bg-panel p-3.5 shadow-[inset_3px_0_0_var(--agent)]" aria-label="Call suggestion">
      <header className="flex items-center gap-2">
        <PhoneOutgoing className="size-4 text-agent" aria-hidden="true" />
        <h3 className="text-sm font-semibold">The agent wants to call {firstName(c.contact)}</h3>
        <time className="ml-auto font-mono text-[10px] text-muted-foreground">{formatClock(item.at)}</time>
      </header>
      <p className="text-sm leading-relaxed">{item.reason}</p>
      <Signals signals={item.signals} tone="agent" />
      <ul className="grid gap-1.5 sm:grid-cols-2" aria-label="Call checks">
        {checks.map((check) => (
          <li key={check.id} className="flex items-start gap-1.5 text-xs" title={check.detail}>
            {check.ok ? <Check className="mt-px size-3.5 shrink-0 text-ok" aria-hidden="true" /> : <X className="mt-px size-3.5 shrink-0 text-live" aria-hidden="true" />}
            <span className={check.ok ? "text-muted-foreground" : "text-live"}>{check.label}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button size="sm" disabled={blocked} onClick={() => actions.approveCall(c.id, item.id, "agent")}>
          <Bot />
          Let the agent call
        </Button>
        <Button size="sm" variant="outline" disabled={!youCan} onClick={() => actions.approveCall(c.id, item.id, "human")}>
          <UserRound />
          I’ll call
        </Button>
        <Button size="sm" variant="ghost" onClick={() => actions.dismissCall(c.id, item.id)}>
          Dismiss
        </Button>
      </div>
    </section>
  )
}

function HandoverProposal({ item, conversation: c }: { item: ProposalItem; conversation: Conversation }) {
  const { actions } = useConsole()
  return (
    <section className="max-w-xl space-y-3 rounded-md border border-warn/50 bg-warn-soft/60 p-3.5 shadow-[inset_3px_0_0_var(--warn)]" aria-label="Handover request">
      <header className="flex items-center gap-2">
        <Hand className="size-4 text-warn" aria-hidden="true" />
        <h3 className="text-sm font-semibold">The agent needs a person</h3>
        <time className="ml-auto font-mono text-[10px] text-muted-foreground">{formatClock(item.at)}</time>
      </header>
      <p className="text-sm leading-relaxed">{item.reason}</p>
      <Signals signals={item.signals} tone="warn" />
      <div className="flex flex-wrap gap-2 pt-1">
        <Button size="sm" className="bg-ink text-panel hover:bg-ink/85" onClick={() => actions.approveHandover(c.id, item.id)}>
          <UserRound />
          Take over
        </Button>
        <Button size="sm" variant="ghost" onClick={() => actions.dismissHandover(c.id, item.id)}>
          Let the agent continue
        </Button>
      </div>
    </section>
  )
}
