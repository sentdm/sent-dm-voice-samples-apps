import { useState } from "react"
import { Bot, Phone, Search, UserRound, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useConsole } from "@/lib/console-context"
import { useNow } from "@/hooks/use-now"
import { cn } from "@/lib/utils"
import { displayName, formatAgo, formatDuration } from "@/lib/format"
import { activeCall } from "@/lib/policy"
import { inbox, lastActivity, needsYou, preview } from "@/lib/selectors"
import type { Conversation, InboxFilter } from "@/lib/types"
import { CHANNEL_ICON, ContactAvatar, LiveDot } from "./bits"

export function Inbox({ className, onOpen }: { className?: string; onOpen: () => void }) {
  const { state, actions, live } = useConsole()
  const now = useNow(1000)
  const agentOn = live.system.phase === "ready"
  const [query, setQuery] = useState("")
  const searching = query.trim().length > 0
  const rows = inbox(state.conversations, state.filter, query)
  const needsCount = state.conversations.filter(needsYou).length

  return (
    <aside className={cn("flex min-h-0 flex-col border-r bg-panel", className)} aria-label="Conversations">
      <div className="space-y-3 border-b px-4 pt-4 pb-3">
        <h1 className="text-base font-semibold tracking-tight">Inbox</h1>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Search numbers, names, messages"
            aria-label="Search conversations"
            className="pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
          />
          {searching && (
            <Button variant="ghost" size="icon-xs" className="absolute top-1/2 right-1.5 -translate-y-1/2" aria-label="Clear search" onClick={() => setQuery("")}>
              <X />
            </Button>
          )}
        </div>
        {searching ? (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {rows.length === 1 ? "1 conversation matches" : `${rows.length} conversations match`}, open and resolved.
          </p>
        ) : (
          <Tabs value={state.filter} onValueChange={(v) => actions.setFilter(v as InboxFilter)}>
            <TabsList className="w-full">
              <TabsTrigger value="needs_you" className="gap-1.5">
                Needs you
                {needsCount > 0 && (
                  <span className="rounded-sm bg-warn px-1 font-mono text-[10px] leading-4 text-panel">{needsCount}</span>
                )}
              </TabsTrigger>
              <TabsTrigger value="open">Open</TabsTrigger>
              <TabsTrigger value="resolved">Resolved</TabsTrigger>
            </TabsList>
          </Tabs>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {searching ? `No conversation matches “${query.trim()}”.` : state.filter === "needs_you" ? "Nothing needs you. The agent has it." : "No conversations here."}
          </p>
        ) : (
          <ul className="divide-y">
            {rows.map((c) => (
              <li key={c.id}>
                <InboxRow
                  conversation={c}
                  now={now}
                  agentOn={agentOn}
                  selected={c.id === state.selectedId}
                  onSelect={() => {
                    actions.select(c.id)
                    onOpen()
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

function InboxRow({ conversation: c, now, agentOn, selected, onSelect }: { conversation: Conversation; now: number; agentOn: boolean; selected: boolean; onSelect: () => void }) {
  const last = preview(c)
  const PreviewIcon = last.icon === "call" ? Phone : CHANNEL_ICON[c.lastChannel]

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "relative flex w-full gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-paper focus-visible:bg-paper focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-inset",
        selected && "bg-paper before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-ink"
      )}
    >
      <ContactAvatar contact={c.contact} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline gap-2">
          <span className={cn("truncate text-sm", c.unread > 0 ? "font-semibold" : "font-medium")}>{displayName(c.contact)}</span>
          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">{formatAgo(lastActivity(c), now)}</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <PreviewIcon className="size-3 shrink-0" aria-hidden="true" />
          <span className={cn("truncate", c.unread > 0 && "text-foreground")}>{last.text}</span>
        </div>
        <div className="flex items-center gap-1.5 pt-0.5">
          <StateChip conversation={c} now={now} agentOn={agentOn} />
          {c.unread > 0 && (
            <span className="ml-auto rounded-sm bg-agent px-1 font-mono text-[10px] leading-4 text-panel" aria-label={`${c.unread} unread`}>
              {c.unread}
            </span>
          )}
        </div>
      </div>
    </button>
  )
}

const chip = "inline-flex h-5 items-center gap-1 rounded-sm px-1.5 text-[11px] font-medium"

function StateChip({ conversation: c, now, agentOn }: { conversation: Conversation; now: number; agentOn: boolean }) {
  const call = activeCall(c)
  if (call?.state === "live") {
    return (
      <span className={cn(chip, "bg-ink text-panel")}>
        <LiveDot className="text-[#ff6b5e]" />
        {call.handledBy === "agent" ? "Agent on call" : "You're on call"}
        <span className="font-mono text-panel/70">{formatDuration(now - (call.answeredAt ?? call.at))}</span>
      </span>
    )
  }
  if (call?.state === "ringing") {
    return (
      <span className={cn(chip, "border border-live/40 bg-live-soft text-live")}>
        <LiveDot />
        {call.direction === "inbound" ? "Ringing" : "Calling"}
      </span>
    )
  }
  if (c.status === "resolved") return <span className={cn(chip, "bg-muted text-muted-foreground")}>Resolved</span>
  if (needsYou(c)) return <span className={cn(chip, "bg-warn-soft text-warn-ink")}>Needs you</span>
  if (c.owner === "human") {
    return (
      <span className={cn(chip, "bg-muted text-foreground")}>
        <UserRound className="size-3" aria-hidden="true" />
        You
      </span>
    )
  }
  return (
    <span className={cn(chip, agentOn ? "bg-agent-soft text-agent" : "bg-muted text-muted-foreground")}>
      <Bot className="size-3" aria-hidden="true" />
      {agentOn ? "Agent" : "Agent off"}
    </span>
  )
}
