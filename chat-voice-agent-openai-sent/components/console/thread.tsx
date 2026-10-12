import { useEffect, useRef, type ReactNode } from "react"
import { Bot } from "lucide-react"
import { useNow } from "@/hooks/use-now"
import { cn } from "@/lib/utils"
import { CHANNEL_LABEL, dayLabel } from "@/lib/format"
import { channelOf } from "@/lib/selectors"
import type { Conversation, ThreadItem } from "@/lib/types"
import { CallTape, EventRow, MessageBubble, ProposalCard } from "./thread-items"

type Row =
  | { key: string; type: "day"; label: string; lane: string | null }
  | { key: string; type: "item"; item: ThreadItem; lane: string | null; tag: string | null; showAuthor: boolean }

/**
 * Builds the rows of the thread. Each row knows its channel lane, so the spine
 * can draw a thin line for text, a heavy bar for voice, and a tag wherever the
 * conversation switches channel.
 */
function buildRows(items: ThreadItem[], now: number): Row[] {
  const rows: Row[] = []
  let lane: string | null = null
  let day = ""
  let previous: ThreadItem | undefined

  for (const item of items) {
    const label = dayLabel(item.at, now)
    if (label !== day) {
      rows.push({ key: `day-${item.id}`, type: "day", label, lane })
      day = label
    }
    const channel = channelOf(item)
    const tag = channel && channel !== lane ? channel : null
    if (channel) lane = channel
    const sameAuthor = previous?.kind === "message" && item.kind === "message" && previous.author === item.author && !tag
    rows.push({ key: item.id, type: "item", item, lane, tag, showAuthor: !sameAuthor })
    previous = item
  }
  return rows
}

function Spine({ lane, tag, isFirst, children }: { lane: string | null; tag?: string | null; isFirst?: boolean; children: ReactNode }) {
  const voice = lane === "Voice"
  return (
    <li className="grid grid-cols-[56px_minmax(0,1fr)] gap-x-2 sm:grid-cols-[72px_minmax(0,1fr)] sm:gap-x-4">
      <div className="relative flex justify-center" aria-hidden="true">
        {lane && (
          <span
            className={cn(
              "absolute bottom-0",
              isFirst ? "top-3" : "top-0",
              voice ? "w-[3px] bg-ink" : "w-px bg-line-strong"
            )}
          />
        )}
        {tag && (
          <span
            className={cn(
              "relative mt-1.5 h-fit rounded-sm border px-1.5 font-mono text-[10px] leading-4",
              voice ? "border-ink bg-ink text-panel" : "border-line-strong bg-paper text-muted-foreground"
            )}
          >
            {tag}
          </span>
        )}
      </div>
      <div className="min-w-0 pb-4">{children}</div>
    </li>
  )
}

export function Thread({ conversation: c }: { conversation: Conversation }) {
  const now = useNow(60_000)
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const rows = buildRows(c.items, now)

  // Follow new messages and transcript lines unless the reader scrolled up.
  const transcriptLines = c.items.reduce((n, i) => n + (i.kind === "call" ? i.transcript.length : 0), 0)
  const signature = `${c.items.length}:${transcriptLines}:${c.agentTyping ? 1 : 0}`

  useEffect(() => {
    stickToBottom.current = true
  }, [c.id])

  useEffect(() => {
    const el = scroller.current
    if (el && stickToBottom.current) el.scrollTo({ top: el.scrollHeight })
  }, [c.id, signature])

  const lastLane = rows.at(-1)?.lane ?? null
  const firstLaneRow = rows.findIndex((row) => row.lane)

  return (
    <div
      ref={scroller}
      className="paper-grid min-h-0 flex-1 overflow-y-auto"
      onScroll={(e) => {
        const el = e.currentTarget
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96
      }}
    >
      <ol className="mx-auto max-w-3xl px-3 pt-6 pb-4 sm:px-6" aria-label="Conversation history">
        {rows.map((row, index) => {
          const isFirst = index === firstLaneRow
          if (row.type === "day") {
            return (
              <Spine key={row.key} lane={row.lane}>
                <p className="pt-0.5 text-xs font-medium text-muted-foreground">{row.label}</p>
              </Spine>
            )
          }
          return (
            <Spine key={row.key} lane={row.lane} tag={row.tag} isFirst={isFirst}>
              <ItemView item={row.item} conversation={c} showAuthor={row.showAuthor} />
            </Spine>
          )
        })}
        {c.agentTyping && (
          <Spine lane={lastLane === "Voice" ? CHANNEL_LABEL[c.lastChannel] : lastLane} tag={lastLane === "Voice" ? CHANNEL_LABEL[c.lastChannel] : null}>
            <TypingIndicator />
          </Spine>
        )}
      </ol>
    </div>
  )
}

function ItemView({ item, conversation, showAuthor }: { item: ThreadItem; conversation: Conversation; showAuthor: boolean }) {
  switch (item.kind) {
    case "message":
      return <MessageBubble item={item} showAuthor={showAuthor} />
    case "call":
      return <CallTape call={item} conversation={conversation} />
    case "event":
      return <EventRow item={item} />
    case "proposal":
      return <ProposalCard item={item} conversation={conversation} />
  }
}

function TypingIndicator() {
  return (
    <div className="flex flex-col items-end gap-1" role="status">
      <span className="flex items-center gap-1 text-[11px] font-medium text-agent">
        <Bot className="size-3" aria-hidden="true" />
        Agent
      </span>
      <div className="flex gap-1 rounded-md border border-agent/20 bg-agent-soft px-3 py-3">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-1.5 rounded-full bg-agent/60 motion-safe:animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
        ))}
      </div>
      <span className="sr-only">The agent is typing</span>
    </div>
  )
}
