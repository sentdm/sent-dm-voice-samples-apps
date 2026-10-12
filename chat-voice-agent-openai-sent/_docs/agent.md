# The agent

This document describes what the agent sees, which tools it has, and how it chooses channels, templates, and calls. Read it before you change the instructions or the call rules.

## Two agents, one conversation

| Agent | Model | Runs | Source |
| --- | --- | --- | --- |
| Text agent | OpenAI Responses API, for example GPT-6 Luna | Once for each new text, after a call, and when you hand a conversation back | `server/text-agent.ts` |
| Voice agent | OpenAI Realtime API, for example GPT-Realtime-2.1 | For the length of each call it handles | `server/voice-agent.ts` |

Both agents get the whole conversation: texts on every channel, earlier calls with their summaries and transcripts, and events. So a caller doesn't repeat what they texted, and a text after a call follows from the call.

The text agent runs statelessly (`store: false`). OpenAI doesn't keep the conversation between turns.

## What the text agent sees

The prompt has these parts, in this order:

1. **Your business name and your instructions** from Agent settings.
2. **Fixed rules:** reply in the customer's language in one to three short sentences, say it's an AI assistant when asked, never promise what it can't see or do, and answer `NO_REPLY` when nothing needs to be sent.
3. **Your number,** and when to invite a call. See [Calls](#calls).
4. **The handover rules** from Agent settings. See [Handover](#handover).
5. **The contact's local time.**
6. **The campaign's scenario,** when the conversation started with a campaign.
7. **The conversation so far,** oldest first, up to the last 14,000 characters.
8. **The channel facts:** where the customer has written, where they wrote last, and whether WhatsApp's 24-hour window is open. Or, when free text isn't allowed, why not and which templates it may send.
9. **The reason it runs** (see the next table).

## When the text agent runs

| Trigger | The agent is asked to |
| --- | --- |
| A new text from the contact | Reply to the latest message. Several quick texts get one reply. |
| A call it handled ended | Text what it promised during the call, such as a link or a confirmation. Otherwise nothing. |
| A missed call | Send one short text: sorry it missed the call, and how it can help. |
| You hand the conversation back | Reply if the customer is waiting. Otherwise nothing. |
| You dismiss a call request | Tell the customer a call isn't possible now, and keep helping by text. |
| A new text while a person owns the conversation | Write a draft for that person, with no tools. The composer shows it as **Agent draft**. |

The agent does nothing while the agent is off, for a contact who texted STOP, or for a number outside **Only these numbers**.

## Text agent tools

Each tool returns what actually happened, so the reply matches reality.

| Tool | What the app does | What the tool returns |
| --- | --- | --- |
| `choose_channel` | Pins the channel for this turn's message. Refuses a rich channel the customer hasn't written on, and WhatsApp outside its 24-hour window. | `ok`, or why not |
| `record_call_consent` | Marks that the customer asked for a call or agreed to one, with their words. | `ok` |
| `propose_call` | Runs the call checks and the policy. Dials, queues the callback, adds a call request for you, or declines. | `dialing`, `queued`, `waiting_for_approval`, or `declined` with the reason |
| `request_handover` | Adds a request for a person and marks the conversation **Needs you**. | `ok` |
| `send_template` | Sends an approved utility template with its variables. Offered only while free text isn't allowed. | `sent` with the rendered body, or why not |

Every tool call appears under **Agent activity** in the right panel.

## Channels and free text

The app never chooses a sender. For the channel, the agent follows this rule:

| The customer | The agent |
| --- | --- |
| Writes on WhatsApp, and the 24-hour window is open | Chooses WhatsApp. |
| Writes on RCS | Chooses RCS. |
| Anything else | Chooses nothing. Sent's routing picks the channel, and falls back to another one if it must. |

A pinned channel has no fallback: a message pinned to a channel the contact isn't on fails. That's why the agent never pins a rich channel the customer hasn't written on.

Sent delivers free-form text only inside these windows (`lib/channels.ts`):

| Channel | Free text is allowed |
| --- | --- |
| Sent's routing, SMS, RCS | Once the contact has replied on any channel, or within 7 days of a template |
| WhatsApp, chosen | Within 24 hours of the contact's last WhatsApp message |

Outside a window, the agent may send only an approved utility template whose name fits the situation, or nothing. It never sends marketing or one-time-code templates. A person can send any approved template from the composer.

## Calls

### Inviting a call

The agent knows your Sent number. When talking would help, it invites a call in both directions: the customer can call your number anytime, or reply yes and the agent calls them. A call is likely to help when the campaign's goal mentions one, when the question needs back-and-forth, or when the customer seems unsure.

### When the agent may call

When the customer asks for a call or agrees to one, the agent records their consent, then asks to call. The app runs four checks (`lib/policy.ts`):

1. The customer asked for a call or agreed to one.
2. It is within calling hours in the customer's time zone.
3. The outbound call policy allows calls.
4. No other call is in progress. The phone tab is one phone line.

Then the policy decides:

| Policy | What happens |
| --- | --- |
| **Call on its own** (default) | The agent dials. If only the line is busy, it queues the callback and tells the customer it will call in a few minutes. |
| **Ask me first** | The conversation shows a call request. You click **Let the agent call**, **I'll call**, or **Dismiss**. |
| **Never call** | The agent stays in text and offers a person. |

If a check fails, the agent stays in text and says why, for example "I can call you from 09:00 your time."

You can call from your browser too, under the same checks except the policy, which is for the agent only.

## Handover

The agent asks for a person when:

- the customer asks for a person (on by default),
- the customer is upset or frustrated (on by default),
- the customer wants a refund or a credit above your limit ($20 by default), or
- the customer needs a decision or an action the agent can't take.

The conversation then shows a request with the reason and moves to **Needs you**. Click **Take over** to reply yourself, or **Let the agent continue**. On a call, the agent records the outcome `needs_person`, which adds the same request.

## The voice agent

The voice agent gets your instructions, voice rules, the call's purpose, the campaign's scenario if any, and the last 8,000 characters of the conversation.

| Situation | How the call starts |
| --- | --- |
| The customer called | The agent greets at once: "Thanks for calling *your business*. I'm the AI assistant. How can I help?" |
| The agent called | The agent lets the customer say "Hello?" first, then says who it is and why it called. If the customer stays silent for 3 seconds, the agent speaks first. |

Voice rules: most replies under 20 words, one question at a time, and no links, codes, or long numbers read aloud. The agent offers to text those instead, and the text agent sends them after the call.

| Tool | What the app does |
| --- | --- |
| `record_outcome` | Saves the outcome and a summary on the call card. The outcomes are `resolved`, `callback_requested`, `not_interested`, `voicemail`, and `needs_person`. |
| `end_call` | Asks the model for a short goodbye, with tools off. When it has played, the phone tab hangs up. If the customer speaks during the goodbye, the call continues. |

The turn-taking values and the audio path are the same as in the outbound sample. See its [Architecture](../../outbound-agent-openai-sent/_docs/architecture.md#the-first-words).

## Campaigns

Each campaign has a scenario: what the agent must achieve with its contacts, in your words. Both agents read it in every reply and on every call with those contacts.

A good scenario names the goal, the next step, and when to stop. For example:

> Ask whether they'd like a quick call about their renewal. If they agree, call them. If they say no, thank them and stop.

The agent acts only when a contact replies, after a call, or when you hand a conversation back. It doesn't send timed follow-ups on its own.

The first message of a campaign is always an approved template. After the contact replies, free text is allowed, and the rules above apply.

## Change the behavior

| To change | Edit |
| --- | --- |
| What the agent knows, its tone, your products | **Instructions** in Agent settings |
| The fixed rules and the tool descriptions for texts | `systemPrompt()`, `TOOLS`, and `TRIGGER_TEXT` in `server/text-agent.ts` |
| The channel guidance | `freeTextText()` in `server/text-agent.ts`, and the `chooseChannel` checks in `server/conversations.ts` |
| Which templates the agent may send | `agentTemplates()` in `server/conversations.ts` |
| The voice rules, the outcomes, and the goodbye | `voicePrompt()`, `VOICE_OUTCOMES`, and `GOODBYE` in `server/voice-agent.ts` |
| The opening lines | `createVoice()` in `server/calls.ts` |
| The call checks | `callChecks()` in `lib/policy.ts` |
