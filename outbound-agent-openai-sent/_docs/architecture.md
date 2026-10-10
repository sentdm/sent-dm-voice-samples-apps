# Architecture

This document describes the parts of the outbound agent and how a call moves through them. For an animated version, open [how-it-works.html](./how-it-works.html).

## Four main ideas

1. **The browser tab is the phone.** The `@sentdm/voice` SDK registers the tab as a Sent app user. The tab places the call with `connect({ to })`.
2. **The callback decides what rings.** Sent has no REST endpoint that dials a phone. When the tab places a call, Sent asks your number's callback URL what to do. The gateway answers `connectToNumber`, and only for the number that you asked for.
3. **A software microphone.** When the SDK asks for a microphone, the app gives it an audio stream that contains the agent's voice. The app never opens your real microphone.
4. **Two servers, two doors.** The management server is for you only. The gateway is for Sent only. The internet can reach only the gateway, through the tunnel.

## Diagram

```text
                                  THE INTERNET
 ┌────────────┐  phone call   ┌──────────────────┐  callback question  ┌──────────────────┐
 │ Contact's  │◄─────────────►│ Sent             │────────────────────►│ Cloudflare edge  │
 │ phone      │               │ numbers · calls  │◄────────────────────│ quick tunnel     │
 └────────────┘               └──────────────────┘   connectToNumber   └────────┬─────────┘
                                │ ▲      ▲ │ REST (x-api-key)                   │
                 connect({to})  │ │      │ │                                    │
                   · WebRTC     ▼ │      │ ▼                                    │
═══════════════════════════════════════════════════════════════════════════════════════════
                                  YOUR COMPUTER                                 │
 ┌─────────────────────────────────┐        ┌───────────────────────────────────┼────────┐
 │ Browser tab · localhost:3000    │        │ Node.js process · pnpm start      ▼        │
 │                                 │        │  ┌──────────────┐   ┌──────────────────┐   │
 │  @sentdm/voice SDK              │        │  │ cloudflared  │──►│ Gateway          │   │
 │   ▲ software mic  │ contact     │        │  │ child process│   │ 127.0.0.1:random │   │
 │   │               ▼ audio       │        │  └──────────────┘   └──────────────────┘   │
 │  AudioWorklet · 24 kHz PCM16    │  /api  │  ┌────────────────────────┐   pending dial │
 │   ▲               │             │◄──────►│  │ Management server      │   ┌─────────┐  │
 │   │               ▼             │ /bridge│  │ 127.0.0.1:3000         │──►│ OpenAI  │──┼──► OpenAI
 │  ModelBridge (WebSocket)        │◄──────►│  │ dashboard · keys · WS  │   │ adapter │  │   (WSS)
 │                                 │        │  └────────────────────────┘   └─────────┘  │
 │  Dashboard · Call · Hang up     │        │  .sent-agent/  routing backup · outcomes   │
 └─────────────────────────────────┘        └────────────────────────────────────────────┘
```

## Parts

| Part | Runs in | Source | Job |
| --- | --- | --- | --- |
| Dashboard and call client | Browser tab | `client/app.ts`, `public/index.html` | Shows the controls, registers with Sent, places the call, and sends the heartbeat. |
| Number check | Browser and Node.js | `src/phone.ts` | Accepts a number in international format only, and removes spaces and other separators. |
| Audio worklet | Browser audio thread | `public/audio-worklet.js` | Cuts contact audio into 20 ms frames. Plays the agent audio into the software microphone. |
| Sent service worker | Browser | `dist/public/sw.js` (a copy of `@sentdm/voice/sw.js`) | Lets the SDK register the tab. |
| Management server | Node.js, `127.0.0.1:3000` | `src/server.ts` | Serves the dashboard and `/api/*`. Holds the keys. Mints voice tokens. Runs the bridge. Keeps the pending dial. |
| Gateway | Node.js, `127.0.0.1`, random port | `src/server.ts` | Receives the callback question from Sent, checks the signature, and gives the answer. |
| Tunnel | `cloudflared` child process | `src/tunnel.ts` | Gives the gateway a public HTTPS address. |
| Sent client | Node.js | `src/sent.ts` | Calls the Sent REST API. |
| Signature check and dial rules | Node.js | `src/security.ts` | Checks the HMAC signature. Decides "dial" or "reject". |
| OpenAI adapter | Node.js | `src/openai.ts` | Opens one OpenAI voice session for each call. Runs the agent tools. |
| Model list | Node.js | `src/models.ts` | Lists the models that you can select, and their defaults. |
| Data store | Disk, `.sent-agent/` | `src/backup.ts` | Keeps the routing backup and the call outcomes. Uses owner-only file permissions. |

