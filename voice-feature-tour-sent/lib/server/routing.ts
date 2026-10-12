import { z } from "zod";
import { E164_PATTERN, IDENTITY_PATTERN } from "@/lib/shared/validation";
import type {
  CallInputQuestion,
  CallRequestQuestion,
  MenuOption,
  ParticipantTarget,
  RoutingRules,
  VoiceAction,
  VoiceAddress,
  VoiceAnswer,
  VoiceInstruction,
  VoiceQuestion,
} from "@/lib/shared/types";

/**
 * Turns a question Sent asked into the answer this backend gives. Pure: no I/O, so the
 * callback route stays well inside the 2.5 second deadline. The rules come from the
 * routing panel in the console; presence comes from the browsers' heartbeats.
 */

export const DEFAULT_ROUTING_RULES: RoutingRules = {
  mode: "smart",
  record: false,
  roomPerCall: false,
  callerId: "",
  dialTimeoutSeconds: null,
  smart: {
    fallbackNumber: "",
    inboundIdentity: "",
  },
  forced: {
    identity: "",
    number: "",
    conferenceName: "demo-room",
  },
  menu: {
    prompt:
      "Press 1 to talk to an agent, 2 to join the demo room, 3 to hold, or 9 to hang up.",
    maxDigits: 1,
    timeoutSeconds: 5,
    repeats: 2,
    invalidText: "That was not a valid choice.",
    goodbyeText: "Goodbye.",
    maxAttempts: 2,
    options: [
      { digits: "1", action: "user", value: "" },
      { digits: "2", action: "conference", value: "demo-room" },
      { digits: "3", action: "park", value: "" },
      { digits: "9", action: "hangup", value: "" },
    ],
  },
  park: {
    introPrompt: "Please hold.",
    holdPrompt: "Thank you for waiting.",
    maxDurationSeconds: 120,
  },
  reject: {
    reason: "busy",
  },
  instructions: [],
};

