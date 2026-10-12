# Sent chat + voice agent

A local app where one AI agent runs each customer conversation across **SMS, WhatsApp, RCS, and phone calls** on your Sent number. The agent replies to texts, answers calls, and calls a customer back when talking is faster than texting. A person can listen in, take over a chat or a call, and hand it back.

External credentials: **one Sent API key and one OpenAI API key**. The text agent uses the OpenAI Responses API; calls use GPT-Realtime-2.1 through the same Sent browser voice SDK as the [inbound](../inbound-agent-openai-sent) and [outbound](../outbound-agent-openai-sent) samples.

> This is a local sample for one person. Keep the browser tab that started the agent open and the computer awake. Real calls and messages cost money on both accounts; test on a dedicated number.

## Documentation

The guides for this sample are in [`_docs/`](./_docs/README.md):

- [Setup](./_docs/setup.md): install the app, connect your keys, and run a test text, call, and campaign.
- [Architecture](./_docs/architecture.md): the parts of the app, and how texts, calls, and campaigns move through them.
- [The agent](./_docs/agent.md): what the agent sees, its tools, and how it chooses channels, templates, and calls.
- [Models](./_docs/models.md): the model choices, the defaults, and how to add a model.
- [Sent API and logs](./_docs/sent-api-and-logs.md): the Sent API calls the app makes, how to find a message or a call, and troubleshooting.

## Run it