## Server phases

The management server is always in one phase. The dashboard shows the phase in its status line.

| Phase | Meaning |
| --- | --- |
| `offline` | The agent is stopped. Your number has its usual routing. |
| `preparing` | The server checks the model and opens the tunnel. Your number has its usual routing. |
| `prepared` | The tunnel is ready. The browser registers with Sent. Your number has its usual routing. |
| `activating` | The server saves the routing backup and changes the callback URL of your number. |
| `ready` | The agent can place calls. Sent asks the app about each call on your number. |
| `stopping` | The server ends any call, restores the routing, and closes the tunnel. |

## What "Start agent" does

The order of these steps is important. The app changes your Sent number only after all other parts work.

1. **Browser audio.** In the same click, the page creates a 24 kHz `AudioContext`, loads the worklet, and asks for notification permission. Browsers start audio only during a user action.
2. **Software microphone.** The page replaces `navigator.mediaDevices.getUserMedia`. An audio-only request now gets a copy of the worklet's output stream.
3. **Settings.** The page sends the number, the models, the opening line, and the instructions to `POST /api/settings`.
4. **Model check.** `POST /api/prepare` opens a real session with the selected voice model, then closes it. If your OpenAI project cannot use the model, Start stops here.
5. **Tunnel.** The server starts `cloudflared` and gets a `trycloudflare.com` address. It asks Cloudflare's DNS server (`1.1.1.1`) for the address, then waits until `/health` answers through the tunnel.
6. **Callback path.** The server makes a random path: `/voice/` and 48 hex characters. The callback URL is the tunnel address plus this path.
7. **Registration.** The SDK gets a voice token from `POST /api/voice-token` and registers the tab with Sent.
8. **Heartbeat.** The page starts a heartbeat every 2 seconds. A Web Worker keeps the time, so the heartbeat continues when the tab is in the background.
9. **Backup.** `POST /api/activate` reads the number's callback URL from Sent and writes it to the routing backup. The app writes the backup before it changes anything.
10. **Routing.** The server sends the tunnel callback URL to Sent. Sent returns the number's callback secret. The server adds the secret to the backup.
11. **Test.** The server asks Sent to send a signed test question through the full public path. The gateway must give a valid answer.

## What happens during a call

