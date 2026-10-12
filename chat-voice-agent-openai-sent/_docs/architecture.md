# Architecture

This document describes the parts of the chat + voice agent, and how texts, calls, and campaigns move through them.

## Main ideas

1. **One conversation per contact.** Texts on every channel and calls with the same person form one thread. Sent groups its conversations the same way.
2. **The browser tab is the phone.** The phone tab registers with Sent as an app user. Calls ring there. For agent calls, the tab gives the Sent voice SDK a software microphone that carries the agent's voice. The inbound and outbound samples work the same way.
3. **Sent routes every message.** The app never chooses a sender. It chooses a channel only when the agent or a person has a reason. Otherwise Sent's routing picks the channel and falls back on its own.
4. **The agent asks before it does something costly or risky.** A call needs the contact's consent and four checks. A refund above your limit, or a decision the agent can't make, goes to a person.
5. **Two servers, two doors.** The management server is for you only. The gateway is for Sent only. The internet reaches only the gateway, through the tunnel.

## Diagram

```text
THE INTERNET
  Contact's phone ◄──── texts and calls ────► Sent
  Sent ──── signed voice questions and message webhooks ────► Cloudflare quick tunnel ──► Gateway
  Node.js process ──── REST, through the official SDK (@sentdm/sentdm) ────► Sent
  Phone tab ◄──── call media (WebRTC) and incoming-call push ────► Sent

YOUR COMPUTER
  Node.js process (pnpm dev)
  ├── Gateway             127.0.0.1, random port    ◄── the tunnel only
  ├── Management server   127.0.0.1:3000            ◄── the console: /api, /ws, /bridge
  ├── Text agent          ──► OpenAI Responses API
  ├── Voice agent         ──► OpenAI Realtime API, one session for each agent call
  └── .sent-agent/        conversations, settings, campaigns, routing backup

  Phone tab (Chrome or Edge, http://localhost:3000)
  ├── Console             Next.js and React, updated from /ws
  ├── Sent voice SDK      registers as the identity, places and answers calls
  └── Audio engine        software microphone for the agent; your microphone when you take over
```

## Parts

| Part | Runs in | Source | Job |
| --- | --- | --- | --- |
| Console | Browser | `components/console/`, `lib/live/live-store.tsx` | Shows the conversations from the server's snapshots. Sends your actions to `/api`. |
| Phone engine | Phone tab | `lib/live/phone.ts` | Registers with Sent, places and answers calls, streams agent calls on `/bridge`, and runs the heartbeat. |
| Audio engine | Phone tab | `lib/live/audio.ts`, `public/audio-worklet.js` | The software microphone, the playback queue, and your microphone when you take over. |
| Boot | Node.js | `server/index.ts` | Starts the gateway and the management server, and routes WebSocket upgrades. |
| Runtime | Node.js | `server/runtime.ts` | Keys, settings, Start and Stop, the routing backup, the phone tab's heartbeat, and the snapshots for the console. |
| Gateway | Node.js | `server/gateway.ts` | Checks the signature on each voice question and webhook, then passes it on. |
| Call rules | Node.js | `server/security.ts` | Signature checks, and which calls may ring or dial. |
| Conversations | Node.js | `server/conversations.ts` | Inbound texts, delivery reports, sending, templates, the history import, and the text agent's turns. |
| Calls | Node.js | `server/calls.ts` | Placing and answering calls, the callback queue, and the audio bridge to the voice agent. |
| Campaigns | Node.js | `server/campaigns.ts` | Checking a contact list, sending the template, and the counts. |
| Text agent | Node.js | `server/text-agent.ts` | The prompt and tools for texts. See [The agent](./agent.md). |
| Voice agent | Node.js | `server/voice-agent.ts` | The Realtime session, the prompt, and the tools for calls. |
| Sent client | Node.js | `server/sent.ts` | Every Sent API call, through the official SDK. See [Sent API and logs](./sent-api-and-logs.md). |
| Shared rules | Browser and Node.js | `lib/policy.ts`, `lib/channels.ts`, `lib/models.ts` | The call checks, the free-text rule, and the model choices. |
| Data store | Disk | `server/store.ts` | Owner-only JSON files in `.sent-agent/`, written atomically. |

