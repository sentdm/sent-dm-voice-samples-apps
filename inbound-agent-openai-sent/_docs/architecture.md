# Architecture

This document describes the parts of the inbound agent and how a call moves through them. For an animated version, open [how-it-works.html](./how-it-works.html).

## Three main ideas

1. **The browser tab is the phone.** The `@sentdm/voice` SDK registers the tab as a Sent app user. Sent sends the call to that user, so the call rings in the tab.
2. **A software microphone.** When the SDK asks for a microphone, the app gives it an audio stream that contains the agent's voice. The app never opens your real microphone.
3. **Two servers, two doors.** The management server is for you only. The gateway is for Sent only. The internet can reach only the gateway, through the tunnel.

## Diagram

```text
                                  THE INTERNET
 ┌────────────┐  phone call   ┌──────────────────┐  callback question  ┌──────────────────┐
 │ Caller's   │◄─────────────►│ Sent             │────────────────────►│ Cloudflare edge  │
 │ phone      │               │ numbers · calls  │◄────────────────────│ quick tunnel     │
 └────────────┘               └──────────────────┘   connectToUser     └────────┬─────────┘
                                │ ▲      ▲ │ REST (x-api-key)                   │
                push · WebRTC   │ │      │ │                                    │
                         media  ▼ │      │ ▼                                    │
═══════════════════════════════════════════════════════════════════════════════════════════
                                  YOUR COMPUTER                                 │
 ┌─────────────────────────────────┐        ┌───────────────────────────────────┼────────┐
 │ Browser tab · localhost:3000    │        │ Node.js process · pnpm start      ▼        │
 │                                 │        │  ┌──────────────┐   ┌──────────────────┐   │
 │  @sentdm/voice SDK              │        │  │ cloudflared  │──►│ Gateway          │   │
 │   ▲ software mic  │ caller audio│        │  │ child process│   │ 127.0.0.1:random │   │
 │   │               ▼             │        │  └──────────────┘   └──────────────────┘   │
 │  AudioWorklet · 24 kHz PCM16    │  /api  │  ┌────────────────────────┐                │
 │   ▲               │             │◄──────►│  │ Management server      │   ┌─────────┐  │
 │   │               ▼             │ /bridge│  │ 127.0.0.1:3000         │──►│ OpenAI  │──┼──► OpenAI
 │  ModelBridge (WebSocket)        │◄──────►│  │ dashboard · keys · WS  │   │ adapter │  │   (WSS)
 │                                 │        │  └────────────────────────┘   └─────────┘  │
 │  Dashboard                      │        │  .sent-agent/  routing backup · messages   │
 └─────────────────────────────────┘        └────────────────────────────────────────────┘
```

## Parts

| Part | Runs in | Source | Job |
| --- | --- | --- | --- |
| Dashboard and call client | Browser tab | `client/app.ts`, `public/index.html` | Shows the controls, registers with Sent, answers the call, and sends the heartbeat. |
| Audio worklet | Browser audio thread | `public/audio-worklet.js` | Cuts caller audio into 20 ms frames. Plays the agent audio into the software microphone. |
| Sent service worker | Browser | `dist/public/sw.js` (a copy of `@sentdm/voice/sw.js`) | Receives the push message for an incoming call and passes it to the tab. |
| Management server | Node.js, `127.0.0.1:3000` | `src/server.ts` | Serves the dashboard and `/api/*`. Holds the keys. Mints voice tokens. Runs the bridge. |
| Gateway | Node.js, `127.0.0.1`, random port | `src/server.ts` | Receives the callback question from Sent, checks the signature, and gives the answer. |
| Tunnel | `cloudflared` child process | `src/tunnel.ts` | Gives the gateway a public HTTPS address. |
| Sent client | Node.js | `src/sent.ts` | Calls the Sent REST API. |
| Signature check and call decision | Node.js | `src/security.ts` | Checks the HMAC signature. Decides "connect" or "reject". |
| OpenAI adapter | Node.js | `src/openai.ts` | Opens one OpenAI voice session for each call. Runs the agent tools. |
| Model list | Node.js | `src/models.ts` | Lists the models that you can select, and their defaults. |
| Data store | Disk, `.sent-agent/` | `src/backup.ts` | Keeps the routing backup and the caller messages. Uses owner-only file permissions. |

## Server phases

The management server is always in one phase. The dashboard shows the phase in its status line.