const ROOM = /^[A-Za-z0-9_-]{1,27}$/;
const DIGITS = /^[0-9#*]{1,10}$/;

/** Menu and hold prompts are wrapped in a text-to-speech macro that a `]` would close early. */
const promptText = z
  .string()
  .trim()
  .min(1)
  .refine((text) => !text.includes("]"), "Prompt text cannot contain ]");

const optionalE164 = z
  .string()
  .trim()
  .refine(
    (value) => value === "" || E164_PATTERN.test(value),
    "Use E.164, for example +14155551234"
  );

const optionalIdentity = z
  .string()
  .trim()
  .refine(
    (value) => value === "" || IDENTITY_PATTERN.test(value),
    "Letters, digits, - and _ only"
  );

export const instructionSchema = z.discriminatedUnion("instruction", [
  z.object({
    instruction: z.literal("say"),
    text: z.string().trim().min(1),
    locale: z.string().trim().optional(),
  }),
  z.object({ instruction: z.literal("play"), url: z.string().trim().url() }),
  z.object({
    instruction: z.literal("sendDigits"),
    digits: z
      .string()
      .trim()
      .regex(/^[0-9#*A-Dw]+$/, "Digits 0-9, #, *, A-D and w"),
  }),
  z.object({ instruction: z.literal("startRecording") }),
  z.object({ instruction: z.literal("stopRecording") }),
  z.object({ instruction: z.literal("answer") }),
  z.object({
    instruction: z.literal("setCookie"),
    key: z.string().trim().min(1),
    value: z.string(),
  }),
]);

export const routingRulesSchema: z.ZodType<RoutingRules> = z.object({
  mode: z.enum([
    "smart",
    "user",
    "number",
    "conference",
    "menu",
    "park",
    "reject",
    "hangup",
  ]),
  record: z.boolean(),
  roomPerCall: z.boolean(),
  callerId: optionalE164,
  dialTimeoutSeconds: z.number().int().min(1).max(600).nullable(),
  smart: z.object({
    fallbackNumber: optionalE164,
    inboundIdentity: optionalIdentity,
  }),
  forced: z.object({
    identity: optionalIdentity,
    number: optionalE164,
    conferenceName: z
      .string()
      .trim()
      .refine(
        (value) => value === "" || ROOM.test(value),
        "Up to 27 letters, digits, - and _"
      ),
  }),
  menu: z.object({
    prompt: promptText,
    maxDigits: z.number().int().min(1).max(20),
    timeoutSeconds: z.number().int().min(1).max(60),
    repeats: z.number().int().min(0).max(10),
    invalidText: z.string().trim().min(1),
    goodbyeText: z.string().trim().min(1),
    maxAttempts: z.number().int().min(1).max(10),
    options: z.array(
      z.object({
        digits: z.string().trim().regex(DIGITS, "Digits 0-9, # and *"),
        action: z.enum([
          "user",
          "number",
          "conference",
          "park",
          "hangup",
          "menu",
        ]),
        value: z.string().trim(),
      })
    ),
  }),
  park: z.object({
    introPrompt: promptText,
    holdPrompt: promptText,
    maxDurationSeconds: z.number().int().min(1).max(600),
  }),
  reject: z.object({ reason: z.enum(["busy", "declined"]) }),
  instructions: z.array(instructionSchema),
});

export interface RoutingContext {
  /** Identities with a fresh presence heartbeat. */
  online: string[];
}

export interface RoutingDecision {
  answer: VoiceAnswer;
  explanation: string;
  /** Room per call: who the server dials into the room right after answering. */
  followUp: ParticipantTarget | null;
  /** App users that take part after this answer, for the call map. */
  identities: string[];
  conferenceName: string | null;
}

/** A room name for one call: `r` plus 26 hex characters of the id, within the 27 character limit. */
export function roomNameFor(callId: string): string {
  return `r${callId
    .replace(/^call_/, "")
    .replace(/-/g, "")
    .slice(0, 26)}`;
}

export function decide(
  question: VoiceQuestion,
  rules: RoutingRules,
  context: RoutingContext
): RoutingDecision {
  return question.type === "call.request"
    ? decideCallRequest(question, rules, context)
    : decideCallInput(question, rules, context);
}

function decideCallRequest(
  question: CallRequestQuestion,
  rules: RoutingRules,
  context: RoutingContext
): RoutingDecision {
  const builder = new AnswerBuilder(
    rules,
    question.callId,
    identityOf(question.from)
  );
  // The menu counts its attempts in a cookie, which comes back with each keypress.
  const instructions: VoiceInstruction[] =
    rules.mode === "menu"
      ? [
          ...rules.instructions,
          { instruction: "setCookie", key: "menuAttempts", value: "1" },
        ]
      : rules.instructions;
  return builder.finish(
    callRequestStep(question, rules, context, builder),
    instructions
  );
}

function callRequestStep(
  question: CallRequestQuestion,
  rules: RoutingRules,
  context: RoutingContext,
  builder: AnswerBuilder
): Step {
  switch (rules.mode) {
    case "smart":
      return smart(question, rules, context, builder);
    case "user": {
      const identity = rules.forced.identity || context.online[0];
      if (!identity) {
        return builder.reject(
          "declined",
          "User mode, but no identity is set and nobody is online"
        );
      }
      return builder.user(identity, `User mode rings ${identity}`);
    }
    case "number": {
      const number =
        rules.forced.number ||
        (question.to.kind === "number" ? question.to.number : "");
      if (!number) {
        return builder.reject(
          "declined",
          "Number mode, but no number is set and the call has no phone destination"
        );
      }
      return builder.number(number, `Number mode dials ${number}`);
    }
    case "conference": {
      const name =
        rules.forced.conferenceName ||
        (question.to.kind === "conference" ? question.to.name : "demo-room");
      return builder.room(name, `Conference mode joins room ${name}`);
    }
    case "menu":
      return builder.menu("Menu mode plays the menu");
    case "park":
      return builder.park("Park mode holds the call");
    case "reject":
      return builder.reject(
        rules.reject.reason,
        `Reject mode turns the call away as ${rules.reject.reason}`
      );
    case "hangup":
      return builder.hangup("Hangup mode ends the call");
  }
}

function smart(
  question: CallRequestQuestion,
  rules: RoutingRules,
  context: RoutingContext,
  builder: AnswerBuilder
): Step {
  const { to } = question;

  if (to.kind === "user") {
    if (context.online.includes(to.identity)) {
      return builder.user(
        to.identity,
        `${to.identity} is online, ringing the app`
      );
    }
    if (rules.smart.fallbackNumber) {
      return builder.number(
        rules.smart.fallbackNumber,
        `${to.identity} is offline, dialing the fallback number`
      );
    }
    return builder.reject(
      "busy",
      `${to.identity} is offline and no fallback number is set`
    );
  }

  if (to.kind === "conference") {
    return builder.room(to.name, `Joining room ${to.name}`);
  }

  if (to.kind === "number" && question.direction === "outbound") {
    return builder.number(to.number, `App user dialed a phone number`);
  }

  // Inbound: someone dialed the configured number.
  const preferred = rules.smart.inboundIdentity;
  const identity =
    preferred && context.online.includes(preferred)
      ? preferred
      : context.online[0];
  if (identity) {
    return builder.user(identity, `Inbound call, ringing ${identity}`);
  }
  if (rules.smart.fallbackNumber) {
    return builder.number(
      rules.smart.fallbackNumber,
      "Inbound call, nobody online, dialing the fallback number"
    );
  }
  return builder.reject(
    "busy",
    "Inbound call, nobody online and no fallback number"
  );
}

function decideCallInput(
  question: CallInputQuestion,
  rules: RoutingRules,
  context: RoutingContext
): RoutingDecision {
  const builder = new AnswerBuilder(rules, question.callId, null);
  const option = rules.menu.options.find(
    (entry) => entry.digits === question.digits
  );

  if (!option) {
    const attempts = Number(question.cookies?.menuAttempts ?? "1") || 1;
    if (attempts < rules.menu.maxAttempts) {
      return builder.finish(
        builder.menu(
          question.digits
            ? `Unknown choice ${question.digits}, playing the menu again`
            : "No input, playing the menu again"
        ),
        [
          { instruction: "say", text: rules.menu.invalidText },
          {
            instruction: "setCookie",
            key: "menuAttempts",
            value: String(attempts + 1),
          },
        ]
      );
    }
    return builder.finish(
      builder.hangup(
        `No valid choice after ${attempts} attempts, saying goodbye`
      ),
      [{ instruction: "say", text: rules.menu.goodbyeText }]
    );
  }

  return builder.finish(menuOption(option, rules, context, builder), []);
}

function menuOption(
  option: MenuOption,
  rules: RoutingRules,
  context: RoutingContext,
  builder: AnswerBuilder
): Step {
  switch (option.action) {
    case "user": {
      const identity = option.value || context.online[0];
      if (!identity) {
        return builder.hangup(`Key ${option.digits}: nobody is online`, [
          { instruction: "say", text: "Nobody is available right now." },
        ]);
      }
      return builder.user(identity, `Key ${option.digits} rings ${identity}`);
    }
    case "number":
      return option.value
        ? builder.number(
            option.value,
            `Key ${option.digits} dials ${option.value}`
          )
        : builder.hangup(`Key ${option.digits} has no number set`);
    case "conference":
      return builder.room(
        option.value || "demo-room",
        `Key ${option.digits} joins a room`
      );
    case "park":
      return builder.park(`Key ${option.digits} holds the call`);
    case "menu":
      return builder.menu(`Key ${option.digits} replays the menu`);
    case "hangup":
      return builder.hangup(`Key ${option.digits} ends the call`, [
        { instruction: "say", text: rules.menu.goodbyeText },
      ]);
  }
}

interface Step {
  action: VoiceAction;
  explanation: string;
  extraInstructions: VoiceInstruction[];
  followUp: RoutingDecision["followUp"];
  identities: string[];
  conferenceName: string | null;
}

class AnswerBuilder {
  constructor(
    private readonly rules: RoutingRules,
    private readonly callId: string,
    private readonly caller: string | null
  ) {}

  user(identity: string, explanation: string): Step {
    if (this.rules.roomPerCall)
      return this.viaRoom({ kind: "user", value: identity }, explanation);
    return this.step(
      { action: "connectToUser", identity, ...this.record() },
      explanation,
      [identity],
      null
    );
  }

  number(number: string, explanation: string): Step {
    if (this.rules.roomPerCall)
      return this.viaRoom({ kind: "number", value: number }, explanation);
    return this.step(
      {
        action: "connectToNumber",
        number,
        ...(this.rules.callerId ? { callerId: this.rules.callerId } : {}),
        ...(this.rules.dialTimeoutSeconds
          ? { dialTimeoutSeconds: this.rules.dialTimeoutSeconds }
          : {}),
        ...this.record(),
      },
      explanation,
      [],
      null
    );
  }

  room(name: string, explanation: string): Step {
    return this.step(
      { action: "connectToConference", name, ...this.record() },
      explanation,
      [],
      name
    );
  }

  menu(explanation: string): Step {
    const menu = this.rules.menu;
    return this.step(
      {
        action: "playMenu",
        prompt: { text: menu.prompt },
        maxDigits: menu.maxDigits,
        timeoutSeconds: menu.timeoutSeconds,
        repeats: menu.repeats,
      },
      explanation,
      [],
      null
    );
  }

  park(explanation: string): Step {
    const park = this.rules.park;
    return this.step(
      {
        action: "park",
        introPrompt: { text: park.introPrompt },
        holdPrompt: { text: park.holdPrompt },
        maxDurationSeconds: park.maxDurationSeconds,
      },
      explanation,
      [],
      null
    );
  }

  reject(reason: "busy" | "declined", explanation: string): Step {
    return this.step({ action: "reject", reason }, explanation, [], null);
  }

  hangup(
    explanation: string,
    extraInstructions: VoiceInstruction[] = []
  ): Step {
    return {
      ...this.step({ action: "hangup" }, explanation, [], null),
      extraInstructions,
    };
  }

  finish(step: Step, instructions: VoiceInstruction[]): RoutingDecision {
    const all = [...instructions, ...step.extraInstructions];
    return {
      answer:
        all.length > 0
          ? { instructions: all, action: step.action }
          : { action: step.action },
      explanation: step.explanation,
      followUp: step.followUp,
      identities: Array.from(
        new Set([...(this.caller ? [this.caller] : []), ...step.identities])
      ),
      conferenceName: step.conferenceName,
    };
  }

  private viaRoom(target: ParticipantTarget, explanation: string): Step {
    const name = roomNameFor(this.callId);
    return {
      ...this.step(
        { action: "connectToConference", name, ...this.record() },
        `${explanation}, through room ${name} (room per call)`,
        target.kind === "user" ? [target.value] : [],
        name
      ),
      followUp: target,
    };
  }

  private record(): { record: true } | Record<string, never> {
    return this.rules.record ? { record: true } : {};
  }

  private step(
    action: VoiceAction,
    explanation: string,
    identities: string[],
    conferenceName: string | null
  ): Step {
    return {
      action,
      explanation,
      extraInstructions: [],
      followUp: null,
      identities,
      conferenceName,
    };
  }
}

export function identityOf(address: VoiceAddress): string | null {
  return address.kind === "user" ? address.identity : null;
}
