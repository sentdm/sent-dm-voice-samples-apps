import { Fragment, useMemo } from "react"
import { Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useConsole, useLineBusy, useSelectedConversation } from "@/lib/console-context"
import { useNow } from "@/hooks/use-now"
import { cn } from "@/lib/utils"
import { CHANNEL_LABEL, contactPlace, contactZone, displayName, firstName, formatClock, formatPhone, localTime, ownZone } from "@/lib/format"
import { activeCall, callChecks, canCall } from "@/lib/policy"
import { CHANNEL_ICON, ContactAvatar } from "./bits"

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="space-y-3 px-4 py-4">
      <div className="flex items-baseline gap-2">
        <h3 className="text-xs font-semibold">{title}</h3>
        {aside && <div className="ml-auto text-xs text-muted-foreground">{aside}</div>}
      </div>
      {children}
    </section>
  )
}

export function ContextPanel({ className }: { className?: string }) {
  const { state, actions } = useConsole()
  const c = useSelectedConversation()
  const lineBusy = useLineBusy(c)
  const now = useNow(30_000)
  const zones = useMemo(() => Intl.supportedValuesOf("timeZone"), [])
  if (!c) return null
  const { contact } = c
  const checks = callChecks(c, state.settings, now, "agent", lineBusy)
  const busy = Boolean(activeCall(c))
  const verdicts = [
    {
      who: "Agent",
      ok: canCall(c, state.settings, now, "agent", lineBusy),
      yes: state.settings.callPolicy === "auto" ? "Calls on its own" : "Calls after you approve",
    },
    { who: "You", ok: canCall(c, state.settings, now, "human", lineBusy), yes: "Can call from this browser" },
  ]

  return (
    <aside className={cn("min-h-0 flex-col bg-panel", className)} aria-label="Contact and agent">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="divide-y">
          <section className="space-y-4 px-4 pt-5 pb-4">
            <div className="flex items-center gap-3">
              <ContactAvatar contact={contact} size="lg" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{displayName(contact)}</p>
                {contact.name && <p className="font-mono text-xs text-muted-foreground">{formatPhone(contact.phone)}</p>}
              </div>
            </div>
            <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
              <dt className="text-muted-foreground">Local time</dt>
              <dd>
                {localTime(contactZone(contact), now)} in {contactPlace(contact)}
              </dd>
              <dt className="pt-1 text-muted-foreground">
                <label htmlFor="contact-zone">Time zone</label>
              </dt>
              <dd>
                <select
                  id="contact-zone"
                  className="h-7 w-full rounded-sm border border-input bg-background px-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                  value={contact.timeZone ?? ""}
                  onChange={(e) => e.target.value && actions.setTimeZone(c.id, e.target.value)}
                >
                  <option value="">Unknown (using yours, {ownZone()})</option>
                  {zones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </dd>
              <dt className="text-muted-foreground">Reachable on</dt>
              <dd className="flex flex-wrap gap-1.5">
                {contact.channels.length === 0 && <span className="text-muted-foreground">No texts yet</span>}
                {contact.channels.map((ch) => {
                  const Icon = CHANNEL_ICON[ch]
                  return (
                    <span key={ch} className="inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5">
                      <Icon className="size-3" aria-hidden="true" />
                      {CHANNEL_LABEL[ch]}
                    </span>
                  )
                })}
              </dd>
              {contact.optedOut && (
                <>
                  <dt className="text-muted-foreground">Texts</dt>
                  <dd className="text-live">Opted out (texted STOP)</dd>
                </>
              )}
              {contact.tags.length > 0 && (
                <>
                  <dt className="text-muted-foreground">Notes</dt>
                  <dd className="flex flex-wrap gap-1.5">
                    {contact.tags.map((tag) => (
                      <span key={tag} className="rounded-sm bg-muted px-1.5 py-0.5">
                        {tag}
                      </span>
                    ))}
                  </dd>
                </>
              )}
            </dl>
          </section>

          <Section title="Calling this contact">
            <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
              {verdicts.map((v) => (
                <Fragment key={v.who}>
                  <dt className="text-muted-foreground">{v.who}</dt>
                  <dd className={cn("font-medium", busy ? "text-muted-foreground" : v.ok ? "text-ok" : "text-live")}>
                    {busy ? "On a call now" : v.ok ? v.yes : "Can’t call now"}
                  </dd>
                </Fragment>
              ))}
            </dl>
            <ul className="space-y-2.5">
              {checks.map((check) => (
                <li key={check.id} className="flex gap-2 text-xs">
                  {check.ok ? <Check className="mt-px size-3.5 shrink-0 text-ok" aria-label="Passes" /> : <X className="mt-px size-3.5 shrink-0 text-live" aria-label="Fails" />}
                  <div className="min-w-0 space-y-0.5">
                    <p className={cn("font-medium", !check.ok && "text-live")}>
                      {check.label}
                      {check.id === "policy" && <span className="font-normal text-muted-foreground"> (agent only)</span>}
                    </p>
                    <p className="text-muted-foreground">{check.detail}</p>
                    {check.id === "consent" && (
                      <Button size="xs" variant="outline" className="mt-1" onClick={() => actions.setConsent(c.id, !contact.callConsent.granted)}>
                        {contact.callConsent.granted ? "Remove consent" : `${firstName(contact)} agreed to a call`}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Agent activity" aside={<span className="font-mono">{c.toolLog.length}</span>}>
            {c.toolLog.length === 0 ? (
              <p className="text-xs text-muted-foreground">The agent hasn’t acted in this conversation yet.</p>
            ) : (
              <ol className="space-y-2.5">
                {[...c.toolLog].reverse().map((call) => (
                  <li key={call.id} className="space-y-0.5 text-xs">
                    <div className="flex items-baseline gap-2">
                      <code className="font-mono text-[11px] text-agent">{call.name}</code>
                      <time className="ml-auto font-mono text-[10px] text-muted-foreground">{formatClock(call.at)}</time>
                    </div>
                    <p className="break-words text-muted-foreground">{call.detail}</p>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>
      </div>
    </aside>
  )
}
