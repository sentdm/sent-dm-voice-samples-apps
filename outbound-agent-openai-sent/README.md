# Sent outbound agent

A **downloadable local TypeScript app** that places calls from an existing Sent voice number and lets an OpenAI voice agent talk to the person who answers. External credentials: **one Sent API key and one OpenAI API key**.

Default voice model: **GPT-Realtime-2.1**, with **GPT-Realtime-2.1 Mini** and **GPT-Live-1** options. Realtime input transcription defaults to **GPT-Live-Transcribe**. The optional GPT-Live text helper defaults to **GPT-6 Luna**, with **GPT-5.4 Mini**, **GPT-6 Sol**, and **GPT-6 Astra** options. No SIP trunk or extra provider key is needed. The app uses the published Sent browser voice SDK, a software microphone, and OpenAI's server-side WebSocket API.

> This is a single-call local prototype. Keep the browser tab open and the computer awake. It is not a dialer or a campaign tool. Real phone-call behavior requires validation with your own accounts.

## Documentation

The guides for this sample are in [`_docs/`](./_docs/README.md):

- [Setup](./_docs/setup.md): install the app, connect your keys, and place a test call.
- [Architecture](./_docs/architecture.md): the parts of the app and how a call moves through them.
- [Models](./_docs/models.md): the model choices, the defaults, and the costs.
- [Sent calls and logs](./_docs/sent-calls-and-logs.md): how Sent places a call for the app, and how to find the call in each log.
- [How it works](./_docs/how-it-works.html): an animated walkthrough. Open the file in a browser.

## Run it

