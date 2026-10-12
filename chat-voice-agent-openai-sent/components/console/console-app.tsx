import { useEffect, useState, type ReactNode } from "react"
import { Inbox as InboxIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LiveConsoleProvider } from "@/lib/live/live-store"
import { useConsole } from "@/lib/console-context"
import { formatPhone } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Masthead } from "./masthead"
import { Inbox } from "./inbox"
import { ThreadPane } from "./thread-pane"
import { ContextPanel } from "./context-panel"
import { IncomingCalls } from "./incoming-calls"
import { SettingsSheet } from "./settings-sheet"
import { SetupSheet } from "./setup-sheet"
import { CampaignsSheet } from "./campaigns-sheet"

type Session = { kind: "loading" } | { kind: "ready"; csrf: string } | { kind: "missing" }

/** The console needs the app's own server (`pnpm dev`): it holds the keys and talks to Sent. */
export function ConsoleApp() {
  const [session, setSession] = useState<Session>({ kind: "loading" })

  useEffect(() => {
    fetch("/api/session")
      .then((response) => (response.ok ? (response.json() as Promise<{ csrfToken?: string }>) : null))
      .then((body) => setSession(body?.csrfToken ? { kind: "ready", csrf: body.csrfToken } : { kind: "missing" }))
      .catch(() => setSession({ kind: "missing" }))
  }, [])

  if (session.kind === "loading") return <Centered>Loading conversations…</Centered>
  if (session.kind === "missing") {
    return (
      <Centered>
        <span className="max-w-sm text-center">
          The app&rsquo;s server isn&rsquo;t answering. Start it with <code className="font-mono text-foreground">pnpm dev</code> in this folder, then reload.
        </span>
      </Centered>
    )
  }
  return (
    <LiveConsoleProvider csrf={session.csrf}>
      <Shell />
    </LiveConsoleProvider>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="paper-grid flex h-full items-center justify-center text-sm text-muted-foreground">{children}</div>
}

function Shell() {
  const { state } = useConsole()
  // Below md the inbox and the thread share the screen; this picks which one shows.
  const [mobileThread, setMobileThread] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [campaignsOpen, setCampaignsOpen] = useState(false)
  const empty = state.conversations.length === 0

  return (
    <div className="flex h-full flex-col">
      <Masthead onSettings={() => setSettingsOpen(true)} onSetup={() => setSetupOpen(true)} onCampaigns={() => setCampaignsOpen(true)} />
      {empty ? (
        <EmptyState onSettings={() => setSettingsOpen(true)} onSetup={() => setSetupOpen(true)} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] md:grid-cols-[288px_minmax(0,1fr)] xl:grid-cols-[312px_minmax(0,1fr)_336px]">
          <Inbox className={cn(mobileThread && "max-md:hidden")} onOpen={() => setMobileThread(true)} />
          <ThreadPane className={cn(!mobileThread && "max-md:hidden")} onBack={() => setMobileThread(false)} />
          <ContextPanel className="hidden border-l xl:flex" />
        </div>
      )}
      <IncomingCalls onOpen={() => setMobileThread(true)} />
      <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
      <SetupSheet open={setupOpen} onOpenChange={setSetupOpen} />
      <CampaignsSheet open={campaignsOpen} onOpenChange={setCampaignsOpen} />
    </div>
  )
}

/** Nothing to show yet: say what happens next and offer the step that unblocks it. */
function EmptyState({ onSettings, onSetup }: { onSettings: () => void; onSetup: () => void }) {
  const { live, state } = useConsole()
  const system = live.system
  let text = "Conversations appear here when someone texts or calls your Sent number."
  let action: ReactNode = null
  if (!system.configured) {
    text = "Connect your Sent and OpenAI keys. Your Sent message history loads as soon as the keys work."
    action = <Button onClick={onSetup}>Connect Sent</Button>
  } else if (!state.settings.businessName) {
    text = "Enter your business name in Agent settings. The agent uses it in every greeting."
    action = <Button onClick={onSettings}>Open Agent settings</Button>
  } else if (system.phase !== "ready") {
    text = `Start the agent to answer texts and calls to ${formatPhone(state.settings.number)}.`
  }
  return (
    <section className="paper-grid flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <InboxIcon className="size-6 text-muted-foreground" aria-hidden="true" />
      <div className="space-y-1">
        <h2 className="text-base font-semibold">No conversations yet</h2>
        <p className="max-w-sm text-sm text-muted-foreground">{text}</p>
      </div>
      {action}
    </section>
  )
}