Install **Node.js 22 or newer** and [pnpm](https://pnpm.io/installation). Then, in this folder:

```sh
pnpm install
pnpm dev
```

Open **http://localhost:3000** in a current Chrome or Edge browser.

1. Click **Connect Sent** and enter your keys, or put them in a `.env` file (see `.env.example`). The inbox loads your Sent message history: every number you have texted, one conversation each.
2. Open **Agent settings** (the gear icon). Enter your business name and choose the Sent voice number. If your account has real customers, put your own phone in **Only these numbers** while you test: the webhook gets every inbound text on the account, and the agent would reply to all of them.
3. Click **Start agent** and allow notifications. This tab becomes the phone: calls ring here.

For a production build: `pnpm build`, then `pnpm start`.

### What Start changes in Sent, and what Stop restores

| Start | Stop |
| --- | --- |
| Saves your number's callback URL to `.sent-agent/backup.json`, then points it at this app through a temporary Cloudflare tunnel. | Restores the saved callback URL. |
| Creates a webhook for message events, so replies and delivery reports reach the app. | Deletes the webhook. |

If the app stops unexpectedly, the next **Connect** restores both before anything else. Closing the phone tab stops the agent after a few seconds.

## How the agent works

**Texts.** When a customer texts, the agent reads the whole conversation (texts on every channel, and earlier calls with their summaries) and replies; Sent's routing picks the channel. Several quick texts in a row get one reply. While a person owns the conversation, the agent writes drafts for them instead.

**Calls.** An incoming call rings the phone tab. With **Ring the team first** (the default), the agent answers if no one picks up within 10 seconds. The agent already knows the text conversation when it answers. After a call, it texts anything it promised, such as a link or a confirmation.

**Calling back.** When the agent thinks a call would help, it gives a reason and the signals it noticed. The app then checks four things:

1. The customer asked for a call or agreed to one.
2. It is within calling hours in the customer's time zone.
3. The call policy allows it: **Call on its own** (the default) dials; **Ask me first** shows a suggestion you approve.
4. No other call is in progress. The browser tab is one phone line, so the app handles one call at a time.

If a check fails, the agent stays in text and says why. You can call from your browser too, under the same checks except the policy. The checks are in `lib/policy.ts`, and the right panel shows them for the open conversation.

**Handing over.** The agent brings in a person when the customer asks for one, sounds upset, or needs a refund above your limit. The conversation shows a request with the reason; **Take over** moves it to you.

### Routing, free text, and templates

The app never sets a sender (`channels`): Sent's routing picks the sender that serves the contact's country, using your routing rules. Sent's routing picks the channel too, unless the agent has a reason to choose one, for example the customer asked to continue on WhatsApp. The agent then calls `choose_channel`, and the choice shows in Agent activity. Your messages default to **Sent picks** too; choose SMS, WhatsApp, or RCS in the composer to pin the channel for a message. Each message shows the channel once Sent reports it.

Sent delivers free-form text once the contact has replied on any channel, or within 7 days of a template. (Sent's routing sends free text by WhatsApp only within 24 hours of the contact's last WhatsApp message, and falls back to RCS or SMS otherwise. The agent can't choose WhatsApp outside that window.) Before that, the composer says why and offers your approved Sent templates, with a field for each variable. The agent may send an approved utility template whose name fits, or nothing. Sent doesn't return template bodies, so the app shows the text Sent rendered once the template is sent. The rule is in `lib/channels.ts`.

When a customer texts STOP, Sent blocks further texts and the agent stops replying.

## Campaigns

A campaign sends an approved template to a list of contacts. Then the agent handles their replies and calls by following a scenario you write, for example: "Ask whether they'd like a quick call about their renewal. If they agree, call them. If they say no, thank them and stop."

Start one from **Campaigns** in the top bar: upload or paste a CSV, map each template variable to a column (or give one value for everyone), and write the scenario. The agent must be on: replies and calls reach the app only while it runs. Each contact's conversation is tagged with the campaign's name, so the inbox search finds them.

Your own programs on this computer can start campaigns too. Set `APP_API_TOKEN` in `.env` (for example `openssl rand -hex 24`), restart, then:

```sh
curl -X POST http://localhost:3000/api/campaigns \
  -H "Authorization: Bearer $APP_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Renewals",
    "template": "Renewal reminder",
    "scenario": "Ask whether they would like a quick call about their renewal. If they agree, call them.",
    "recipients": [
      { "phone": "+14155551234", "name": "Ana", "variables": { "name": "Ana" } }
    ]
  }'
```

- `template` is the template's name or id. `channel` is optional: `sms`, `whatsapp`, or `rcs`. Leave it out and Sent's routing picks, with fallback.
- Up to 1,000 recipients. Numbers need + and the country code. A row with a bad number, a duplicate, a missing variable, or a number outside **Only these numbers** is skipped, with the reason.
- `GET /api/campaigns` lists campaigns with their counts. `GET /api/campaigns/{id}` adds each recipient's status. `POST /api/campaigns/{id}/stop` and `/resume` pause and continue sending.
- The token opens only these campaign routes, and only from this computer.

With campaign contacts, as everywhere, the agent:

- **Favors rich channels.** It replies on WhatsApp while the customer writes there inside the 24-hour window, and on RCS when they write on RCS. Otherwise Sent's routing picks and falls back on its own. The agent never pins a channel the customer hasn't used, because a pinned channel has no fallback.
- **Invites calls when talking helps.** Customers can call your number, and the agent or the team answers. Or they reply yes, and the agent calls them.
- **Queues callbacks.** The browser tab is one phone line. While a call is on, the next yes waits in line, the customer hears "we'll call you in a few minutes", and the call starts when the line is free.

## Where things are

| Path | What it holds |
| --- | --- |
| `server/index.ts` | Starts the app: Next.js, the local API, the WebSockets, and the gateway. |
| `server/runtime.ts` | Keys, settings, Start and Stop, and the routing backup. |
| `server/gateway.ts` | The only server the tunnel exposes: Sent's signed voice questions and message webhooks. |
| `server/conversations.ts` | Inbound texts, delivery reports, sending, templates, history import, and the text agent's turns. |
| `server/calls.ts` | Placing and answering calls, the callback queue, and the audio bridge to the voice agent. |
| `server/campaigns.ts`, `components/console/campaigns-sheet.tsx`, `lib/csv.ts` | Campaigns: checking the list, sending the template, and the counts. |
| `server/text-agent.ts`, `server/voice-agent.ts` | The OpenAI prompts and tools for texts and calls. |
| `server/security.ts` | Signature checks, and which calls may ring or dial. |
| `lib/live/phone.ts`, `lib/live/audio.ts` | The phone tab: the Sent voice SDK, the agent's audio, and your microphone when you take over. |
| `lib/policy.ts`, `lib/channels.ts`, `lib/models.ts` | The call checks, the free-text rule, and the model choices. The browser and the server share them. |
| `.sent-agent/` | Local data: conversations, settings, and the routing backup. Owner-only files. Delete the folder to start over. |

## Limits

- One call at a time. A second caller hears busy, and the agent texts them when it can. Queued callbacks are lost if the app restarts.
- Contacts use your time zone until you set theirs in the right panel.
- The voice agent supports the Realtime models only, because it needs its tools on every call.
- Calls that a person takes have no transcript.

## Tests

```sh
pnpm test     # signatures, call rules, free-text windows, webhooks, the text agent's tool loop
pnpm check    # types and lint
```
