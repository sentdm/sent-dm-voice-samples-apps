"use client";

import { useState } from "react";
import { toast } from "sonner";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Loading } from "@/components/page-status";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiClientError } from "@/lib/client/api";
import { describeError } from "@/lib/client/format";
import type {
  MenuOption,
  MenuOptionAction,
  RoutingMode,
  RoutingRules,
  VoiceInstruction,
  VoiceInstructionName,
} from "@/lib/shared/types";

const MODES: { value: RoutingMode; label: string; help: string }[] = [
  {
    value: "smart",
    label: "Smart",
    help: "Ring the app user when online, else the fallback number, else reject as busy. Phone destinations are dialed, rooms are joined.",
  },
  {
    value: "user",
    label: "Always connect to a user",
    help: "connectToUser to a fixed identity, or the first online one.",
  },
  {
    value: "number",
    label: "Always connect to a number",
    help: "connectToNumber to a fixed phone number.",
  },
  {
    value: "conference",
    label: "Always join a room",
    help: "connectToConference to a fixed room name.",
  },
  {
    value: "menu",
    label: "Play a menu",
    help: "playMenu; the keypresses come back as call.input questions.",
  },
  {
    value: "park",
    label: "Hold (park)",
    help: "park with intro and hold prompts. When the hold runs out the call ends.",
  },
  { value: "reject", label: "Reject", help: "reject with busy or declined." },
  {
    value: "hangup",
    label: "Hang up",
    help: "hangup, after the instructions.",
  },
];

const MENU_ACTIONS: MenuOptionAction[] = [
  "user",
  "number",
  "conference",
  "park",
  "hangup",
  "menu",
];
/** A new, empty instruction of each kind. Entries are only ever copied, never changed. */
const BLANK: Record<VoiceInstructionName, VoiceInstruction> = {
  say: { instruction: "say", text: "" },
  play: { instruction: "play", url: "" },
  sendDigits: { instruction: "sendDigits", digits: "" },
  answer: { instruction: "answer" },
  setCookie: { instruction: "setCookie", key: "", value: "" },
  startRecording: { instruction: "startRecording" },
  stopRecording: { instruction: "stopRecording" },
};
const INSTRUCTION_NAMES = Object.keys(BLANK) as VoiceInstructionName[];

