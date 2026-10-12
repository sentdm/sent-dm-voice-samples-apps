import { useState } from "react"
import { toast } from "sonner"
import {
  ArrowLeft,
  Bot,
  ChevronDown,
  CircleCheck,
  HeadphoneOff,
  Headphones,
  Mic,
  MicOff,
  PanelRight,
  Phone,
  PhoneOff,
  RotateCcw,
  UserRound,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useConsole, useLineBusy, useSelectedConversation } from "@/lib/console-context"
import { useNow } from "@/hooks/use-now"
import { cn } from "@/lib/utils"
import { CHANNEL_LABEL, displayName, firstName, formatDuration, formatPhone } from "@/lib/format"
import { activeCall, callChecks, type Caller } from "@/lib/policy"
import { modelLabel } from "@/lib/models"
import type { CallItem, Conversation } from "@/lib/types"
import { CHANNEL_ICON, ContactAvatar, LiveDot, Waveform } from "./bits"
import { Thread } from "./thread"
import { Composer } from "./composer"
import { ContextPanel } from "./context-panel"

export function ThreadPane({ className, onBack }: { className?: string; onBack: () => void }) {
  const c = useSelectedConversation()
  if (!c) return null
  return (
    <section className={cn("flex min-h-0 min-w-0 flex-col", className)} aria-label={`Conversation with ${displayName(c.contact)}`}>
      <ThreadHeader conversation={c} onBack={onBack} />
      <CallBar conversation={c} />
      <Thread conversation={c} />
      <Composer key={c.id} conversation={c} />
    </section>
  )
}

function ThreadHeader({ conversation: c, onBack }: { conversation: Conversation; onBack: () => void }) {
  const { state, actions, live } = useConsole()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const now = useNow(30_000)
  const lineBusy = useLineBusy(c)
  const call = activeCall(c)
  const resolved = c.status === "resolved"
  // The conversation's own call is shown by the disabled Call button itself.
  const blockedFor = (caller: Caller) => {
    const reasons = callChecks(c, state.settings, now, caller, lineBusy)
      .filter((check) => !check.ok && !(check.id === "line" && call))
      .map((check) => check.label)
    if (live.system.phase !== "ready") reasons.unshift("Start the agent first")
    if (caller === "human" && !live.isPhone) reasons.unshift("Open the phone tab to talk")
    return reasons
  }
  const agentBlocked = blockedFor("agent")
  const humanBlocked = blockedFor("human")
  const voice = modelLabel(state.settings.voiceModel)

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-panel px-4">
      <Button variant="ghost" size="icon" className="-ml-2 md:hidden" onClick={onBack} aria-label="Back to inbox">
        <ArrowLeft />
      </Button>
      <ContactAvatar contact={c.contact} className="max-sm:hidden" />
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold">{displayName(c.contact)}</h2>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {c.contact.name && <span className="font-mono">{formatPhone(c.contact.phone)}</span>}
          {c.contact.channels.map((ch) => {
            const Icon = CHANNEL_ICON[ch]
            return <Icon key={ch} className="size-3" role="img" aria-label={CHANNEL_LABEL[ch]} />
          })}
        </p>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          value={c.owner}
          disabled={resolved}
          aria-label="Who replies"
          onValueChange={(value) => {
            if (value === "human") actions.takeOver(c.id)
            if (value === "agent") actions.handBack(c.id)
          }}
        >
          <ToggleGroupItem value="agent" className="data-[state=on]:bg-agent-soft data-[state=on]:text-agent">
            <Bot />
            <span className="max-lg:sr-only">Agent replies</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="human" className="data-[state=on]:bg-ink data-[state=on]:text-panel">
            <UserRound />
            <span className="max-lg:sr-only">You reply</span>
          </ToggleGroupItem>
        </ToggleGroup>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" disabled={Boolean(call) || resolved}>
              <Phone />
              <span className="max-sm:sr-only">Call</span>
              <ChevronDown className="max-sm:hidden" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuItem disabled={agentBlocked.length > 0} onSelect={() => actions.startCall(c.id, "agent")} className="items-start">
              <Bot className="mt-0.5" />
              <div>
                <p className="font-medium">Agent calls {firstName(c.contact)}</p>
                <p className="text-muted-foreground">{agentBlocked[0] ?? `Talks with ${voice}, then texts what it promised`}</p>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={humanBlocked.length > 0} onSelect={() => actions.startCall(c.id, "human")} className="items-start">
              <UserRound className="mt-0.5" />
              <div>
                <p className="font-medium">Call from this browser</p>
                <p className="text-muted-foreground">{humanBlocked[0] ?? "You talk. The conversation moves to you."}</p>
              </div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {resolved ? (
          <Button size="sm" variant="ghost" onClick={() => actions.reopen(c.id)}>
            <RotateCcw />
            <span className="max-sm:sr-only">Reopen</span>
          </Button>
        ) : (
          <Button size="sm" variant="ghost" disabled={Boolean(call)} onClick={() => actions.resolve(c.id)}>
            <CircleCheck />
            <span className="max-sm:sr-only">Resolve</span>
          </Button>
        )}

        <Button size="icon" variant="ghost" className="xl:hidden" onClick={() => setDetailsOpen(true)} aria-label="Contact and agent details">
          <PanelRight />
        </Button>
      </div>

      <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
        <SheetContent className="w-[340px] gap-0 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Contact and agent details</SheetTitle>
          </SheetHeader>
          <ContextPanel className="flex h-full" />
        </SheetContent>
      </Sheet>
    </header>
  )
}

