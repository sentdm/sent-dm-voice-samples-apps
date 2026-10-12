import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/field"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useConsole } from "@/lib/console-context"
import { formatPhone } from "@/lib/format"
import { POLICY_DETAIL } from "@/lib/policy"
import { TEXT_MODELS, VOICE_MODELS } from "@/lib/models"
import type { AgentSettings, CallPolicy, InboundMode } from "@/lib/types"

const POLICY_OPTIONS: { value: CallPolicy; label: string }[] = [
  { value: "auto", label: "Call on its own" },
  { value: "ask", label: "Ask me first" },
  { value: "never", label: "Never call" },
]

const INBOUND_OPTIONS: { value: InboundMode; label: string; detail: string }[] = [
  { value: "team_first", label: "Ring the team first", detail: "The agent answers if no one picks up in time." },
  { value: "agent", label: "Agent answers", detail: "The agent picks up right away. You can listen in or take over." },
  { value: "team_only", label: "Team only", detail: "The agent never answers. It texts callers you miss." },
]

export function SettingsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="text-base">Agent settings</SheetTitle>
          <SheetDescription>How the agent texts, calls, and hands over on your Sent number.</SheetDescription>
        </SheetHeader>
        <SettingsForm onDone={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  )
}

function SettingsForm({ onDone }: { onDone: () => void }) {
  const { state, actions, live } = useConsole()
  const [draft, setDraft] = useState<AgentSettings>(state.settings)
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const numbers = live.system.numbers
  const numberLocked = live.system.phase !== "offline"

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={async (e) => {
        e.preventDefault()
        setSaving(true)
        try {
          await actions.saveSettings(draft)
          toast.success("Settings saved")
          onDone()
        } catch (error) {
          toast.error((error as Error).message)
        } finally {
          setSaving(false)
        }
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <FieldGroup>
          <FieldSet>
            <FieldLegend>Business, number, and models</FieldLegend>
            <Field>
              <FieldLabel htmlFor="business-name">Business name</FieldLabel>
              <Input id="business-name" value={draft.businessName} maxLength={80} placeholder="Your business name" onChange={(e) => set("businessName", e.target.value)} required />
              <FieldDescription>The agent greets callers with it, for example “Thanks for calling {draft.businessName || "your business"}.”</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="number">Sent number</FieldLabel>
              <Select value={draft.number || undefined} onValueChange={(v) => set("number", v)} disabled={numberLocked || numbers.length === 0}>
                <SelectTrigger id="number" className="w-full font-mono">
                  <SelectValue placeholder="Connect Sent to list your numbers" />
                </SelectTrigger>
                <SelectContent>
                  {numbers.map((n) => (
                    <SelectItem key={n} value={n} className="font-mono">
                      {formatPhone(n)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{numberLocked ? "Stop the agent to change the number." : "Calls come in and go out on this number. For texts, Sent picks the sender that serves each contact's country."}</FieldDescription>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="text-model">Text model</FieldLabel>
                <ModelSelect id="text-model" value={draft.textModel} models={TEXT_MODELS} onChange={(v) => set("textModel", v)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="voice-model">Voice model</FieldLabel>
                <ModelSelect id="voice-model" value={draft.voiceModel} models={VOICE_MODELS} onChange={(v) => set("voiceModel", v)} />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="instructions">Instructions</FieldLabel>
              <Textarea id="instructions" rows={5} value={draft.instructions} onChange={(e) => set("instructions", e.target.value)} />
              <FieldDescription>The agent uses the same instructions in text and on calls.</FieldDescription>
            </Field>
          </FieldSet>

          <FieldSeparator />

          <FieldSet>
            <FieldLegend>Outbound calls</FieldLegend>
            <FieldDescription>The agent suggests a call when talking is faster than texting, for example when the contact asks for one.</FieldDescription>
            <RadioGroup value={draft.callPolicy} onValueChange={(v) => set("callPolicy", v as CallPolicy)}>
              {POLICY_OPTIONS.map((option) => (
                <Field key={option.value} orientation="horizontal">
                  <RadioGroupItem value={option.value} id={`policy-${option.value}`} />
                  <FieldContent>
                    <FieldLabel htmlFor={`policy-${option.value}`}>{option.label}</FieldLabel>
                    <FieldDescription>{POLICY_DETAIL[option.value]}</FieldDescription>
                  </FieldContent>
                </Field>
              ))}
            </RadioGroup>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="hours-start">Calls from</FieldLabel>
                <Input id="hours-start" type="time" value={draft.callingHours.start} onChange={(e) => set("callingHours", { ...draft.callingHours, start: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="hours-end">Until</FieldLabel>
                <Input id="hours-end" type="time" value={draft.callingHours.end} onChange={(e) => set("callingHours", { ...draft.callingHours, end: e.target.value })} />
              </Field>
            </div>
            <FieldDescription>In the contact’s local time. The agent calls only people who agreed to a call.</FieldDescription>
          </FieldSet>

          <FieldSeparator />

          <FieldSet>
            <FieldLegend>Inbound calls</FieldLegend>
            <RadioGroup value={draft.inbound} onValueChange={(v) => set("inbound", v as InboundMode)}>
              {INBOUND_OPTIONS.map((option) => (
                <Field key={option.value} orientation="horizontal">
                  <RadioGroupItem value={option.value} id={`inbound-${option.value}`} />
                  <FieldContent>
                    <FieldLabel htmlFor={`inbound-${option.value}`}>{option.label}</FieldLabel>
                    <FieldDescription>{option.detail}</FieldDescription>
                  </FieldContent>
                </Field>
              ))}
            </RadioGroup>
            {draft.inbound === "team_first" && (
              <Field>
                <FieldLabel htmlFor="ring-seconds">
                  Ring the team for <span className="font-mono">{draft.teamRingSeconds} s</span>
                </FieldLabel>
                <Slider id="ring-seconds" min={5} max={25} step={5} value={[draft.teamRingSeconds]} onValueChange={([v]) => set("teamRingSeconds", v)} />
              </Field>
            )}
          </FieldSet>

          <FieldSeparator />

          <FieldSet>
            <FieldLegend>Who the agent answers</FieldLegend>
            <Field>
              <FieldLabel htmlFor="only-numbers">Only these numbers</FieldLabel>
              <Textarea
                id="only-numbers"
                rows={2}
                className="font-mono"
                placeholder="+14155551234, +14155555678"
                value={draft.onlyNumbers.join(", ")}
                onChange={(e) =>
                  set(
                    "onlyNumbers",
                    e.target.value
                      .split(/[\s,;]+/)
                      .map((n) => n.trim())
                      .filter(Boolean),
                  )
                }
              />
              <FieldDescription>
                Leave empty to answer everyone. While you test on an account with real customers, list your own phone: the agent then replies to and answers only these numbers. Texts from everyone else are still recorded; their calls are declined.
              </FieldDescription>
            </Field>
          </FieldSet>

          <FieldSeparator />

          <FieldSet>
            <FieldLegend>Hand over to a person</FieldLegend>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="handover-request">When the contact asks for a person</FieldLabel>
              </FieldContent>
              <Switch id="handover-request" checked={draft.handover.onRequest} onCheckedChange={(v) => set("handover", { ...draft.handover, onRequest: v })} />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="handover-upset">When the contact sounds upset</FieldLabel>
              </FieldContent>
              <Switch id="handover-upset" checked={draft.handover.onFrustration} onCheckedChange={(v) => set("handover", { ...draft.handover, onFrustration: v })} />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="refund-limit">Refunds the agent can approve</FieldLabel>
                <FieldDescription>Larger refunds go to a person.</FieldDescription>
              </FieldContent>
              <div className="relative w-24">
                <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
                <Input
                  id="refund-limit"
                  type="number"
                  min={0}
                  step={10}
                  className="pl-5 font-mono"
                  value={draft.handover.refundLimit}
                  onChange={(e) => set("handover", { ...draft.handover, refundLimit: Number(e.target.value) })}
                />
              </div>
            </Field>
          </FieldSet>
        </FieldGroup>
      </div>

      <SheetFooter className="flex-row justify-end border-t px-5 py-3">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </Button>
      </SheetFooter>
    </form>
  )
}

function ModelSelect({ id, value, models, onChange }: { id: string; value: string; models: ReadonlyArray<{ id: string; label: string; note: string }>; onChange: (value: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue>{models.find((m) => m.id === value)?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {models.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.label}
            <span className="text-muted-foreground">{m.note}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
