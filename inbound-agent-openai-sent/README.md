# Sent inbound agent

A **downloadable local TypeScript app** that answers incoming calls on an existing Sent voice number with OpenAI. External credentials: **one Sent API key and one OpenAI API key**.

Default voice model: **GPT-Realtime-2.1**, with **GPT-Realtime-2.1 Mini** and **GPT-Live-1** options. Realtime input transcription defaults to **GPT-Live-Transcribe**. The optional GPT-Live text helper defaults to **GPT-6 Luna**, with **GPT-5.4 Mini**, **GPT-6 Sol**, and **GPT-6 Astra** options. No SIP trunk or extra Sinch key is needed. The app uses the published Sent browser voice SDK, a software microphone, and OpenAI's server-side WebSocket API.

> This is a single-call local prototype. Keep the browser tab open and the computer awake. It is not an always-on telephony service. Real phone-call behavior requires validation with your own accounts.

## Run it

Install **Node.js 22 or newer** from [nodejs.org](https://nodejs.org/) and [pnpm](https://pnpm.io/installation) (or run `corepack enable pnpm`; Corepack ships with Node 22–24). Clone this repository, open a terminal in the `inbound-agent-openai-sent` folder, then run:

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

Only the local browser endpoint requires Chrome/Edge. Windows, macOS, and Linux can run the Node app. Automated browser checks were performed on Linux Chromium; other operating systems require your own smoke test.

### First run

Enter the two keys in the local dashboard and click **Connect keys**. Keys stay in the server process; they are not saved in localStorage, written to disk by the app, embedded in the download, or exposed through the public tunnel.

Alternatively, set `SENT_DM_API_KEY` and `OPENAI_API_KEY` in your shell, or copy `.env.example` to `.env` (git-ignored) and fill them in. Shell values take precedence over `.env`. When both are present, the server validates them at startup through the same checks as the dashboard form, and the dashboard shows that environment keys are in use. Keys entered in the dashboard override them for the running session. The server removes both variables from its own environment after reading them, so the `cloudflared` child process never inherits them. A `.env` file is plaintext on disk; prefer shell variables or a secret manager on shared machines.

You never paste a callback URL into Sent. **Start answering** creates one (`https://<random>.trycloudflare.com/voice/<random path>`), installs it on the selected number through the Sent API, and **Stop** restores the previous one. The dashboard shows the current URL under **Callback**. It changes on every Start, which is why the app manages it for you.

The app fetches your **existing active voice numbers** and selects the default number. If there are several, choose one from the discovered list. It never buys or allocates a number. Your Sent account must already have voice enabled, and your OpenAI project must have access to the selected voice model. It cannot enable provider/model access using the keys alone.

Review the greeting and instructions. **Start answering** checks model access, opens a callback-only Cloudflare quick tunnel, registers the browser as a Sent user, and changes the selected number's callback URL. Your browser may ask for notification permission for Sent incoming-call delivery. The AI's software microphone is used rather than your physical microphone.

Notification permission is required by this SDK's incoming-call registration path. Grant it when prompted. No external account or additional key is required for that browser permission.

Call the selected Sent number from another phone. The app accepts one inbound call at a time, opens a voice session, and greets the caller after the phone media connects. The dashboard displays live call status and transcripts. The caller hears the generated voice through the call; your computer does not play the caller/agent audio through its speakers.

Click **Stop & restore routing** when finished, then close the terminal. **Ctrl+C** also attempts restoration. Do not simply close the terminal or put the computer to sleep while testing inbound calls.

## What Start changes

| Item | Behavior |
| --- | --- |
| Number inventory | Existing active numbers only; no purchase/provisioning |
| Selected number callback | Temporarily replaced with this app's public callback URL |
| Previous callback URL | Saved locally before changing the number |
| Callback signing secret | Obtained via Sent's documented add-existing-number operation; not rotated |
| Voice identity | A new isolated app-user identity is minted through Sent voice tokens |
| Recording | Not enabled by this app |
| Caller messages | Saved to `.sent-agent/messages.jsonl` when the agent takes a message (Realtime models) |
| Outbound calls | No dialing UI/API; live outbound callback requests are rejected |
| Other numbers | Not changed |

On Stop, the app restores a previous callback **only if the number still points to the URL it installed**. It will not overwrite changes made elsewhere. Routing backups are stored in `.sent-agent/routing-backup.json`, with owner-only file permissions where the OS supports them. The file contains routing metadata and the callback signing secret, **not API keys**.

### If the number had no previous callback

Sent's documented PATCH contract does not clear `callback_url` to null. The app therefore cannot promise to restore an absent callback. It warns you, retains the backup, and stops routing calls to the agent. While the app is running, its stopped callback rejects calls; after the tunnel closes, that temporary callback is unreachable. Configure the desired callback in Sent when done. Prefer a test number or a number with an existing callback for clean restoration.

A retained backup blocks activating any other number. Once you've set that number's routing in Sent, click **Forget routing backup** (shown while stopped). The confirmation names the number and any previous callback the app will no longer restore, and the event log keeps that URL.

### Crash or interrupted restoration

The backup is written before changing routing. Re-run the app, connect the **same Sent account's keys**, and it attempts recovery before another activation. If restoration fails, the backup remains and the error is shown. Do not delete `.sent-agent` until routing is recovered. You can also restore the previous callback URL directly in Sent.

If the browser heartbeat is lost for 7 seconds, the server attempts to stop and restore routing. This is a best-effort recovery, not a guarantee: a power loss, process kill, or network outage can prevent the REST request. The heartbeat is timed by a dedicated Web Worker, because Chrome slows ordinary page timers in hidden tabs to once a minute; the tab can be in the background, but it must stay open.

If the Sent SDK's registration goes offline (for example, a failed token refresh), routing stays in place. The SDK retries about every 30 seconds, a call in progress continues, and new calls are declined as busy until registration returns.

## How audio works

```text
Incoming phone call
        ↕
Sent number → connectToUser → @sentdm/voice in your browser
        ↕
Remote-only MediaStream capture / software microphone
        ↕
Local TypeScript server → OpenAI Live or Realtime WebSocket
```

The local browser adapts audio-only `getUserMedia` requests to a cloned Web Audio `MediaStreamDestination`. Generated model audio feeds this **software microphone**. The remote party's stream is captured from the SDK's documented custom playback audio element and sent to OpenAI as raw mono PCM16 at 24 kHz. This is an application-local browser media adapter, not an unpublished Sent server-media API.

An AudioWorklet preserves the sample clock, sends 20 ms caller/silence chunks, and uses a bounded playback queue. It never sends model output back into caller input. The adapter is active only in this dedicated tab, is restored on Stop, and does not alter other browser tabs or OS audio devices.

Playback queues are capped at 5 seconds for Live, which streams in real time, and 120 seconds for Realtime, which delivered a 10-second reply about 6× faster than real time in a live test. The cap only guards against runaway output: overflow ends the call instead of silently losing speech. On a Realtime interruption, the server cancels the response (`interrupt_response`), and the app clears unplayed audio and truncates the conversation to the rendered position. Live manages conversation overlap natively; queued telephony audio can still delay an interruption, so validate barge-in on your actual call path.

OpenAI `error` events end the call only for codes that leave the session unusable (`session_expired`, `insufficient_quota`, `invalid_api_key`) or when the model connection closes. Request-level errors, such as a truncate racing the end of a response, are logged as notices and the call continues.

The app also checks that the Sent SDK actually took the software microphone. If an SDK update stopped doing so (and could therefore be sending the computer's real microphone), the call is ended with an error.

### The default agent

The default instructions describe Sent (one API for SMS, WhatsApp, and RCS) and keep the agent short and human: most replies are under 20 words, it asks one thing at a time, and it never guesses accounts, pricing, or billing. Instead it offers to take a message. In live tests the agent answered in 11–28 words (34–53 with the previous prompt) and saved messages in the caller's own words. Edit both the greeting and the instructions in the dashboard.

### Messages, hanging up, and silence

With the Realtime models, the agent has two tools:

- **`take_message`** records the caller's name, callback number, and message to `.sent-agent/messages.jsonl` (owner-only permissions). It also shows the message in the event log. The model is told whether the save succeeded, so it can't claim a message was taken when it wasn't.
- **`end_call`** ends the call. The app then asks the model for a short goodbye itself (tools off) and hangs up once it has played. Left to the model, the goodbye was skipped or narrated ("let's wrap this up") in 4 of 5 live tests. If the caller cuts into the goodbye ("wait, one more thing"), the call continues.

Any call also ends after 60 seconds with neither caller speech nor agent audio. GPT-Live-1 does not get these tools.

When Sent's signed callback accepts a call, the server opens the OpenAI session immediately. That overlaps model startup with push delivery to the browser, so the caller hears ringing for less time. The browser's bridge then adopts the warm session; an unused session is closed after 25 seconds.

### Choosing models

Prices are from [OpenAI's pricing page](https://developers.openai.com/api/docs/pricing) as of 9 October 2026. Measurements are from live tests with this app's exact settings.

| Role | Choice | Cost | Notes |
| --- | --- | --- | --- |
| Voice | **GPT-Realtime-2.1** (default) | Audio $32 in / $64 out per 1M tokens: about $0.02 per minute of caller speech and $0.08 per minute of agent speech | Best instruction following and tool use; first audio ~0.7–0.8 s |
| Voice | GPT-Realtime-2.1 Mini | Audio $10 / $20 per 1M (~3× cheaper) | OpenAI notes weaker instruction following and function calling, and recommends testing with the larger model first |
| Voice | GPT-Live-1 | $0.05/min billed per second, plus helper tokens | Full-duplex (listens while speaking). In this app it has no `take_message`/`end_call` tools (see below) |
| Caller transcription (Realtime) | **GPT-Live-Transcribe** (default) | $0.017/min | Streams captions while the caller is still speaking; final text ~2.3 s after they stop |
| Caller transcription (Realtime) | GPT-Transcribe | $0.0045/min | Text starts ~0.15 s after the caller stops, final in ~0.6 s |
| GPT-Live text helper | **GPT-6 Luna** (default) | $0.10 / $0.50 per 1M | `effort: none`; usually 1–1.7 s but varied up to 4.7 s in testing |
| GPT-Live text helper | GPT-5.4 Mini | Not in the GPT-6 price table; see the pricing page | `effort: none`; fastest in testing (median 0.9 s), previous generation |
| GPT-Live text helper | GPT-6 Sol | $2 / $10 per 1M | `effort: none`, ~1.8 s; the Sol OpenAI's delegation guide suggests for harder questions. `gpt-6.1-sol` was dropped: it requires `effort: low` and took ~5.7 s |
| GPT-Live text helper | GPT-6 Astra | $10 / $50 per 1M | `effort: low`; OpenAI's model "for the most demanding work", which is overkill for two spoken sentences |

Your key may list more text models (GPT-4.1, GPT-5.x, o-series). They work with the Responses API, but these four cover the useful range for a two-sentence spoken answer. Whichever helper you choose, it only knows what the instructions tell it about Sent; in testing, every model confidently confirmed product features it had not been told about. Keep factual claims in the instructions, and have it offer a message for anything else.

Transcription only feeds the dashboard; the voice model hears the audio directly. GPT-Live-1 produces its own transcripts and ignores the transcription choice. The app never silently substitutes a model if access fails.

**GPT-Realtime-2.1 / Mini** use `/v1/realtime` with GA session fields: server voice activity detection, `interrupt_response`, `reasoning.effort: low` (OpenAI's recommendation for production voice agents; it showed no first-audio penalty in testing), the `take_message`/`end_call` tools, and the `marin` voice. The GPT-6 helper is not used.

**GPT-Live-1** uses `/v1/live/sessions` with *client* delegation. When GPT-Live wants help, the app sends the transcript to the selected GPT-6 model through the Responses API and returns at most two spoken sentences as commentary. The GPT-6 models never hear the phone audio. With client delegation GPT-Live cannot call `take_message` or `end_call`. OpenAI's [delegation guide](https://developers.openai.com/api/docs/guides/live-delegation) supports tools through *Responses* delegation (`delegation.responses.tools`), which would be the way to add them.

Not adopted yet, pending real-call evaluation: `semantic_vad` (OpenAI says it is less likely to interrupt the caller), `noise_reduction: near_field` (accepted by the API, but untested on real phone audio), and Fast mode for the helper (`service_tier: priority`, 2× price; showed no clear latency gain for Luna).

Caller and assistant transcripts can overlap. A generated transcript is not proof that the caller heard the corresponding audio. Do not use this demo to make contractual promises or verified business-record changes.

## Network and privacy

The dashboard/key/token/media server binds only to `127.0.0.1`. Host checks, same-origin checks, and a per-process CSRF token protect local management. The OpenAI API key stays server-side. The browser receives only a short-lived Sent voice token.

A second minimal HTTP gateway exposes **only `/health` and a random signed voice callback** through Cloudflare. The public tunnel cannot reach dashboard, key, voice-token, or model-audio endpoints. Callback requests require the correct number-specific HMAC signature over the raw request body and a timestamp within five minutes. Duplicate call decisions are cached briefly.

Cloudflare quick tunnels need no account or key, but they require downloading/running `cloudflared` and outbound network access to Cloudflare. The binary is downloaded automatically on first Start. The temporary hostname changes each run and has no uptime guarantee. It takes a few seconds to appear in DNS after the tunnel connects, so Start checks reachability through Cloudflare's public resolver (1.1.1.1). That keeps an early "not found" answer out of your OS DNS cache, which would otherwise keep it for 60 seconds. Only callback metadata passes through Cloudflare; audio is carried by the Sent browser connection and your local-server-to-OpenAI connection.

Transcripts and events remain in memory and are discarded when the server exits. Messages the agent takes are the exception: they are appended to `.sent-agent/messages.jsonl` and contain caller-provided personal data (names, phone numbers). No call recordings are created. Follow the consent, AI-disclosure, privacy, and call-recording rules applicable to your deployment. API/provider usage may incur charges; this app does not provide cost guarantees.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| No active voice numbers | Enable voice on an existing number/account in Sent first; use an appropriately scoped API key |
| OpenAI key check or session rejected | Check direct OpenAI key, project access, permissions, and chosen model; a Chat Completions-only proxy is insufficient |
| GPT-Live unavailable | Select the explicit Realtime alternative if your OpenAI account supports it |
| Registration/notification failure | Use current Chrome/Edge on localhost and allow notifications; private browsing/browser policies can block service workers/push |
| Callback tunnel cannot start | Allow outbound Cloudflare/GitHub access; first run downloads cloudflared; quick tunnels can be unavailable. "Did not become reachable" means its hostname never resolved through 1.1.1.1 or `/health` failed within 45 s |
| No call arrives | Keep tab open; check callback test/status, number/account voice access, and browser registration |
| "Voice registration is offline and retrying" | Wait; the SDK retries about every 30 s and new calls are declined meanwhile. Check network access if it persists |
| Call connects but audio fails | Check logged model errors and PCM/browser support; use a separate phone and no other calling tabs for this identity |
| Restoration failed | Reconnect same keys and retry recovery; inspect retained routing backup; restore desired URL in Sent |
| "A previous routing backup needs recovery" for another number | Set the old number's routing in Sent, then use **Forget routing backup** |
| Port in use | Stop the other process, or set `PORT` in your shell or `.env` (e.g. `PORT=3001 pnpm start` on macOS/Linux or `$env:PORT=3001; pnpm start` in PowerShell) |

## Development and tests

```sh
pnpm install
pnpm run check                        # server + browser TypeScript
pnpm test                             # server tests against local fakes
pnpm run build
pnpm exec playwright install chromium
pnpm test:browser                     # real browser audio graph
pnpm test:dashboard                   # dashboard lifecycle with a fake SDK
```

Server tests use local fake Sent/OpenAI services and test actual request/event shapes without calls or credentials. Browser audio checks validate software-microphone output, remote capture, silence pacing, and loopback isolation.

## Dependencies and integration references

The project uses the published `@sentdm/voice` package (which includes the Sinch browser transport), Express, `ws`, and `cloudflared`. They are version-pinned in `pnpm-lock.yaml`; review third-party advisories before production use.

The direct `ws` transport is patched to 8.22.0. A `basic-ftp` override to 6.2.2, in `pnpm-workspace.yaml`, patches an inherited advisory in the SDK's unused Node proxy dependency chain; it does not replace the Sent/Sinch browser transport. `pnpm-workspace.yaml` also limits install scripts to esbuild; cloudflared's binary is fetched on first Start instead. `pnpm audit --prod` reports no known vulnerabilities.

The committed browser bundle includes `@sentdm/voice` and its dependencies, such as the Sinch and PubNub SDKs. Their licenses are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md), which `pnpm run build` regenerates.

- [Sent voice SDK](https://docs.sent.dm/sdks/voice)
- [Sent inbound callback contract](https://docs.sent.dm/reference/api/voice-callback)
- [Sent voice tokens and in-app calls](https://docs.sent.dm/start/guides/in-app-calls)
- [OpenAI Live WebSocket protocol](https://developers.openai.com/api/docs/guides/voice-websockets?api=live)
- [OpenAI Live delegation](https://developers.openai.com/api/docs/guides/live-delegation)
- [OpenAI Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [OpenAI current model catalog](https://developers.openai.com/api/docs/models)
- [GPT-Realtime-2.1 Mini](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini)
- [GPT-Live-Transcribe](https://developers.openai.com/api/docs/models/gpt-live-transcribe)
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Cloudflare quick tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