/** Edits what the callback answers. Saved on the server; the callback reads it on every question. */
export function RoutingPanel({ rules }: { rules: RoutingRules | null }) {
  // Only the unsaved edit is state; without one the panel shows the server's rules.
  const [edited, setEdited] = useState<RoutingRules | null>(null);
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const draft = edited ?? rules;
  const dirty = edited !== null;

  if (!draft) return <Loading>Loading rules</Loading>;

  const update = (patch: Partial<RoutingRules>) =>
    setEdited({ ...draft, ...patch });

  const save = async () => {
    setSaving(true);
    setIssues([]);
    try {
      await api.routing.save(draft);
      setEdited(null);
      toast.success("Routing rules saved. They apply to the next question.");
    } catch (error) {
      if (error instanceof ApiClientError && Array.isArray(error.details)) {
        setIssues(error.details as { path: string; message: string }[]);
      }
      toast.error(describeError(error));
    } finally {
      setSaving(false);
    }
  };

  const mode = MODES.find((entry) => entry.value === draft.mode)!;

  return (
    <Card>
      <CardHeader>
        <CardTitle>How the callback answers</CardTitle>
        <CardDescription>
          Sent asks this app what to do with every call. These rules decide the
          answer: an action, and optional instructions that run before it.
        </CardDescription>
      </CardHeader>
      <CardContent className="gap-5">
        <Field label="Mode" help={mode.help}>
          <NativeSelect
            className="w-full"
            value={draft.mode}
            onChange={(event) =>
              update({ mode: event.target.value as RoutingMode })
            }
          >
            {MODES.map((entry) => (
              <NativeSelectOption key={entry.value} value={entry.value}>
                {entry.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>

        {(draft.mode === "smart" ||
          draft.mode === "user" ||
          draft.mode === "number") && (
          <Toggle
            label="Room per call"
            help="Answer with a room named after the call and dial the other party into it right after. Every call then has a roster, so participants and transfer work on all of them."
            checked={draft.roomPerCall}
            onChange={(roomPerCall) => update({ roomPerCall })}
          />
        )}

        {draft.mode === "smart" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Fallback phone number"
              help="Dialed when the app user is offline. Empty rejects the call as busy."
            >
              <Input
                value={draft.smart.fallbackNumber}
                placeholder="+14155551234"
                onChange={(event) =>
                  update({
                    smart: {
                      ...draft.smart,
                      fallbackNumber: event.target.value,
                    },
                  })
                }
              />
            </Field>
            <Field
              label="Inbound calls ring"
              help="The app user that rings when someone dials your number. Empty rings the first online one."
            >
              <Input
                value={draft.smart.inboundIdentity}
                placeholder="agent-1"
                onChange={(event) =>
                  update({
                    smart: {
                      ...draft.smart,
                      inboundIdentity: event.target.value,
                    },
                  })
                }
              />
            </Field>
          </div>
        )}

        {draft.mode === "user" && (
          <Field label="Identity" help="Empty rings the first online app user.">
            <Input
              value={draft.forced.identity}
              placeholder="agent-1"
              onChange={(event) =>
                update({
                  forced: { ...draft.forced, identity: event.target.value },
                })
              }
            />
          </Field>
        )}
        {draft.mode === "number" && (
          <Field
            label="Phone number"
            help="Empty uses the number the caller dialed, when there is one."
          >
            <Input
              value={draft.forced.number}
              placeholder="+14155551234"
              onChange={(event) =>
                update({
                  forced: { ...draft.forced, number: event.target.value },
                })
              }
            />
          </Field>
        )}
        {draft.mode === "conference" && (
          <Field label="Room name" help="Up to 27 letters, digits, - and _.">
            <Input
              value={draft.forced.conferenceName}
              placeholder="demo-room"
              onChange={(event) =>
                update({
                  forced: {
                    ...draft.forced,
                    conferenceName: event.target.value,
                  },
                })
              }
            />
          </Field>
        )}

        {(draft.mode === "smart" || draft.mode === "number") && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Caller id for phone legs"
              help="A number your account owns. Empty presents the call's owning number."
            >
              <Input
                value={draft.callerId}
                placeholder="+14155551234"
                onChange={(event) => update({ callerId: event.target.value })}
              />
            </Field>
            <Field
              label="Dial timeout in seconds"
              help="How long a phone rings before giving up. Empty leaves Sent's default."
            >
              <Input
                type="number"
                min={1}
                max={600}
                value={draft.dialTimeoutSeconds ?? ""}
                onChange={(event) =>
                  update({
                    dialTimeoutSeconds: event.target.value
                      ? Number(event.target.value)
                      : null,
                  })
                }
              />
            </Field>
          </div>
        )}

        {draft.mode === "reject" && (
          <Field label="Reason">
            <NativeSelect
              className="w-full"
              value={draft.reject.reason}
              onChange={(event) =>
                update({
                  reject: { reason: event.target.value as "busy" | "declined" },
                })
              }
            >
              <NativeSelectOption value="busy">busy</NativeSelectOption>
              <NativeSelectOption value="declined">declined</NativeSelectOption>
            </NativeSelect>
          </Field>
        )}

        {draft.mode === "park" && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Intro prompt">
              <Input
                value={draft.park.introPrompt}
                onChange={(event) =>
                  update({
                    park: { ...draft.park, introPrompt: event.target.value },
                  })
                }
              />
            </Field>
            <Field label="Hold prompt">
              <Input
                value={draft.park.holdPrompt}
                onChange={(event) =>
                  update({
                    park: { ...draft.park, holdPrompt: event.target.value },
                  })
                }
              />
            </Field>
            <Field label="Max seconds (up to 600)">
              <Input
                type="number"
                min={1}
                max={600}
                value={draft.park.maxDurationSeconds}
                onChange={(event) =>
                  update({
                    park: {
                      ...draft.park,
                      maxDurationSeconds: Number(event.target.value) || 1,
                    },
                  })
                }
              />
            </Field>
          </div>
        )}

        <MenuEditor rules={draft} onChange={update} />

        <Toggle
          label="Record the call"
          help="Adds record: true to connect answers. Recording needs a phone leg; app-to-app calls are not recorded."
          checked={draft.record}
          onChange={(record) => update({ record })}
        />

        <InstructionsEditor
          instructions={draft.instructions}
          onChange={(instructions) => update({ instructions })}
        />

        {issues.length > 0 && (
          <ul className="text-destructive text-xs">
            {issues.map((issue) => (
              <li key={`${issue.path}-${issue.message}`}>
                {issue.path || "rules"}: {issue.message}
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-3">
          <Button type="button" onClick={save} disabled={saving || !dirty}>
            {saving && <Spinner />}
            Save rules
          </Button>
          {dirty && (
            <span className="text-muted-foreground text-xs">
              Unsaved changes
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function MenuEditor({
  rules,
  onChange,
}: {
  rules: RoutingRules;
  onChange: (patch: Partial<RoutingRules>) => void;
}) {
  const menu = rules.menu;
  const set = (patch: Partial<RoutingRules["menu"]>) =>
    onChange({ menu: { ...menu, ...patch } });
  const setOption = (index: number, patch: Partial<MenuOption>) =>
    set({
      options: menu.options.map((option, i) =>
        i === index ? { ...option, ...patch } : option
      ),
    });

  return (
    <details open={rules.mode === "menu"} className="rounded-md border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        Menu (used by the menu mode and by menu keys)
      </summary>
      <div className="mt-3 grid gap-3">
        <Field label="Prompt (text to speech, no ] character)">
          <Textarea
            value={menu.prompt}
            onChange={(event) => set({ prompt: event.target.value })}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Max digits">
            <Input
              type="number"
              min={1}
              max={20}
              value={menu.maxDigits}
              onChange={(event) =>
                set({ maxDigits: Number(event.target.value) || 1 })
              }
            />
          </Field>
          <Field label="Timeout seconds">
            <Input
              type="number"
              min={1}
              max={60}
              value={menu.timeoutSeconds}
              onChange={(event) =>
                set({ timeoutSeconds: Number(event.target.value) || 1 })
              }
            />
          </Field>
          <Field label="Prompt repeats">
            <Input
              type="number"
              min={0}
              max={10}
              value={menu.repeats}
              onChange={(event) =>
                set({ repeats: Number(event.target.value) || 0 })
              }
            />
          </Field>
          <Field label="Attempts before goodbye">
            <Input
              type="number"
              min={1}
              max={10}
              value={menu.maxAttempts}
              onChange={(event) =>
                set({ maxAttempts: Number(event.target.value) || 1 })
              }
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Said after an invalid choice">
            <Input
              value={menu.invalidText}
              onChange={(event) => set({ invalidText: event.target.value })}
            />
          </Field>
          <Field label="Said before hanging up">
            <Input
              value={menu.goodbyeText}
              onChange={(event) => set({ goodbyeText: event.target.value })}
            />
          </Field>
        </div>
        <Label>Keys</Label>
        {menu.options.map((option, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <Input
              className="w-16"
              value={option.digits}
              placeholder="1"
              onChange={(event) =>
                setOption(index, { digits: event.target.value })
              }
            />
            <NativeSelect
              value={option.action}
              onChange={(event) =>
                setOption(index, {
                  action: event.target.value as MenuOptionAction,
                })
              }
            >
              {MENU_ACTIONS.map((action) => (
                <NativeSelectOption key={action} value={action}>
                  {action}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {(option.action === "user" ||
              option.action === "number" ||
              option.action === "conference") && (
              <Input
                className="w-48"
                value={option.value}
                placeholder={
                  option.action === "user"
                    ? "identity, empty = first online"
                    : option.action === "number"
                      ? "+14155551234"
                      : "room name"
                }
                onChange={(event) =>
                  setOption(index, { value: event.target.value })
                }
              />
            )}
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Remove key"
              onClick={() =>
                set({ options: menu.options.filter((_, i) => i !== index) })
              }
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-fit"
          onClick={() =>
            set({
              options: [
                ...menu.options,
                { digits: "", action: "user", value: "" },
              ],
            })
          }
        >
          <PlusIcon /> Add a key
        </Button>
      </div>
    </details>
  );
}

function InstructionsEditor({
  instructions,
  onChange,
}: {
  instructions: VoiceInstruction[];
  onChange: (instructions: VoiceInstruction[]) => void;
}) {
  const replace = (index: number, instruction: VoiceInstruction) =>
    onChange(
      instructions.map((entry, i) => (i === index ? instruction : entry))
    );

  return (
    <details open={instructions.length > 0} className="rounded-md border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        Instructions run before the action on every new call (
        {instructions.length})
      </summary>
      <div className="mt-3 grid gap-2">
        {instructions.map((instruction, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <NativeSelect
              value={instruction.instruction}
              onChange={(event) =>
                replace(
                  index,
                  BLANK[event.target.value as VoiceInstructionName]
                )
              }
            >
              {INSTRUCTION_NAMES.map((name) => (
                <NativeSelectOption key={name} value={name}>
                  {name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {instruction.instruction === "say" && (
              <>
                <Input
                  className="w-64"
                  value={instruction.text}
                  placeholder="Connecting you"
                  onChange={(event) =>
                    replace(index, { ...instruction, text: event.target.value })
                  }
                />
                <Input
                  className="w-24"
                  value={instruction.locale ?? ""}
                  placeholder="en-US"
                  onChange={(event) =>
                    replace(index, {
                      ...instruction,
                      locale: event.target.value || undefined,
                    })
                  }
                />
              </>
            )}
            {instruction.instruction === "play" && (
              <Input
                className="w-80"
                value={instruction.url}
                placeholder="https://example.com/greeting.mp3"
                onChange={(event) =>
                  replace(index, { ...instruction, url: event.target.value })
                }
              />
            )}
            {instruction.instruction === "sendDigits" && (
              <Input
                className="w-40"
                value={instruction.digits}
                placeholder="1w2"
                onChange={(event) =>
                  replace(index, { ...instruction, digits: event.target.value })
                }
              />
            )}
            {instruction.instruction === "setCookie" && (
              <>
                <Input
                  className="w-32"
                  value={instruction.key}
                  placeholder="key"
                  onChange={(event) =>
                    replace(index, { ...instruction, key: event.target.value })
                  }
                />
                <Input
                  className="w-40"
                  value={instruction.value}
                  placeholder="value"
                  onChange={(event) =>
                    replace(index, {
                      ...instruction,
                      value: event.target.value,
                    })
                  }
                />
              </>
            )}
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Remove instruction"
              onClick={() =>
                onChange(instructions.filter((_, i) => i !== index))
              }
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-fit"
          onClick={() => onChange([...instructions, BLANK.say])}
        >
          <PlusIcon /> Add an instruction
        </Button>
      </div>
    </details>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
      {help && <p className="text-muted-foreground text-xs">{help}</p>}
    </div>
  );
}

function Toggle({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch
        checked={checked}
        onCheckedChange={(next) => onChange(next)}
        className="mt-0.5"
      />
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-muted-foreground text-xs">{help}</p>
      </div>
    </div>
  );
}