| # | Step | Where | Time limit |
| --- | --- | --- | --- |
| 1 | You enter a number and click **Call**. The page checks the number and the permission box. | Tab | — |
| 2 | The tab opens the bridge and sends `start` with the number. The server checks the number again and opens an OpenAI session. | Tab ↔ management server | The tab must send `start` in 5 s. The bridge must be ready in 20 s. |
| 3 | When the session is ready, the server sets the pending dial and sends `ready`. | Management server | The pending dial is valid for 20 s. |
| 4 | The tab calls `connect({ to })`. | Tab → Sent | — |
| 5 | Sent sends a signed `call.request` question with `direction: "outbound"` to the callback URL. | Sent → tunnel → gateway | Sent waits 2.5 s for each attempt, and tries 2 times. |
| 6 | The gateway checks the signature and the dial rules. It answers `connectToNumber` and clears the pending dial. | Gateway | Answers from memory, with no network calls. |
| 7 | Sent dials the number. The contact's phone rings and shows your number. | Sent → phone | The phone rings for up to 30 s. From **Call** to the answer, the app allows 75 s. |
| 8 | The contact answers. The tab checks the software microphone, turns on the capture, and sends `answered`. | Tab → bridge | — |
| 9 | The agent lets the contact finish their first sentence. If the contact is silent, the agent says the opening line. | Management server → OpenAI | 3 s |
| 10 | Audio flows in both directions. | See [Audio path](#audio-path). | 5 minutes from the answer. |
| 11 | The call ends. The tab closes the bridge. The server closes the OpenAI session. | All | The server waits 4 s for the final usage data. |

The tab dials only after the model is ready. If the tab dialed earlier, the contact could answer and hear silence.

The model session is open while the phone rings. With the Realtime models, a ringing phone costs nothing, because no audio goes to the model. GPT-Live-1 is billed for each second that its session is open.

## Audio path

All call audio is mono PCM16 at 24 kHz.

### Contact to agent

1. The SDK plays the contact's audio into an `<audio>` element. The element is muted at volume 0.
2. The page connects the element's stream to the worklet.
3. The worklet sends nothing until the contact answers. Before the answer, the line can carry ringback tones and carrier messages.
4. After the answer, the worklet cuts the audio into frames of 480 samples (20 ms, 960 bytes).
5. The page sends each frame on the bridge as a binary message. The server also drops frames that arrive before `answered`.
6. The OpenAI adapter sends the frame to OpenAI as base64 (`input_audio_buffer.append`).

### Agent to contact

1. OpenAI sends audio deltas (`response.output_audio.delta`).
2. The adapter decodes them and sends the PCM on the bridge. Before each delta, it sends an `audio-meta` message with the answer's item ID.
3. The worklet puts the PCM in a playback queue.
4. The worklet plays the queue into the software microphone.
5. The SDK sends the software microphone to Sent, and the contact hears the agent.

The worklet input is the contact stream only. The agent output never goes back into the capture. So the agent never hears itself.

### Playback queue limits

| Voice model | Queue limit | Reason |
| --- | --- | --- |
| Realtime models | 120 s | Realtime sends audio about 6 times faster than real time. The queue must hold a full answer. |
| GPT-Live-1 | 5 s | GPT-Live sends audio in real time. |

If the queue becomes full, the app ends the call. It does not drop speech without a message.

### When the contact interrupts

This applies to the Realtime models. GPT-Live-1 manages interruptions itself.

1. The worklet reports how many milliseconds of each answer it played. The page sends the total to the server (`playback`).
2. OpenAI's voice activity detection hears the contact and sends `input_audio_buffer.speech_started`.
3. OpenAI cancels the current answer itself (`interrupt_response: true`).
4. The server tells the page to `clear`. The worklet deletes all audio that it did not play.
5. The server sends `conversation.item.truncate` with the played position. The model's copy of its answer then ends where the contact stopped hearing it.

## The first words

Most people say "Hello?" or who they are when they answer, often with a pause in the middle. If the agent speaks then, the two voices collide. So the agent lets the contact finish first.

| What the contact does | What the agent does |
| --- | --- |
| Speaks within 3 s of the answer | The agent waits until the contact finishes. Their first turn ends only after 900 ms of silence. Then the model answers. The instructions tell it to wait for the greeting, and they contain the opening line. |
| Stays silent for 3 s | The app asks the model to say the opening line. |

When the opening line has played, the app sets the turn silence back to 450 ms with a `session.update`. So later replies stay fast. If the contact cuts off the opening line, the longer silence stays until a reply plays completely.

The instructions alone cannot make the agent wait. OpenAI's voice activity detection starts a reply when the contact is silent for the set time. So the app changes this time, not only the prompt.

| Value | Source |
| --- | --- |
| Wait before the opening line (silent pickup) | `DEFAULT_OPENING_WAIT_MS` in `src/openai.ts` |
| Silence that ends the first turn | `FIRST_TURN_SILENCE_MS` in `src/openai.ts` |
| Silence that ends later turns | `TURN_SILENCE_MS` in `src/openai.ts` |

Real phone networks add delay, so check these values on your own calls. If the agent still interrupts long introductions, OpenAI's `semantic_vad` decides from the words, not from silence, when a turn ends. It changes the reply speed for the whole call, so test it first.

## Dial rules

`decideOutbound()` in `src/security.ts` answers each callback question. Sent asks about every call on your number in both directions, so this function decides what can ring. The gateway answers `connectToNumber` only when all of these are true:

1. The question is a valid `call.request` for the selected number.
2. `direction` is `outbound`, and `from` is this tab's identity.
3. `to` is a phone number.
4. A pending dial exists. It exists only while the agent is `ready`, the tab is alive and registered, and you clicked **Call** less than 20 s ago.
5. `to` is the same number as the pending dial.

The gateway then clears the pending dial, so one click places one call. A retry of the same question gets the cached answer. All other questions get `reject` with the reason `declined`. This includes inbound calls to your number and calls from other app users of your account.

Sent's test question is the one exception. It has `test: true`, and Sent places no call for it. The gateway answers it with `connectToNumber` to the test's number, so that Sent can check the full answer.

## Agent tools

The Realtime models have two tools. GPT-Live-1 does not get them in this app.

| Tool | What the app does |
| --- | --- |
| `record_outcome` | Adds the outcome, a summary, and a callback time to `.sent-agent/call-outcomes.jsonl`. Shows an `outcome` line in the event log. Tells the model `saved: true` or `saved: false`. Refuses outcomes that are not in the list. |
| `end_call` | Asks the model for a short goodbye, with tools off. When the goodbye is complete, the tab waits until all audio has played, then hangs up. If the contact speaks during the goodbye, the call continues. |

The outcomes are `interested`, `callback_requested`, `not_interested`, `do_not_call`, `wrong_number`, and `voicemail`.

Each line in `call-outcomes.jsonl` looks like this:

```json
{"time":"2026-10-10T12:03:41.000Z","from":"+16285550199","to":"+14155550123","outcome":"callback_requested","summary":"Busy now; asked for a call tomorrow.","callbackTime":"tomorrow at 10"}
```

The app also ends a call after 60 seconds with no contact speech and no agent audio. The time starts when the contact answers.

## Timers and limits

| What | Value | Source |
| --- | --- | --- |
| Heartbeat from the tab | Every 2 s | `client/app.ts` |
| The tab is "alive" if the last heartbeat is newer than | 7 s | `src/server.ts` |
| Watchdog check | Every 2 s | `src/server.ts` |
| Callback signature time tolerance | ±5 min | `src/security.ts` |
| Callback body limit | 64 KB | `src/server.ts` |
| Callback answer cache | 15 s, up to 300 answers | `src/server.ts` |
| Pending dial | 20 s, one call | `src/server.ts` |
| Ring time that Sent allows (`dialTimeoutSeconds`) | 30 s | `src/security.ts` |
| From **Call** to the answer | 75 s | `src/server.ts` |
| Time for the tab to send `start` on a new bridge | 5 s | `src/server.ts` |
| Time for the bridge to become ready | 20 s | `client/app.ts` |
| Wait for the contact before the opening line | 3 s | `src/openai.ts` |
| Silence that ends the contact's first turn | 900 ms | `src/openai.ts` |
| Silence that ends later turns | 450 ms | `src/openai.ts` |
| Maximum call length, from the answer | 5 min | `src/server.ts` |
| Silence limit | 60 s | `src/openai.ts` |
| WebSocket send buffer before the app closes it | 128 KB | `src/server.ts`, `src/openai.ts` |
| Largest audio frame from the tab | 24 KB | `src/server.ts` |
| Voice token lifetime | 600 s | `src/sent.ts` |
| Sent REST request timeout | 15 s | `src/sent.ts` |
| OpenAI key check timeout | 12 s | `src/openai.ts` |
| OpenAI session start timeout | 15 s | `src/openai.ts` |
| OpenAI session close timeout | 4 s | `src/openai.ts` |
| GPT-Live helper request timeout | 15 s | `src/openai.ts` |
| Tunnel connect timeout | 35 s | `src/tunnel.ts` |
| Tunnel public reachability timeout | 45 s | `src/tunnel.ts` |
| Shutdown after **Ctrl+C** | 20 s | `src/server.ts` |
| Events kept by the server | 150 | `src/server.ts` |
| Lines kept in the dashboard event log | 80 | `client/app.ts` |

## Security model

### Two servers

| Server | Who can reach it | Routes | Checks |
| --- | --- | --- | --- |
| Management server | Your computer only (`127.0.0.1`) | `/`, `/api/*`, `/bridge` | `Host` must be `localhost` or `127.0.0.1`. `Origin` must match. Each `POST` and the WebSocket need the CSRF token from `/api/state`. |
| Gateway | Sent, through the tunnel | `GET /health`, `POST /voice/<random path>` | HMAC signature with the number's secret. Timestamp within 5 minutes. All other paths get `404`. |

### Who can make the app dial

A call to a phone costs money. Three checks stand between the internet and your balance:

1. Only the dashboard can create a pending dial. It needs the CSRF token, the permission box, and a number in international format.
2. Only Sent can ask the gateway. Each question needs the HMAC signature.
3. The gateway dials only the pending number, for this tab's identity, once, within 20 s.

So a stolen voice token cannot dial an unknown number, and another app user of your account cannot use your pending dial.

### Where each secret is

| Secret | Where | How long |
| --- | --- | --- |
| Sent API key | Server memory | Until the server stops |
| OpenAI API key | Server memory | Until the server stops |
| Voice token | Browser (SDK memory) | 600 s, then the SDK gets a new one |
| CSRF token | Server memory and the dashboard page | Until the server stops |
| Callback secret (`whsec_…`) | Server memory and `routing-backup.json` | Until the app restores the routing |
| Call outcomes | `.sent-agent/call-outcomes.jsonl` | Until you delete the file |
| Transcripts | Server memory (the OpenAI adapter) and the dashboard page | Server: until the call ends. Page: until you reload it. |

The server reads `SENT_DM_API_KEY` and `OPENAI_API_KEY` one time. Then it deletes them from its environment. So the `cloudflared` child process never gets the keys.

Cloudflare sees only the callback question and answer. The call audio goes from the browser to Sent, and from the server to OpenAI.

## Safety nets

| Event | What the app does |
| --- | --- |
| You close the tab, or the computer sleeps | No heartbeat for 7 s. The watchdog stops the agent and restores the routing. |
| You push **Ctrl+C** | The server runs the same stop steps. It waits up to 20 s. |
| The server crashes, or the power fails | The routing backup stays on disk. On the next **Connect keys**, the server restores the routing before it allows a new Start. |
| Someone changes the callback URL in Sent | The app does not overwrite it. It shows a warning and deletes its backup. |
| The SDK registration goes offline | Routing stays. A call in progress continues. The app cannot place calls until the SDK registers again (it tries about every 30 s). |
| Nobody answers | Sent stops the ringing after 30 s. The app ends the attempt after 75 s from **Call** in all cases. |
| You click **Hang up** before the model is ready | The app closes the bridge and does not dial. |
| The SDK does not use the software microphone | The tab ends the call. This prevents room audio from going to the contact. |
| OpenAI sends a request error | The app writes a notice and the call continues. Only errors such as `invalid_api_key` or `insufficient_quota` end the call. |
| The tunnel stops | The server stops the agent and restores the routing. |

## Where to change things

| To change | Edit |
| --- | --- |
| The default opening line and instructions | `src/server.ts`. The dashboard loads them from the server. |
| The dial rules | `decideOutbound()` in `src/security.ts` |
| The number format check | `toE164()` in `src/phone.ts` |
| The ring time | `DIAL_TIMEOUT_SECONDS` in `src/security.ts` and `DIAL_SETUP_MS` in `src/server.ts` |
| The call limit | `MAX_CALL_MS` in `src/server.ts` |
| The wait before the opening line, and the first-turn silence | `DEFAULT_OPENING_WAIT_MS` and `FIRST_TURN_SILENCE_MS` in `src/openai.ts` |
| The agent tools, the outcomes, and the goodbye prompt | `TOOLS`, `OUTCOMES`, and `GOODBYE` in `src/openai.ts` |
| Voice activity detection settings | `turn_detection` in `src/openai.ts` |
| The agent voice | `voice: 'marin'` in `src/openai.ts` |
| The models that you can select | `src/models.ts`, `public/index.html`, and the checks in `src/server.ts` |
| The SDK log level | `setupVoiceClient()` in `client/app.ts` |
| The playback queue limits | `PLAYBACK_LIMIT_MS` in `client/app.ts` |

After you change files in `client/`, `public/`, or `src/phone.ts`, run `pnpm run build`.