## Start and Stop

The order matters: the app changes your Sent number only after every other part works.

### What Start does

1. **Browser audio.** In the click, the phone tab creates a 24 kHz `AudioContext`, loads the audio worklet, and asks for notification permission. Browsers start audio only during a user action.
2. **Prepare** (`POST /api/start/prepare`). The server restores any routing that an earlier run left behind, then:
   1. loads your approved templates,
   2. opens a real session with the voice model, then closes it,
   3. opens the tunnel, and
   4. makes two random paths: `/voice/` and `/hooks/`, each followed by 48 hex characters.
3. **Registration.** The phone tab gets a voice token (`POST /api/voice-token`, valid for 600 s) and registers with Sent.
4. **Heartbeat.** The phone tab posts a heartbeat every 2 seconds. A Web Worker keeps the time, so the heartbeat continues in a background tab.
5. **Activate** (`POST /api/start/activate`):
   1. The server reads your number's callback URL and writes it to the routing backup.
   2. It points the number's callback URL at the tunnel's voice path. Sent returns the callback secret. The server adds it to the backup.
   3. It creates a webhook at the tunnel's hooks path, for message events and call failures. Sent returns the webhook's signing secret. The server adds the webhook to the backup.
   4. It asks Sent to send a signed test question through the public path.

If a step fails, the server restores what it changed and closes the tunnel.

### What Stop does

1. Ends a call in progress and clears the callback queue.
2. Deletes the webhook.
3. Restores the callback URL, if no one changed it in Sent meanwhile.
4. Closes the tunnel and deletes the routing backup.

**Ctrl+C** runs the same steps. If the server stops without them, the backup stays on disk, and the next **Connect** runs them first.

## A text from a contact

