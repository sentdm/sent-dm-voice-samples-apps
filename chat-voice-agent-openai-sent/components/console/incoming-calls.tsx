import { Bot, Phone, PhoneOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useConsole } from "@/lib/console-context"
import { useNow } from "@/hooks/use-now"
import { displayName, formatDuration, formatPhone } from "@/lib/format"
import { activeCall } from "@/lib/policy"
import type { CallItem, Conversation } from "@/lib/types"
import { ContactAvatar, LiveDot } from "./bits"

/** Ringing inbound calls float above every screen, so no one misses them. */
export function IncomingCalls({ onOpen }: { onOpen: () => void }) {
  const { state } = useConsole()
  const ringing = state.conversations.flatMap((c) => {
    const call = activeCall(c)
    return call?.direction === "inbound" && call.state === "ringing" ? [{ conversation: c, call }] : []
  })
  if (ringing.length === 0) return null

  return (
    <div className="fixed right-4 bottom-4 z-40 flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2" role="region" aria-label="Incoming calls">
      {ringing.map(({ conversation, call }) => (
        <IncomingCallCard key={call.id} conversation={conversation} call={call} onOpen={onOpen} />
      ))}
    </div>
  )
}

function IncomingCallCard({ conversation: c, call, onOpen }: { conversation: Conversation; call: CallItem; onOpen: () => void }) {
  const { state, actions, live } = useConsole()
  const now = useNow(200)
  const canTalk = live.isPhone
  const agentPicksUp = state.settings.inbound !== "team_only" && call.agentAnswersAt !== undefined
  const total = agentPicksUp ? call.agentAnswersAt! - call.at : 30_000
  const left = Math.max(0, (agentPicksUp ? call.agentAnswersAt! : call.at + 30_000) - now)
  const history = c.items.some((i) => i.kind === "message")

  return (
    <div className="overflow-hidden rounded-md bg-ink text-panel shadow-[0_12px_32px_-12px_rgb(26_28_32/0.55)] motion-safe:animate-in motion-safe:slide-in-from-bottom-4">
      <div className="space-y-3 p-3.5">
        <div className="flex items-center gap-2 text-xs text-panel/70">
          <LiveDot className="text-[#ffb347]" />
          <span aria-live="assertive">Incoming call</span>
          <span className="ml-auto font-mono tabular-nums">{formatDuration(now - call.at)}</span>
        </div>
        <button
          type="button"
          className="flex w-full items-center gap-3 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-panel/40"
          onClick={() => {
            actions.select(c.id)
            onOpen()
          }}
        >
          <ContactAvatar contact={c.contact} className="[&_[data-slot=avatar-fallback]]:bg-panel [&_[data-slot=avatar-fallback]]:text-ink" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{displayName(c.contact)}</p>
            <p className="truncate text-xs text-panel/60">
              {c.contact.name ? formatPhone(c.contact.phone) : "New number"}
              {history && " · has texted before"}
            </p>
          </div>
        </button>
        <div className="space-y-1.5">
          <p className="text-xs text-panel/70">
            {agentPicksUp ? `The agent answers in ${Math.ceil(left / 1000)}s if no one picks up.` : `Rings your team for ${Math.ceil(left / 1000)}s more.`}
          </p>
          <div className="h-0.5 overflow-hidden rounded-full bg-panel/15" aria-hidden="true">
            <div className="h-full bg-[#ffb347] transition-[width] duration-200 ease-linear" style={{ width: `${(left / total) * 100}%` }} />
          </div>
        </div>
      </div>
      <div className="flex gap-1.5 border-t border-panel/10 bg-panel/5 p-2">
        <Button
          size="sm"
          className="flex-1 bg-ok text-panel hover:bg-ok/85"
          disabled={!canTalk}
          title={canTalk ? undefined : "Open the phone tab to talk"}
          onClick={() => {
            // You're on the call now, so open the thread with the call controls.
            actions.answer(c.id, "human")
            actions.select(c.id)
            onOpen()
          }}
        >
          <Phone />
          Answer
        </Button>
        {state.settings.inbound !== "team_only" && (
          <Button size="sm" variant="outline" className="flex-1 border-panel/20 bg-transparent text-panel hover:bg-panel/10 hover:text-panel" onClick={() => actions.answer(c.id, "agent")}>
            <Bot />
            Agent answers
          </Button>
        )}
        <Button size="icon" className="bg-live text-panel hover:bg-live/85" aria-label="Decline call" onClick={() => actions.declineCall(c.id)}>
          <PhoneOff />
        </Button>
      </div>
    </div>
  )
}