| Phase | Meaning |
| --- | --- |
| `offline` | The agent is stopped. Your number has its usual routing. |
| `preparing` | The server checks the model and opens the tunnel. Your number has its usual routing. |
| `prepared` | The tunnel is ready. The browser registers with Sent. Your number has its usual routing. |
| `activating` | The server saves the routing backup and changes the callback URL of your number. |
| `answering` | Sent sends calls on your number to this app. |
| `stopping` | The server ends any call, restores the routing, and closes the tunnel. |

## What "Start answering" does

The order of these steps is important. The app changes your Sent number only after all other parts work.

1. **Browser audio.** In the same click, the page creates a 24 kHz `AudioContext`, loads the worklet, and asks for notification permission. Browsers start audio only during a user action.
2. **Software microphone.** The page replaces `navigator.mediaDevices.getUserMedia`. An audio-only request now gets a copy of the worklet's output stream.
3. **Settings.** The page sends the number, the models, the greeting, and the instructions to `POST /api/settings`.
4. **Model check.** `POST /api/prepare` opens a real session with the selected voice model, then closes it. If your OpenAI project cannot use the model, Start stops here.
5. **Tunnel.** The server starts `cloudflared` and gets a `trycloudflare.com` address. It asks Cloudflare's DNS server (`1.1.1.1`) for the address, then waits until `/health` answers through the tunnel.
6. **Callback path.** The server makes a random path: `/voice/` and 48 hex characters. The callback URL is the tunnel address plus this path.
7. **Registration.** The SDK gets a voice token from `POST /api/voice-token` and registers the tab with Sent.
8. **Heartbeat.** The page starts a heartbeat every 2 seconds. A Web Worker keeps the time, so the heartbeat continues when the tab is in the background.
9. **Backup.** `POST /api/activate` reads the number's callback URL from Sent and writes it to the routing backup. The app writes the backup before it changes anything.
10. **Routing.** The server sends the tunnel callback URL to Sent. Sent returns the number's callback secret. The server adds the secret to the backup.
11. **Test.** The server asks Sent to send a signed test question through the full public path. The gateway must answer it correctly.

## What happens during a call