1. Sent posts `message.received` to the hooks path. The gateway checks the signature and answers `200` at once: Sent counts a slow answer as a failure.
2. The app drops a repeated event (same `x-webhook-event-id`) or a repeated message (same message id).
3. It finds or creates the conversation for the contact's number and adds the message. The channel joins the contact's channels. A resolved conversation opens again.
4. `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, or `QUIT` marks the contact as opted out, and the agent stops. `START` or `UNSTOP` reverses it.
5. The app waits 1.5 seconds for more texts, so several quick texts get one reply.
6. If the agent owns the conversation, the text agent runs. If a person owns it, the text agent writes a draft for them. See [The agent](./agent.md).

## A text from the app

1. The app checks that Sent would deliver free-form text, for the chosen channel or for Sent's routing (`lib/channels.ts`). If not, the agent or the person must send a template.
2. It posts `POST /v3/messages` with the number and the text, and an `Idempotency-Key`. It adds `channel` only when someone chose one. It never sends `channels` (a sender).
3. The message shows **Sending**, and **Sent routing** until Sent reports the channel.
4. Status webhooks move it forward: **Sent**, **Delivered**, **Read**. `FAILED`, `BLOCKED`, or `FILTERED` shows **Not delivered** with Sent's reason under the message.

A template follows the same path, with `template` in place of `text`. Sent's response and status events carry the rendered body, so the thread shows the exact text.

## An incoming call

1. Sent posts a `call.request` question with `direction: "inbound"` to the voice path.
2. The gateway checks the signature. It answers `connectToUser` with the phone tab's identity when all three are true:
   - the agent is on and the phone tab is online,
   - no other call is in progress, and
   - the caller is on **Only these numbers**, when that list is set.

   Otherwise it answers `reject` with `busy`.
3. The server adds a ringing call to the caller's conversation. With **Ring the team first**, the agent may answer after the ring time. With **Agent answers**, it answers after 1 second. With **Team only**, it never answers.
4. Sent rings the phone tab. The tab matches the call to the conversation by the caller's number.
5. A person clicks **Answer** in the phone tab, or the agent answers when the ring time ends. For the agent, the tab first opens the bridge and waits for the model session, then accepts.
6. If no one answers within 45 seconds, or the caller hangs up first, the call is missed. The agent texts the caller: in free text if Sent allows it, or with a fitting template.

## A call the agent places

1. The agent wants to call and the checks pass. See [Calls](./agent.md#calls).
2. The server adds the call to the conversation and sends `dial` to the phone tab over `/ws`.
3. The tab opens `/bridge`. The server opens a Realtime session. When it is ready, the server sets the pending dial: the contact's number, valid for 20 seconds.
4. The tab calls the SDK's `connect({ to })`. Sent posts a `call.request` question with `direction: "outbound"`.
5. The gateway answers `connectToNumber` only for the pending number, from the phone tab's identity, before it expires. Then it clears the pending dial. Sent dials, and the phone rings for up to 30 seconds.
6. When the contact answers, the tab sends their audio to the server, and the agent lets them say "Hello?" first. If they stay silent for 3 seconds, the agent speaks first.
7. When the agent says goodbye, the tab hangs up after the last audio plays. The server marks the call as ended, and the text agent texts anything the agent promised.

A call that you place from the browser follows the same path without the model session. The pending dial lasts 60 seconds, because the browser may first ask for your microphone.

The call audio between the tab, the server, and OpenAI works as in the outbound sample. See its [audio path](../../outbound-agent-openai-sent/_docs/architecture.md#audio-path).

### The callback queue

The phone tab is one phone line. When a contact agrees to a call while another call is on the line, the agent queues the callback and tells them it will call in a few minutes. Three seconds after a call ends, the server calls the next contact in the queue whose checks still pass. The queue is in memory: a restart clears it.

## Take over and listen in

| Action | What happens |
| --- | --- |
| **Take over** a text conversation | The agent stops replying. It writes a draft for each new text, which you can use or ignore. |
| **Hand back to agent** | The agent owns the conversation again, and replies if the contact is waiting. |
| **Take over call** | The server tells the bridge to hand over and closes the model session. The phone tab connects your microphone to the call. The call stays up. |
| **Listen** | The phone tab plays the contact's audio. The contact doesn't hear you. |

Only the phone tab can answer or take over a call as a person, because your microphone is there.

## Campaigns

1. The console, or your own program, posts the campaign to `POST /api/campaigns`.
2. The server checks the template, the scenario, and each contact. A row with a bad number, a duplicate, a missing variable, or a number outside **Only these numbers** is skipped, with the reason.
3. Four workers send the template to the contacts, one at a time each. Each contact gets a conversation tagged with the campaign's name.
4. If the agent stops, sending pauses. **Resume** sends to the contacts not handled yet.
5. Replies reach the text agent with the campaign's scenario. See [Campaigns](./agent.md#campaigns).

## Data on disk

All files are in `.sent-agent/`, with owner-only permissions. Delete the folder to start over. The next **Connect** imports your message history again.

| File | Holds |
| --- | --- |
| `conversations.json` | Every conversation: messages, calls with transcripts, events, requests, and the agent's activity. |
| `settings.json` | Agent settings. |
| `campaigns.json` | Campaigns and the status of each contact. |
| `backup.json` | The routing backup, while the agent is on: the old callback URL, the callback secret, and the webhook's id and secret. |

## Two servers and security

| Server | Who can reach it | Routes | Checks |
| --- | --- | --- | --- |
| Management server | Your computer only (`127.0.0.1`) | The console, `/api/*`, `/ws`, `/bridge`, `/sw.js` | The `Host` must be `localhost` or `127.0.0.1`. Each `POST` and each WebSocket needs the same origin and the CSRF token from `GET /api/session`. Campaign routes also accept `Authorization: Bearer <APP_API_TOKEN>`. |
| Gateway | Sent, through the tunnel | `GET /health`, `POST /voice/<random>`, `POST /hooks/<random>` | HMAC signature with the matching secret, and a timestamp within 5 minutes. All other paths get `404`. |

| Secret | Where | How long |
| --- | --- | --- |
| Sent and OpenAI API keys | Server memory | Until the server stops. The server removes them from its environment, so `cloudflared` never gets them. |
| `APP_API_TOKEN` | Server memory | Until the server stops. Removed from the environment the same way. |
| Voice token | Phone tab (SDK memory) | 600 s, then the SDK gets a new one. |
| CSRF token | Server memory and the console | Until the server stops. |
| Callback and webhook secrets | Server memory and `backup.json` | Until Stop. |

Cloudflare sees only the voice questions, the answers, and the webhooks. Call audio goes from the phone tab to Sent, and from the server to OpenAI.

## Timers and limits

| What | Value | Source |
| --- | --- | --- |
| Heartbeat from the phone tab | Every 2 s | `lib/live/phone.ts` |
| The phone tab is alive if its last heartbeat is newer than | 7 s | `server/runtime.ts` |
| Wait for more texts before the agent replies | 1.5 s | `server/conversations.ts` |
| Text agent: tool rounds, output tokens, reply length | 4, 800, 1,500 characters | `server/text-agent.ts` |
| Text agent: conversation text sent to the model | Last 14,000 characters | `server/text-agent.ts` |
| Voice agent: conversation text sent to the model | Last 8,000 characters | `server/voice-agent.ts` |
| Agent waits for the contact before it speaks (outbound) | 3 s | `server/voice-agent.ts` |
| Silence that ends the contact's first turn, later turns | 900 ms, 450 ms | `server/voice-agent.ts` |
| Silence limit on a call | 60 s | `server/voice-agent.ts` |
| Pending dial: agent, person | 20 s, 60 s | `server/calls.ts` |
| Ring time that Sent allows | 30 s | `server/security.ts` |
| From the dial request to the answer | 75 s | `server/calls.ts` |
| An inbound call is missed after | 45 s | `server/calls.ts` |
| Maximum call length, from the answer | 10 minutes | `server/calls.ts` |
| Next queued callback after a call ends | 3 s | `server/calls.ts` |
| Voice token lifetime | 600 s | `server/sent.ts` |
| Sent request timeout | 15 s | `server/sent.ts` |
| Callback answer cache | 15 s, up to 300 answers | `server/gateway.ts` |
| Body limits: voice question, webhook, API, campaign | 64 KB, 256 KB, 32 KB, 1 MB | `server/gateway.ts`, `server/api.ts` |
| Campaign contacts, workers | 1,000, 4 | `server/campaigns.ts` |
| History import | Newest 1,000 messages | `server/index.ts`, `server/conversations.ts` |
| Shutdown after **Ctrl+C** | 20 s | `server/index.ts` |

## Safety nets

| Event | What the app does |
| --- | --- |
| The phone tab closes, or the computer sleeps | No heartbeat for 7 s. The agent stops, and your number's routing goes back. |
| The server crashes | The routing backup stays on disk. The next **Connect** restores the number and deletes the webhook first. |
| Someone changes the callback URL in Sent | The app doesn't overwrite it, and shows a warning. |
| Free text isn't allowed | The app doesn't send it. The composer offers a template. The agent sends a fitting template, or nothing. |
| A contact texts STOP | The agent stops replying, and the composer explains why. |
| A second call comes in | The caller hears busy. The agent texts them when it can. |
| The agent's model session ends during a call | The phone tab hangs up, unless a person took over. |
| The SDK doesn't use the software microphone | The phone tab ends the call, so no room audio reaches the contact. |
| Sent reports `call.failed` | The call card shows Sent's reason in plain words. |

## Where to change things

| To change | Edit |
| --- | --- |
| The defaults for new installs | `DEFAULT_SETTINGS` in `server/store.ts` |
| What the agent knows and how it sounds | **Instructions** in Agent settings, or the default in `server/store.ts` |
| The agent's rules and tools for texts | `systemPrompt()` and `TOOLS` in `server/text-agent.ts` |
| The agent's rules and tools on calls | `voicePrompt()` and `TOOLS` in `server/voice-agent.ts` |
| The call checks | `callChecks()` in `lib/policy.ts` |
| The free-text rule | `freeTextBlocked()` in `lib/channels.ts` |
| Which calls may ring or dial | `answerCallQuestion()` in `server/security.ts` |
| The models you can choose | `lib/models.ts` |
| The opt-out keywords | `STOP_WORDS` and `START_WORDS` in `server/conversations.ts` |
| The timers | The constants named in [Timers and limits](#timers-and-limits) |
