import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useConsole } from "@/lib/console-context"

/** The Sent and OpenAI keys. They go to the local server once and stay in its memory. */
export function SetupSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { live } = useConsole()
  const [sentKey, setSentKey] = useState("")
  const [openaiKey, setOpenaiKey] = useState("")
  const [busy, setBusy] = useState(false)
  const running = live.system.phase !== "offline"

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="text-base">Connect Sent and OpenAI</SheetTitle>
          <SheetDescription>
            The keys stay in the memory of the server on this computer. They are not saved in this browser or on disk. You can also set SENT_DM_API_KEY and OPENAI_API_KEY in a .env file.
          </SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={async (event) => {
            event.preventDefault()
            setBusy(true)
            try {
              await live.connect(sentKey, openaiKey)
              setSentKey("")
              setOpenaiKey("")
              toast.success("Keys work. Loading your Sent conversations.")
              onOpenChange(false)
            } catch (error) {
              toast.error((error as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
            <FieldGroup>
              {live.system.keySource === "env" && <p className="text-sm text-muted-foreground">The app is using the keys from your environment. Enter other keys to replace them for this session.</p>}
              <Field>
                <FieldLabel htmlFor="sent-key">Sent API key</FieldLabel>
                <Input id="sent-key" type="password" autoComplete="off" spellCheck={false} value={sentKey} onChange={(e) => setSentKey(e.target.value)} required />
                <FieldDescription>Needs voice numbers and messaging. The app does not buy numbers.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="openai-key">OpenAI API key</FieldLabel>
                <Input id="openai-key" type="password" autoComplete="off" spellCheck={false} value={openaiKey} onChange={(e) => setOpenaiKey(e.target.value)} required />
                <FieldDescription>Used for the text agent and the voice agent.</FieldDescription>
              </Field>
              {running && <p className="text-sm text-warn-ink">Stop the agent before you change keys.</p>}
            </FieldGroup>
          </div>
          <SheetFooter className="flex-row justify-end border-t px-5 py-3">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || running || !sentKey || !openaiKey}>
              {busy ? "Checking…" : "Connect"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