| # | Step | Where | Time limit |
| --- | --- | --- | --- |
| 1 | The caller dials your Sent number. | Phone, Sent | — |
| 2 | Sent sends a signed `call.request` question to the callback URL. | Sent → tunnel → gateway | Sent waits 2.5 s for each attempt, and tries 2 times. |
| 3 | The gateway checks the signature, then answers `connectToUser` or `reject`. | Gateway | Answers from memory, with no network calls. |
| 4 | On "connect", the server holds the agent for this call and opens an OpenAI session in advance ("pre-warm"). | Management server | The hold lasts 20 s. An unused pre-warmed session closes after 25 s. |
| 5 | Sent sends the call to the identity by browser push. The SDK shows an incoming call. | Sent → service worker → tab | — |
| 6 | The tab opens the bridge and sends `start`. The server gives the pre-warmed session to the call. | Tab ↔ management server | The bridge must be ready in 20 s. If not, the tab rejects the call. |
| 7 | The tab turns on caller capture and accepts the call. | Tab, SDK | — |
| 8 | When the call connects, the tab checks the software microphone, then asks the agent to say the greeting. | Tab → bridge → OpenAI | — |
| 9 | Audio flows in both directions. | See [Audio path](#audio-path). | 15 minutes for each call. |
| 10 | The call ends. The tab closes the bridge. The server closes the OpenAI session. | All | The server waits 4 s for the final usage data. |

The tab accepts the call only after the model is ready. If the tab accepted earlier, the caller could hear silence.

The pre-warm in step 4 saves time. The OpenAI session starts while Sent delivers the push to the browser. If the pre-warm fails, the server opens a new session when the bridge starts.

## Audio path

All call audio is mono PCM16 at 24 kHz.

### Caller to agent

1. The SDK plays the caller audio into an `<audio>` element. The element is muted at volume 0.
2. The page connects the element's stream to the worklet.
3. The worklet cuts the audio into frames of 480 samples (20 ms, 960 bytes).
4. The page sends each frame on the bridge as a binary message.
5. The OpenAI adapter sends the frame to OpenAI as base64 (`input_audio_buffer.append`).

### Agent to caller

1. OpenAI sends audio deltas (`response.output_audio.delta`).
2. The adapter decodes them and sends the PCM on the bridge. Before each delta, it sends an `audio-meta` message with the answer's item ID.
3. The worklet puts the PCM in a playback queue.
4. The worklet plays the queue into the software microphone.
5. The SDK sends the software microphone to Sent, and the caller hears the agent.

The worklet input is the caller stream only. The agent output never goes back into the capture. So the agent never hears itself.

### Playback queue limits

| Voice model | Queue limit | Reason |
| --- | --- | --- |
| Realtime models | 120 s | Realtime sends audio about 6 times faster than real time. The queue must hold a full answer. |
| GPT-Live-1 | 5 s | GPT-Live sends audio in real time. |

If the queue becomes full, the app ends the call. It does not drop speech without a message.

### When the caller interrupts

This applies to the Realtime models. GPT-Live-1 manages interruptions itself.

1. The worklet reports how many milliseconds of each answer it played. The page sends the total to the server (`playback`).
2. OpenAI's voice activity detection hears the caller and sends `input_audio_buffer.speech_started`.
3. OpenAI cancels the current answer itself (`interrupt_response: true`).
4. The server tells the page to `clear`. The worklet deletes all audio that it did not play.
5. The server sends `conversation.item.truncate` with the played position. The model's copy of its answer then ends where the caller stopped hearing it.

## Agent tools

The Realtime models have two tools. GPT-Live-1 does not get them in this app.

| Tool | What the app does |
| --- | --- |
| `take_message` | Adds the caller's name, callback number, and message to `.sent-agent/messages.jsonl`. Shows a `message` line in the event log. Tells the model `saved: true` or `saved: false`, so the model cannot say that it saved a message when it did not. |
| `end_call` | Asks the model for a short goodbye, with tools off. When the goodbye is complete, the tab waits until all audio has played, then hangs up. If the caller speaks during the goodbye, the call continues. |

The app asks for the goodbye itself. In live tests, the model skipped or described the goodbye in 4 of 5 calls when it had to do it alone.

The app also ends a call after 60 seconds with no caller speech and no agent audio. The time starts when the greeting starts.

## Timers and limits

| What | Value | Source |
| --- | --- | --- |
| Heartbeat from the tab | Every 2 s | `client/app.ts` |
| The tab is "alive" if the last heartbeat is newer than | 7 s | `src/server.ts` |
| Watchdog check | Every 2 s | `src/server.ts` |
| Callback signature time tolerance | ±5 min | `src/security.ts` |
| Callback body limit | 64 KB | `src/server.ts` |
| Callback answer cache | 15 s, up to 300 answers | `src/server.ts` |
| Hold after `connectToUser` | 20 s | `src/server.ts` |
| Pre-warmed session lifetime | 25 s | `src/server.ts` |
| Time for the tab to send `start` on a new bridge | 5 s | `src/server.ts` |
| Time for the bridge to become ready | 20 s | `client/app.ts` |
| Maximum call length | 15 min | `src/server.ts` |
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

### Where each secret is

| Secret | Where | How long |
| --- | --- | --- |
| Sent API key | Server memory | Until the server stops |
| OpenAI API key | Server memory | Until the server stops |
| Voice token | Browser (SDK memory) | 600 s, then the SDK gets a new one |
| CSRF token | Server memory and the dashboard page | Until the server stops |
| Callback secret (`whsec_…`) | Server memory and `routing-backup.json` | Until the app restores the routing |
| Caller messages | `.sent-agent/messages.jsonl` | Until you delete the file |
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
| The SDK registration goes offline | Routing stays. A call in progress continues. New calls get "busy" until the SDK registers again (it tries about every 30 s). |
| The SDK does not use the software microphone | The tab ends the call. This prevents room audio from going to the caller. |
| OpenAI sends a request error | The app writes a notice and the call continues. Only errors such as `invalid_api_key` or `insufficient_quota` end the call. |
| The tunnel stops | The server stops the agent and restores the routing. |

## Where to change things

| To change | Edit |
| --- | --- |
| The default greeting and instructions | `src/server.ts` and `public/index.html` |
| The agent tools and the goodbye prompt | `TOOLS` and `GOODBYE` in `src/openai.ts` |
| Voice activity detection settings | `turn_detection` in `src/openai.ts` |
| The agent voice | `voice: 'marin'` in `src/openai.ts` |
| The models that you can select | `src/models.ts`, `public/index.html`, and the checks in `src/server.ts` |
| The call decision rules | `decideInbound()` in `src/security.ts` |
| The SDK log level | `setupVoiceClient()` in `client/app.ts` |
| The playback queue limits | `PLAYBACK_LIMIT_MS` in `client/app.ts` |

After you change files in `client/` or `public/`, run `pnpm run build`.