const onInk = "border-panel/20 bg-transparent text-panel hover:bg-panel/10 hover:text-panel aria-pressed:bg-panel/15"

/** The dark strip above the thread while a call rings or is live. */
function CallBar({ conversation: c }: { conversation: Conversation }) {
  const call = activeCall(c)
  if (!call) return null
  return <ActiveCallBar key={call.id} conversation={c} call={call} />
}

function ActiveCallBar({ conversation: c, call }: { conversation: Conversation; call: CallItem }) {
  const { state, actions, live: liveControls } = useConsole()
  const now = useNow(250)
  const [muted, setMuted] = useState(false)
  // A person talks through the phone tab's microphone, so only that tab can put them on the call.
  const canTalk = liveControls.isPhone
  const name = firstName(c.contact)
  const live = call.state === "live"
  const inbound = call.direction === "inbound"
  const last = call.transcript.at(-1)
  const speaking = live && last && now - last.at < 4000 ? last.speaker : null

  let title: string
  let detail: string
  if (live) {
    title = call.handledBy === "agent" ? `Agent on call with ${name}` : `You're on call with ${name}`
    detail = speaking === "agent" ? "Agent speaking" : speaking === "contact" ? `${name} speaking` : speaking === "human" ? "You're speaking" : "Listening"
  } else if (inbound) {
    title = `${name} is calling`
    detail =
      state.settings.inbound === "team_only" || call.agentAnswersAt === undefined
        ? "Ringing your team"
        : `Agent answers in ${Math.max(0, Math.ceil((call.agentAnswersAt - now) / 1000))}s`
  } else {
    title = call.handledBy === "agent" ? `Agent is calling ${name}` : `Calling ${name}`
    detail = "Ringing"
  }

  return (
    <div role="region" aria-label="Active call" className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 bg-ink px-4 py-2.5 text-panel">
      <div className="flex min-w-0 items-center gap-2.5">
        <LiveDot className={live ? "text-[#ff6b5e]" : "text-[#ffb347]"} />
        <span className="truncate text-sm font-medium">{title}</span>
        <span className="font-mono text-xs text-panel/60 tabular-nums">{formatDuration(now - (call.answeredAt ?? call.at))}</span>
      </div>
      {live && <Waveform seed={call.id} bars={36} live className="h-5 text-panel/45 max-md:hidden" />}
      <span className="text-xs text-panel/60" aria-live="polite">
        {detail}
      </span>

      <div className="ml-auto flex items-center gap-1.5">
        {live && call.handledBy === "agent" && (
          <>
            <Button
              size="sm"
              variant="outline"
              className={onInk}
              aria-pressed={Boolean(call.listening)}
              onClick={() => {
                if (!call.listening) toast("Listening in", { description: "Call audio plays in this tab. The contact can't hear you." })
                actions.toggleListen(c.id)
              }}
            >
              {call.listening ? <HeadphoneOff /> : <Headphones />}
              {call.listening ? "Stop listening" : "Listen"}
            </Button>
            <Button size="sm" variant="outline" className={onInk} disabled={!canTalk} title={canTalk ? undefined : "Open the phone tab to talk"} onClick={() => actions.takeOverCall(c.id)}>
              <Mic />
              Take over call
            </Button>
          </>
        )}
        {live && call.handledBy === "human" && (
          <Button
            size="sm"
            variant="outline"
            className={onInk}
            aria-pressed={muted}
            disabled={!canTalk}
            onClick={() => {
              liveControls.setMuted(!muted)
              setMuted(!muted)
            }}
          >
            {muted ? <MicOff /> : <Mic />}
            {muted ? "Unmute" : "Mute"}
          </Button>
        )}
        {!live && inbound && (
          <>
            <Button size="sm" className="bg-ok text-panel hover:bg-ok/85" disabled={!canTalk} title={canTalk ? undefined : "Open the phone tab to talk"} onClick={() => actions.answer(c.id, "human")}>
              <Phone />
              Answer
            </Button>
            {state.settings.inbound !== "team_only" && (
              <Button size="sm" variant="outline" className={onInk} onClick={() => actions.answer(c.id, "agent")}>
                <Bot />
                Agent answers
              </Button>
            )}
          </>
        )}
        <Button
          size="sm"
          className="bg-live text-panel hover:bg-live/85"
          onClick={() => (inbound && !live ? actions.declineCall(c.id) : actions.hangUp(c.id))}
        >
          <PhoneOff />
          {live ? "Hang up" : inbound ? "Decline" : "Cancel"}
        </Button>
      </div>
    </div>
  )
}