Install **Node.js 22 or newer** from [nodejs.org](https://nodejs.org/) and [pnpm](https://pnpm.io/installation) (or run `corepack enable pnpm`; Corepack ships with Node 22–24). Clone this repository, open a terminal in the `outbound-agent-openai-sent` folder, then run:

```sh
pnpm install --frozen-lockfile --prod
pnpm start
```

The repository includes the compiled server and browser assets in `dist/`; no build is needed to run it. Open **http://localhost:3000** in a current Chrome or Edge browser.

Alternatively, run `sh start.sh` on macOS/Linux or double-click `start.cmd` on Windows. The launchers use pnpm, or Corepack's pnpm if pnpm isn't installed, install dependencies on first run, then start the same localhost app.

For source changes:

```sh
pnpm install
pnpm run build
pnpm start      # or `pnpm dev` to run src/ directly with tsx
```

Only the local browser endpoint requires Chrome/Edge. Windows, macOS, and Linux can run the Node app. Automated browser checks run in headless Chromium; other browsers and operating systems require your own smoke test.

### First run

Enter the two keys in the local dashboard and click **Connect keys**. Keys stay in the server process; they are not saved in localStorage, written to disk by the app, embedded in the download, or exposed through the public tunnel.

Alternatively, set `SENT_DM_API_KEY` and `OPENAI_API_KEY` in your shell, or copy `.env.example` to `.env` (git-ignored) and fill them in. Shell values take precedence over `.env`. When both are present, the server validates them at startup through the same checks as the dashboard form, and the dashboard shows that environment keys are in use. Keys entered in the dashboard override them for the running session. The server removes both variables from its own environment after reading them, so the `cloudflared` child process never inherits them. A `.env` file is plaintext on disk; prefer shell variables or a secret manager on shared machines.

The app fetches your **existing active voice numbers** and selects the default number. The person you call sees this number as caller ID. It never buys or allocates a number. Your Sent account must already have voice enabled and enough balance for calls to phones, and your OpenAI project must have access to the selected voice model.

Review the opening line and instructions, then click **Start agent**. Start checks model access, opens a callback-only Cloudflare quick tunnel, registers the browser as a Sent app user, and changes the selected number's callback URL. Your browser asks for notification permission, which the Sent SDK needs to register. The AI's software microphone is used rather than your physical microphone.

Enter the number to call in **international format**: `+`, the country code, and the number, for example `+14155551234` or `+38349123456`. Spaces, dashes, dots, and parentheses are removed. A number without `+` and a country code is refused; the app never guesses a country. Tick **I have permission to call this number with an AI voice**, then click **Call**.

The app opens the voice session first, then asks Sent to dial. When the person answers, the agent lets them greet it or finish their first sentence, then speaks the opening line. If they say nothing for 3 seconds, the agent starts. The dashboard shows the call status and live transcripts. Your computer does not play the call audio through its speakers.

Click **Stop & restore routing** when finished, then close the terminal. **Ctrl+C** also attempts restoration.

## Why outbound calls need the callback

Sent has no REST endpoint that dials a phone for you. The browser asks for a call with the SDK's `connect({ to })`, and Sent then asks the **selected number's callback URL** what to ring:

```text
Dashboard: Call +14155551234
        ↓
@sentdm/voice connect({ to }) → Sent
        ↓
Sent → signed call.request (direction: outbound) → this app's gateway
        ↓
connectToNumber { number, callerId, dialTimeoutSeconds: 30 } → the phone rings
```

So the app installs its own callback on the number while it runs, exactly as the inbound sample does. The gateway dials **only** the number you just asked for, from this tab's identity, within 20 seconds, and only once. Every other question gets `reject`, including inbound calls to the number. While the agent runs, people who call your number are turned away.

## What Start changes

| Item | Behavior |
| --- | --- |
| Number inventory | Existing active numbers only; no purchase/provisioning |
| Selected number callback | Temporarily replaced with this app's public callback URL |
| Inbound calls to the number | Rejected until Stop restores the previous callback |
| Previous callback URL | Saved locally before changing the number |
| Callback signing secret | Obtained via Sent's documented add-existing-number operation; not rotated |
| Voice identity | A new isolated app-user identity is minted through Sent voice tokens |
| Caller ID | The selected number |
| Recording | Not enabled by this app |
| Call outcomes | Saved to `.sent-agent/call-outcomes.jsonl` when the agent records one (Realtime models) |
| Other numbers | Not changed |

On Stop, the app restores a previous callback **only if the number still points to the URL it installed**. It will not overwrite changes made elsewhere. Routing backups are stored in `.sent-agent/routing-backup.json`, with owner-only file permissions where the OS supports them. The file contains routing metadata and the callback signing secret, **not API keys**.

### If the number had no previous callback

Sent's documented PATCH contract does not clear `callback_url` to null. The app therefore cannot promise to restore an absent callback. It warns you, retains the backup, and stops routing to the agent. Configure the desired callback in Sent when done, then click **Forget routing backup** (shown while stopped). Prefer a test number or a number with an existing callback for clean restoration.

### Crash or interrupted restoration

The backup is written before changing routing. Re-run the app, connect the **same Sent account's keys**, and it attempts recovery before another activation. If the browser heartbeat is lost for 7 seconds, the server stops and restores routing. This is best-effort: a power loss, process kill, or network outage can prevent the REST request. The heartbeat is timed by a dedicated Web Worker, so the tab can be in the background, but it must stay open.

## How a call works

| Step | What happens |
| --- | --- |
| Call | The number is checked and normalized. The tab opens the local bridge, and the server opens the OpenAI voice session. |
| Dial | Once the model is ready, the tab calls `connect({ to })`. The gateway answers Sent's question with `connectToNumber`. |
| Ringing | The dashboard shows **Ringing**. No audio is sent to the model yet, so ringback tones and carrier messages never reach it. |
| Answer | The tab starts sending the call audio. If the person speaks first, the agent waits until they finish (their first turn ends after 900 ms of silence, later turns after 450 ms), then answers with the opening line. If they stay silent for 3 s, the agent speaks it. |
| Talk | Up to **5 minutes**, counted from the answer. The call also ends after 60 seconds with no speech from either side. |
| End | `completed`, `busy`, `noAnswer`, or `failed` is shown. A call nobody answers ends after Sent's 30-second dial timeout. |

The app places one call at a time. **Hang up** ends a call at any point, also while the model is still starting; a call cancelled before the model is ready is never dialed.

## How audio works

```text
Phone of the person you call
        ↕
Sent number → connectToNumber ← @sentdm/voice connect({ to }) in your browser
        ↕
Remote-only MediaStream capture / software microphone
        ↕
Local TypeScript server → OpenAI Live or Realtime WebSocket
```

The local browser adapts audio-only `getUserMedia` requests to a cloned Web Audio `MediaStreamDestination`. Generated model audio feeds this **software microphone**. The remote party's stream is captured from the SDK's documented custom playback audio element and sent to OpenAI as raw mono PCM16 at 24 kHz. An AudioWorklet keeps the sample clock, sends 20 ms chunks, and uses a bounded playback queue. It never sends model output back into the capture, so the agent never hears itself.

Playback queues are capped at 5 seconds for Live and 120 seconds for Realtime. Overflow ends the call instead of silently losing speech. On a Realtime interruption, the server cancels the response (`interrupt_response`), and the app clears unplayed audio and truncates the conversation to the rendered position. The app also checks that the Sent SDK actually took the software microphone; if it did not, the call is ended.

### The default agent

The default instructions describe a short follow-up call from Sent to someone who signed up recently: the agent lets the person speak first, says it is an AI assistant in its first sentence, asks one thing at a time, offers a follow-up from the team, asks when to call back if it's a bad time, and leaves one short voicemail when it reaches one. Edit both the opening line and the instructions in the dashboard.

### Outcomes, hanging up, and silence

With the Realtime models, the agent has two tools:

- **`record_outcome`** saves one of `interested`, `callback_requested`, `not_interested`, `do_not_call`, `wrong_number`, or `voicemail`, a short summary, and a callback time if one was asked for. It goes to `.sent-agent/call-outcomes.jsonl` (owner-only permissions) and to the event log. The model is told whether the save succeeded. Unknown outcomes are refused.
- **`end_call`** ends the call. The app then asks the model for a short goodbye itself (tools off) and hangs up once it has played. If the person cuts into the goodbye, the call continues.

GPT-Live-1 does not get these tools.

## Choosing models

The model options, prices, and settings match the inbound sample. See [Models](./_docs/models.md) for costs and details. One difference: the voice session opens before the dial, so with GPT-Live-1 (billed per second) the ringing time is also billed, about $0.025 for a 30-second ring.

## Calling rules

Many countries regulate automated and AI voice calls, including consent, AI disclosure, permitted call times, and do-not-call lists. Call only numbers that you own or whose owners agreed to an AI call. The dashboard asks you to confirm permission for each call, and the default agent says that it is an AI in its first sentence. A `do_not_call` outcome is saved, but the app does not keep or check a do-not-call list. Calls to phones are charged by Sent at the destination's per-minute rate.

## Network and privacy

The dashboard/key/token/media server binds only to `127.0.0.1`. Host checks, same-origin checks, and a per-process CSRF token protect local management. The OpenAI API key stays server-side. The browser receives only a short-lived Sent voice token.

A second minimal HTTP gateway exposes **only `/health` and a random signed voice callback** through Cloudflare. Callback requests require the correct number-specific HMAC signature over the raw request body and a timestamp within five minutes. Duplicate call decisions are cached briefly.

Cloudflare quick tunnels need no account or key, but they require downloading/running `cloudflared` and outbound network access to Cloudflare. The binary is downloaded automatically on first Start. Only callback metadata passes through Cloudflare; audio is carried by the Sent browser connection and your local-server-to-OpenAI connection.

Transcripts and events remain in memory and are discarded when the server exits. Call outcomes are the exception: they are appended to `.sent-agent/call-outcomes.jsonl` and contain phone numbers and what the person said. No call recordings are created. API/provider usage may incur charges; this app does not provide cost guarantees.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| "Enter the number in international format" | Start with `+` and the country code, for example `+14155551234` |
| No active voice numbers | Enable voice on an existing number/account in Sent first; use an appropriately scoped API key |
| OpenAI key check or session rejected | Check direct OpenAI key, project access, and chosen model |
| Registration/notification failure | Use current Chrome/Edge on localhost and allow notifications; private browsing can block service workers/push |
| Callback tunnel cannot start | Allow outbound Cloudflare/GitHub access; first run downloads cloudflared; quick tunnels can be unavailable |
| The phone never rings | Read the event log and the call record's `failure_reason`, for example `insufficient_balance` or `destination_blocked`. See [Troubleshooting](./_docs/sent-calls-and-logs.md#troubleshooting) |
| `Call ended (noAnswer)` or `(busy)` | Nobody answered within 30 s, or the line was busy or declined |
| "Calls can't be placed until it reconnects" | Wait; the SDK retries about every 30 s |
| Restoration failed | Reconnect same keys and retry recovery; inspect retained routing backup; restore desired URL in Sent |
| Port in use | Stop the other process, or set `PORT` (e.g. `PORT=3001 pnpm start`) |

## Development and tests

```sh
pnpm install
pnpm run check                        # server + browser TypeScript
pnpm test                             # server tests against local fakes
pnpm run build
pnpm exec playwright install chromium
pnpm test:browser                     # real browser audio graph
pnpm test:dashboard                   # dashboard call lifecycle with a fake SDK
```

Server tests use local fake Sent/OpenAI services and test actual request/event shapes without calls or credentials. They cover the dial rules: only the requested number, only from this tab, only once, and nothing for inbound calls or other app users.

## Dependencies and integration references

The project uses the published `@sentdm/voice` package (Sent's browser voice SDK), Express, `ws`, and `cloudflared`. They are version-pinned in `pnpm-lock.yaml`; review third-party advisories before production use. A `basic-ftp` override in `pnpm-workspace.yaml` patches an inherited advisory in the SDK's unused Node proxy dependency chain, and install scripts are limited to esbuild.

The committed browser bundle includes `@sentdm/voice` and its dependencies. Their licenses are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md), which `pnpm run build` regenerates.

- [Sent voice SDK](https://docs.sent.dm/sdks/voice)
- [Sent voice callback contract](https://docs.sent.dm/reference/api/voice-callback)
- [Sent in-app calls and voice tokens](https://docs.sent.dm/start/guides/in-app-calls)
- [Sent answering calls](https://docs.sent.dm/start/guides/answering-calls)
- [OpenAI Live WebSocket protocol](https://developers.openai.com/api/docs/guides/voice-websockets?api=live)
- [OpenAI Live delegation](https://developers.openai.com/api/docs/guides/live-delegation)
- [OpenAI Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [OpenAI current model catalog](https://developers.openai.com/api/docs/models)
- [Cloudflare quick tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
