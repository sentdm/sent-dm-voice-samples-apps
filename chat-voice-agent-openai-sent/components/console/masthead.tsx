import { useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { KeyRound, Loader2, Megaphone, Settings2, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useConsole, type LiveControls } from "@/lib/console-context"
import { formatPhone } from "@/lib/format"
import type { AgentSettings } from "@/lib/types"
import { cn } from "@/lib/utils"
import { BrandMark } from "./bits"

export function Masthead({ onSettings, onSetup, onCampaigns }: { onSettings: () => void; onSetup: () => void; onCampaigns: () => void }) {
  const { state, live } = useConsole()
  const sending = state.campaigns.filter((c) => c.status === "sending").length

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-panel px-4">
      <Link href="/" className="flex items-center gap-2 text-[15px] tracking-tight" aria-label="Sent conversations home">
        <BrandMark />
        <span className="font-semibold">Sent</span>
        <span className="text-muted-foreground max-sm:hidden">/ conversations</span>
      </Link>

      <div className="ml-auto flex items-center gap-2">
        <LiveStatus live={live} settings={state.settings} onSetup={onSetup} onSettings={onSettings} />
        <Button variant="ghost" size="sm" onClick={onCampaigns} aria-label={sending ? `Campaigns, ${sending} sending` : "Campaigns"}>
          <Megaphone />
          <span className="max-md:sr-only">Campaigns</span>
          {sending > 0 && <span className="rounded-sm bg-agent px-1 font-mono text-[10px] leading-4 text-panel">{sending}</span>}
        </Button>
        <Button variant="ghost" size="icon" aria-label="Sent and OpenAI keys" onClick={onSetup}>
          <KeyRound />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Agent settings" onClick={onSettings}>
          <Settings2 />
        </Button>
      </div>
    </header>
  )
}

const pill = "hidden items-center gap-2 rounded-sm border px-2 py-1 text-xs sm:flex"

/** The agent's state, and the one control that changes it. */
function LiveStatus({ live, settings, onSetup, onSettings }: { live: LiveControls; settings: AgentSettings; onSetup: () => void; onSettings: () => void }) {
  const { system, isPhone } = live
  const [busy, setBusy] = useState(false)

  if (!system.configured) {
    return (
      <Button size="sm" onClick={onSetup}>
        <KeyRound />
        Connect Sent
      </Button>
    )
  }

  // Runs inside the click: the phone engine starts browser audio before its first await.
  const start = async () => {
    if (!settings.businessName) {
      onSettings()
      toast.error("Enter your business name first. The agent uses it in every greeting.")
      return
    }
    setBusy(true)
    try {
      await live.start()
      toast.success("The agent is on. Keep this tab open: calls ring here.")
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const stop = async () => {
    setBusy(true)
    try {
      await live.stop()
      toast("The agent stopped. Your number's routing is restored.")
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const notice = system.error ?? system.warning
  const status =
    system.phase === "ready"
      ? { dot: system.phoneOnline ? "bg-ok" : "bg-warn", label: system.phoneOnline ? "Agent on" : "Phone tab offline" }
      : system.phase === "starting"
        ? { dot: "bg-warn", label: system.step ? `${system.step}…` : "Starting…" }
        : system.phase === "stopping"
          ? { dot: "bg-warn", label: "Stopping…" }
          : { dot: "bg-line-strong", label: "Agent off" }

  return (
    <>
      {notice && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn("flex size-7 items-center justify-center", system.error ? "text-live" : "text-warn")} role="img" aria-label={notice}>
              <TriangleAlert className="size-4" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-72">
            {notice}
          </TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={pill}>
            {system.phase === "starting" || system.phase === "stopping" ? (
              <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden="true" />
            ) : (
              <span className={cn("size-1.5 rounded-full", status.dot)} aria-hidden="true" />
            )}
            <span className="font-medium" aria-live="polite">
              {status.label}
            </span>
            {settings.number && <span className="font-mono text-muted-foreground">{formatPhone(settings.number)}</span>}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-64">
          {system.phase === "ready"
            ? isPhone
              ? "This tab is the phone: calls ring here, and you talk from here. Keep it open."
              : "Calls ring in the tab that started the agent."
            : "Start the agent to answer texts and calls. Start routes your number to this app; Stop restores it."}
        </TooltipContent>
      </Tooltip>
      {system.phase === "offline" && (
        <Button size="sm" disabled={busy} onClick={() => void start()}>
          Start agent
        </Button>
      )}
      {(system.phase === "ready" || system.phase === "starting") && (
        <Button size="sm" variant="outline" disabled={busy || system.phase === "starting"} onClick={() => void stop()}>
          Stop
        </Button>
      )}
    </>
  )
}
