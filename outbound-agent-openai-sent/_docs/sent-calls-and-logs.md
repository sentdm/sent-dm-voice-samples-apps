# Sent calls and logs

This document describes how Sent places a phone call for the outbound agent. It also shows where each part of a call is logged, and how to use the logs to find a problem.

- [What Sent does in this sample](#what-sent-does-in-this-sample)
- [The Sent API calls that the app makes](#the-sent-api-calls-that-the-app-makes)
- [The life of an outbound call](#the-life-of-an-outbound-call)
- [The callback question and answer](#the-callback-question-and-answer)
- [Identity, voice token, and caller ID](#identity-voice-token-and-caller-id)
- [Routing changes on your number](#routing-changes-on-your-number)
- [Where to find logs](#where-to-find-logs)
- [Find a call in Sent](#find-a-call-in-sent)
- [Troubleshooting](#troubleshooting)

## What Sent does in this sample

Sent does five jobs in each call:

1. Sent receives the call request from the browser tab. The SDK sends it when the tab calls `connect({ to })`.
2. Sent asks your number's callback URL what to do with the call.
3. Sent dials the phone number that the answer names. The contact's phone shows your number.
4. Sent carries the call audio between the phone and the browser. The SDK uses WebRTC for this.
5. Sent keeps a call record. It can also send `call` webhooks.

Sent has no REST endpoint that dials a phone for you. A call always starts from an app user, and your callback decides what rings.

The app uses Sent through two paths:

- The **Sent REST API**, from the Node.js server, with your Sent API key.
- The **`@sentdm/voice` SDK**, in the browser tab, with a short-lived voice token. The browser never gets your API key.

## The Sent API calls that the app makes

All requests go to `https://api.sent.dm`. Each request has the header `x-api-key`. Each request that is not a `GET` also has a random `Idempotency-Key`. Each request stops after 15 seconds.

| Request | When | Why | Source |
| --- | --- | --- | --- |
| `GET /v3/channels/voice` | Connect keys | List your voice numbers. The app keeps only the `ACTIVE` numbers. | `src/sent.ts` `list()` |
| `GET /v3/channels/voice/{number}` | Start, Stop, recovery | Read the number's current `callback_url`. | `get()` |
| `POST /v3/channels/voice` with `number` and `callback_url` | Start | Set the tunnel callback URL on the existing number. Sent returns the `callback_secret`. | `routeExisting()` |
| `POST /v3/channels/voice/{number}/test` | Start | Ask Sent to send a signed test question to the callback URL. | `test()` |
| `POST /v3/channels/voice/tokens` with `identity`, `number`, and `ttl: 600` | SDK registration, and each token refresh | Mint a voice token for the browser. | `token()` |
| `PATCH /v3/channels/voice/{number}` with `callback_url` | Stop, recovery | Put the old callback URL back. | `restore()` |

The app uses `POST /v3/channels/voice` with an existing number only. It never asks Sent for a new number.

If Sent returns an error, the dashboard shows it in this format:

```text
Sent 400: BUSINESS_024 — <message from Sent>
```

The browser SDK also sends requests to Sent. It registers the tab, places the call, and sends [telemetry](#sdk-telemetry).

## The life of an outbound call

This table shows one call from start to end. It shows what Sent does, what the app does, and what you see in the event log.

| # | Sent | App | Event log |
| --- | --- | --- | --- |
| 1 | — | You click **Call**. The tab opens the bridge. The server opens an OpenAI session and sets the pending dial. | `call: OpenAI voice connected; dialing +14155550123.` |
| 2 | The tab calls `connect({ to })`. Sent makes a call record with an ID `call_…`. | — | — |
| 3 | Sent sends a signed `call.request` question with `direction: "outbound"` to your callback URL. | The gateway checks the signature and the dial rules. | — |
| 4 | — | The gateway answers `connectToNumber` and clears the pending dial. | `call: Outbound call call_…: connectToNumber.` |
| 5 | Sent dials the number. The phone rings. | The dashboard shows **Ringing**. | — |
| 6 | The contact answers. Sent connects the phone and the browser. | The tab sends `answered`. The agent lets the contact finish their greeting, or says the opening line after 3 s of silence. | `call: +14155550123 answered.` |
| 7 | Sent carries the audio. | The agent and the contact speak. | `outcome: …` if the agent records one |
| 8 | The call ends. Sent sets the final status and the duration. | The tab closes the bridge. | `call: Call ended (completed).` and `call: Call media disconnected.` |

The `call_…` ID in step 4 is the ID that Sent uses for the call record. Use it to [find the call in Sent](#find-a-call-in-sent).

If the gateway rejects the question in step 4, the event log shows `call: Outbound call call_…: reject.`. Sent then ends the call with the status `FAILED` and the reason `rejected`.

## The callback question and answer

### The question

Sent sends a `POST` request to the callback URL. This is an example for a call that the tab placed:

```http
POST /voice/9c1e…a07f HTTP/1.1
Content-Type: application/json
X-Webhook-ID: <callback configuration ID>
X-Webhook-Timestamp: 1791544800
X-Webhook-Signature: v1,K3x9…=
X-Request-Id: <Sent request ID>

{
  "type": "call.request",
  "version": "1",
  "callId": "call_8f2…",
  "number": "+16285550199",
  "timestamp": "2026-10-10T12:00:00Z",
  "direction": "outbound",
  "from": { "kind": "user", "identity": "sent-ai-3fa9c1e07b2d" },
  "to": { "kind": "number", "number": "+14155550123" }
}
```

`number` is your selected number. A call is outbound exactly when `from` is an app user. On a retry, Sent also sends `X-Sent-Retry: 1`.

Sent sends questions for inbound calls to the same URL. While the agent runs, those questions also come to the gateway.

### How the gateway checks the question

The gateway does these checks in this order. It reads the JSON body only after the signature is correct.

1. The path must be the random callback path for this run. If not, the gateway returns `401`.
2. The gateway must have a callback secret for the number. If not, it returns `401`.
3. The timestamp must be within 5 minutes of the server clock. If not, it returns `401`.
4. The signature must match. The gateway removes `whsec_` from the secret and decodes the rest from base64. It calculates HMAC-SHA256 over `{id}.{timestamp}.{raw body}`. It compares the result in constant time with each `v1,` value in the header. If none match, it returns `401`.
5. The body must be valid JSON, with a `callId` of 100 characters or fewer and the selected `number`. If not, it returns `400`.

Sent does not retry a `4xx` response. It ends the call with the reason `rejected`. The gateway does not write a `400` or `401` to the event log.

### How the gateway decides

`decideOutbound()` in `src/security.ts` makes the decision. The first rule that matches gives the answer.

| Rule | Answer |
| --- | --- |
| `type` is not `call.request`, `version` is not `1`, or `number` is not the selected number | `reject`, reason `declined` |
| `test` is `true` and `to` is a phone number | `connectToNumber` to that number. A test never starts a call. |
| `test` is `true` and `to` is not a phone number | `reject`, reason `declined` |
| `direction` is not `outbound`, or `from` is not this tab's identity | `reject`, reason `declined` |
| There is no pending dial: the agent is not `ready`, the tab is not alive or not registered, or nobody clicked **Call** | `reject`, reason `declined` |
| `to` is not a phone number, or it is not the pending number | `reject`, reason `declined` |
| The pending dial is older than 20 seconds | `reject`, reason `declined` |
| All other questions | `connectToNumber`, then the pending dial is cleared |

The answer for "dial" is:

```json
{ "action": { "action": "connectToNumber", "number": "+14155550123", "callerId": "+16285550199", "dialTimeoutSeconds": 30 } }
```

The answer for all refusals is:

```json
{ "action": { "action": "reject", "reason": "declined" } }
```

So, while the agent runs, people who call your number get `reject`. The event log shows `call: Inbound call call_…: reject.`

### Why the gateway answers fast

Sent gives the callback 2.5 seconds for each attempt, and makes 2 attempts. The contact's phone does not ring until the gateway answers. So the gateway:

- Decides from data in memory only. It makes no network calls before it answers.
- Keeps each answer for 15 seconds, by call ID. A retry of the same question gets the same answer, even after the pending dial is cleared.

### What Sent does with each result

| Gateway result | Sent call result |
| --- | --- |
| `200` with `connectToNumber` | Sent dials the number. The phone rings for up to 30 s. |
| `200` with `reject` | The call ends as `FAILED`, reason `rejected`. |
| `400` or `401` | The call ends as `FAILED`, reason `rejected`. Sent does not retry. |
| No answer in 2.5 s, two times | The call ends as `FAILED`, reason `callback_timeout`. |
| The number has no callback URL | The call ends as `FAILED`, reason `callback_not_configured`. |

Sent can also refuse a call before it asks the question. It does this when your balance is zero or less (`insufficient_balance`), or when Sent does not allow calls to the country of the number (`destination_blocked`).

A phone call runs for as long as your balance covers, at the destination's rate per minute, and for 4 hours at most. The app's own limit is 5 minutes from the answer.

## Identity, voice token, and caller ID

### Identity

The server makes a new identity each time it starts: `sent-ai-` and 12 hex characters. The dashboard shows it under **Identity**.

The gateway dials only for this identity. A new server start makes a new identity, so an old tab cannot place calls.

### Voice token

The SDK calls the token provider when it registers, and again before each token expires.

1. The tab sends `POST /api/voice-token` to the management server.
2. The server sends `POST /v3/channels/voice/tokens` to Sent, with the identity, the selected number, and `ttl: 600`.
3. The server gives the token to the SDK.

The token lasts 10 minutes. The SDK gets a new token at 80% of its life, which is after about 8 minutes.

### Caller ID

The voice token binds the identity to the selected number. Calls that the identity places go out from that number, and the callback question shows it as `number`. The gateway also sets `callerId` to the same number in its answer. So the contact's phone shows your selected number.

`callerId` must be a number that your account owns through Sent. If it is not, Sent fails the call with `caller_id_not_owned`.

### Registration

The SDK must register before it can place calls. Registration needs a service worker, so the app serves the Sent service worker at `/sw.js`, and the browser must allow notifications.

The SDK client moves through these states:

| State | Meaning | What the app does |
| --- | --- | --- |
| `registering` | The SDK gets a token and registers. | Waits. |
| `registered` | The tab can place calls. | Writes `voice: Browser voice registration is ready.` |
| `offline` | A token refresh failed. The SDK tries again about every 30 s. | Keeps the routing. The app cannot place calls. A call in progress continues. |
| `destroyed` | The app stopped the SDK. | This happens on Stop. |

Open only one dashboard tab.

### Call states in the SDK

A call goes from `initiated` to `ringing`, then to `connected` when the contact answers. It ends with one of these states. The event log shows it as `call: Call ended (<state>).`

| State | Meaning |
| --- | --- |
| `completed` | The call ended normally. |
| `failed` | The call could not connect, or its connection was lost for more than 5 minutes. |
| `busy` | The line was busy, or the contact declined the call. |
| `noAnswer` | Nobody answered in 30 s. |

A voicemail service answers the call like a person. The SDK reports `connected`, and the agent then speaks to the voicemail.

If the network drops for 2 seconds, the call goes to `reconnecting`. The event log shows `call: Call media is reconnecting.`

## Routing changes on your number

### What Start changes

| Item | Change |
| --- | --- |
| Callback URL of the selected number | Set to the tunnel URL. Saved first in `.sent-agent/routing-backup.json`. |
| Inbound calls to the number | Rejected until Stop restores the routing. |
| Callback secret | Not changed. The app reads it from the `POST /v3/channels/voice` response. |
| Other numbers | Not changed. |
| Number inventory | Not changed. The app does not buy numbers. |
| Recording | Not turned on. |

The routing backup has this content. It does not contain API keys.

```json
{
  "number": "+16285550199",
  "previousUrl": "https://hooks.example.com/voice",
  "installedUrl": "https://calm-fox-17.trycloudflare.com/voice/9c1e…a07f",
  "callbackSecret": "whsec_…",
  "createdAt": "2026-10-10T12:00:00.000Z"
}
```

### What Stop restores

1. The server reads the number's current callback URL from Sent.
2. If the URL is still the tunnel URL, the server sets the old URL again with `PATCH`.
3. If the URL is different, someone changed it outside the app. The server does not overwrite it. It shows a warning.
4. The server deletes the routing backup.
5. The server closes the tunnel.

If the number had no callback URL before Start, the server cannot restore "empty". It keeps the backup and shows a warning. After Stop, the tunnel is closed. So calls to the number fail with `callback_timeout` until you set a new callback URL in Sent. Then click **Forget routing backup**.

> [!WARNING]
> Do not delete `.sent-agent/` while a routing backup exists. The app needs the backup to restore your number. If you lose it, set the callback URL in Sent yourself.

### Recovery after a crash

1. Start the app again.
2. Connect the keys of the same Sent account.
3. Read the event log. Look for `Previous callback URL restored.` or `Previous routing is already restored.`

If the restore fails, the backup stays and the dashboard shows the error.

## Where to find logs

| Log | Where | What it shows | How long it stays |
| --- | --- | --- | --- |
| Status line | Dashboard, **Readiness** card | The current state, or the last error | Until the next change |
| Event log | Dashboard, **Local event log** | Setup, routing, call, outcome, and error events from the server and the browser | Server: last 150 events. Page: last 80 lines. |
| Transcript | Dashboard, **Transcript** panel | What the contact and the agent say | Until you reload the page |
| Terminal | The window where you ran `pnpm start` | Startup, environment key checks, and shutdown | Until you close it |
| Outcomes file | `.sent-agent/call-outcomes.jsonl` | The outcomes that the agent recorded | Until you delete it |
| Routing backup | `.sent-agent/routing-backup.json` | The routing that the app must restore | Until the app restores it |
| Call records | Sent API, `GET /v3/calls` | Status, failure reason, duration, and price of each call | Kept by Sent |
| Call webhooks | Your webhook endpoint | `call.initiated`, `call.answered`, `call.completed`, `call.failed` | Kept by your endpoint |
| Callback test result | Sent API, `POST /v3/channels/voice/{number}/test` | The exact request that the gateway got, and its answer | Not stored |
| SDK telemetry | Sent | Registration and call quality data from the browser | Kept by Sent. You cannot read it. |

### The event log

Each line has a time, a kind, and a text:

```text
2026-10-10T12:00:03.120Z  call: Outbound call call_8f2…: connectToNumber.
12:00:04                  voice: Browser voice registration is ready.
```

Lines from the server show the full UTC time. Lines from the browser show the local time. Use this to see where a line comes from.

The event log does not show transcripts. The **Transcript** panel shows them.

#### Lines from the server

| Kind | Example text | Meaning |
| --- | --- | --- |
| `status` | `Keys validated; active voice numbers loaded.` | The keys are correct. |
| `status` | `Checking gpt-realtime-2.1 voice-session access with gpt-live-transcribe input transcription.` | Start checks the model. |
| `status` | `Opening the callback-only tunnel and waiting until it is publicly reachable. No number routing changed yet.` | Start opens the tunnel. |
| `status` | `Agent stopped.` | Stop is complete. |
| `routing` | `Ready to place calls from +16285550199. Inbound calls to it are rejected until Stop. …` | The callback URL now points to the app. |
| `routing` | `Previous callback URL restored.` | Stop or recovery put the old callback URL back. |
| `routing` | `Previous routing is already restored.` | The number already had its old callback URL. |
| `routing` | `Forgot the routing backup for +16285550199. …` | You clicked **Forget routing backup**. The text shows the old URL. |
| `call` | `OpenAI voice connected; dialing +14155550123.` | The model is ready. The tab now asks Sent to dial. |
| `call` | `Outbound call call_…: connectToNumber.` | The gateway told Sent to dial the number. |
| `call` | `Outbound call call_…: reject.` | The gateway refused the call. See [How the gateway decides](#how-the-gateway-decides). |
| `call` | `Inbound call call_…: reject.` | Someone called your number. The agent does not take inbound calls. |
| `call` | `+14155550123 answered.` | The contact answered. Audio now goes to the model. |
| `call` | `The agent said goodbye and is ending the call.` | The agent used `end_call`. |
| `call` | `Ending the call after a long silence.` | Nobody spoke for 60 s. |
| `call` | `Nobody answered in time; ending the call attempt.` | 75 s passed from **Call** without an answer. |
| `call` | `The call reached the 5-minute limit.` | The call ended at the limit. |
| `call` | `Call media disconnected.` | The bridge for the call closed. |
| `outcome` | `+14155550123: callback_requested (call back: tomorrow at 10). Busy now; asked for a call tomorrow.` | The agent recorded an outcome. |
| `notice` | `OpenAI: …` | OpenAI sent an error that does not stop the call. |
| `notice` | `Tool record_outcome failed: …` | The outcome was not saved. The model knows this. |
| `notice` | `Reasoning backend unavailable: …` | The GPT-Live text helper failed. |
| `warning` | `Browser heartbeat lost; stopping and restoring routing.` | The tab stopped for 7 s. The server stops the agent. |
| `warning` | `The number callback changed outside this app. It was not overwritten.` | Someone changed the callback URL in Sent. |
| `warning` | `This number had no previous callback URL. …` | Stop cannot restore an empty callback URL. |
| `error` | `Routing restoration failed: …` | Stop could not restore the routing. The backup stays. |
| `error` | `OpenAI: …` | A fatal OpenAI error, for example `insufficient_quota`. The call ends. |
| `error` | Any other text | A dashboard request failed. The text is the error message. |

#### Lines from the browser

| Kind | Example text | Meaning |
| --- | --- | --- |
| `setup` | `Keys validated; active voice numbers were discovered.` | You connected the keys from the dashboard. |
| `routing` | `Temporary callback tunnel is prepared; current routing is unchanged.` | The tunnel is ready. Sent routing has not changed. |
| `routing` | `Routing activated after browser registration completed.` | Start is complete. |
| `routing` | `The local service is offline; browser voice registration was cleaned up.` | The server stopped by itself, for example after the watchdog. |
| `voice` | `Browser voice registration is ready.` | The SDK is `registered`. |
| `voice` | `… Retrying automatically; calls can't be placed until it reconnects.` | The SDK is `offline`. |
| `sdk warn` | Text from the SDK | A warning from `@sentdm/voice`. The SDK removes tokens from its messages. |
| `sdk error` | Text from the SDK | An error from `@sentdm/voice`. |
| `call` | `Ringing +14155550123.` | The contact's phone rings. |
| `call` | `+14155550123 picked up; connecting the audio.` | The contact answered. The agent starts to listen when the audio is connected. |
| `call` | `Call ended (busy).` | The SDK call ended. See [Call states in the SDK](#call-states-in-the-sdk). |
| `call` | `Call media is reconnecting.` | The call network dropped for 2 s. |
| `call` | `Enter the number in international format, for example +14155551234.` | The server refused the number. |
| `call` | Any other text | The SDK could not place the call, for example `CALL_IN_PROGRESS`. |
| `call` | `Rejected an incoming call: this agent only places calls.` | A call arrived at the tab. This is not expected, because the gateway never routes calls to the tab. |
| `model` | `The local model connection closed. Ending the provider call.` | The bridge closed during the call. |
| `model` | `OpenAI: …` | The same fatal error as the server `error` line. |
| `audio` | `Model audio queue exceeded its 120000 ms hard limit.` | The playback queue was full. The tab ended the call. |
| `audio` | `The Sent SDK did not take the software microphone…` | The tab ended the call to protect your room audio. |
| `error` | Any text | Start failed. The text is the reason. |

### The terminal

The server writes only a few lines to the terminal:

```text
Validating SENT_DM_API_KEY and OPENAI_API_KEY…
Environment keys validated.

Sent outbound agent
Open http://localhost:3000
Keys stay in this process. Keep the browser tab/computer awake.
Use Stop & restore before closing. Ctrl+C attempts routing restoration.
```

On **Ctrl+C**, it writes `Stopping and restoring routing…`. If the environment keys are not correct, it writes `Environment keys were not used: …`.

The event log is the main log. The terminal does not repeat it.

### Get more logs from the Sent SDK

The app sets the SDK log level to `warn`. It sends SDK warnings and errors to the event log, and it drops `info` and `debug` messages.

To see more:

1. Open `client/app.ts`.
2. Find `setupVoiceClient()`.
3. Change `logLevel` and the `logger`:

   ```ts
   const client = new SentVoice({
     tokenProvider: getVoiceToken,
     logLevel: 'debug',
     logger: { error: sdkLog('error'), warn: sdkLog('warn'), info: sdkLog('info'), debug: console.debug },
     serviceWorker: { url: '/sw.js', scope: '/' },
     audio: { element: dom.remoteAudio },
   });
   ```

4. Run `pnpm run build`.
5. Restart the server and reload the dashboard.

`info` messages go to the event log. `debug` messages go to the browser DevTools console, because there are many of them.

### Log call quality

The SDK can report poor network quality on a call. The app does not listen for this by default. To log it, add these lines to `bindCall()` in `client/app.ts`:

```ts
call.on('qualityWarning', ({ metric, cleared }) => {
  addEvent('call', `Call quality: ${metric} ${cleared ? 'recovered' : 'poor'}.`);
});
```

| Metric | Poor when |
| --- | --- |
| `jitter` | The incoming audio jitter is more than 30 ms in 3 of the last 4 samples. |
| `packetLoss` | More than 1% of incoming audio packets are lost in 3 of the last 4 samples. |
| `rtt` | The round-trip time is more than 300 ms. |

You can also call `call.getStats()` to read the jitter, packet loss, and round-trip time at any time.

### SDK telemetry

The SDK sends usage and call quality data to Sent. It uses the voice token to do this. This sample keeps telemetry on.

The data includes:

- The SDK version, the browser, the operating system, and the device type.
- How long registration took, and its errors.
- For each call: its ID, direction, result, connect time, length, and average quality values.
- The errors that the SDK reports.

The SDK does not add audio, phone numbers, or identities. Sent support can use this data to examine a problem. To turn it off, add `telemetry: { disabled: true }` to the `SentVoice` options in `client/app.ts`.

## Find a call in Sent

Sent keeps a record of each call. The record shows the final status, the failure reason, the duration, and the price.

### Read one call

1. In the event log, find the line `Outbound call call_…: connectToNumber.` or `… reject.`
2. Copy the `call_…` ID.
3. Set your Sent API key in your shell as `SENT_DM_API_KEY`.
4. Run this command:

   ```sh
   curl -s "https://api.sent.dm/v3/calls/call_8f2…" \
     -H "x-api-key: $SENT_DM_API_KEY" | jq .data
   ```

The response includes these fields. Your values are different.

```json
{
  "id": "call_8f2…",
  "direction": "outbound",
  "number": "+16285550199",
  "status": "COMPLETED",
  "failure_reason": null,
  "started_at": "2026-10-10T12:00:00Z",
  "answered_at": "2026-10-10T12:00:06Z",
  "ended_at": "2026-10-10T12:01:37Z",
  "duration_seconds": 91,
  "price": 0.0105,
  "recording_available": false,
  "timeline": [
    { "status": "INITIATED", "timestamp": "2026-10-10T12:00:00Z" },
    { "status": "COMPLETED", "timestamp": "2026-10-10T12:01:37Z" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `status` | `INITIATED`, `RINGING`, `ANSWERED`, `COMPLETED`, `FAILED`, `NO_ANSWER`, or `REJECTED` |
| `failure_reason` | Why the call failed. `null` while the call is live or when it completed. |
| `duration_seconds` | The billable length. `null` while the call is live. |
| `price` | The Sent charge. `null` until Sent prices the call. Sent charges only completed calls. |
| `timeline` | Each status change, oldest first. Only a single-call read includes it. |

### List recent calls

```sh
curl -s "https://api.sent.dm/v3/calls?direction=outbound&number=%2B16285550199&page_size=10" \
  -H "x-api-key: $SENT_DM_API_KEY" | jq .data
```

You can filter by `direction`, `status`, `number`, and start time (`from`, `to`). The newest calls come first. A page has 20 calls by default and 100 at most.

The callback test does not make a call record.

### Match the Sent result to the event log

| Sent `status` and `failure_reason` | Event log | Cause |
| --- | --- | --- |
| `COMPLETED` | `Outbound call call_…: connectToNumber.` and later `Call ended (completed).` | A normal call. |
| `NO_ANSWER` | `connectToNumber.` and later `Call ended (noAnswer).` | Nobody answered in 30 s. |
| `FAILED`, `rejected` | `Outbound call call_…: reject.` | The gateway refused the call. See [How the gateway decides](#how-the-gateway-decides). |
| `FAILED`, `rejected` | No `Outbound call` line | The gateway returned `400` or `401`. The callback path or the secret is wrong. |
| `FAILED`, `callback_timeout` | No `Outbound call` line | Sent could not reach the gateway. The tunnel is closed, the app is stopped, or the computer is asleep. |
| `FAILED`, `insufficient_balance` | No `Outbound call` line | Your Sent balance is zero or less. |
| `FAILED`, `destination_blocked` | Any | Sent does not allow calls to the country of the number. |
| `FAILED`, `caller_id_not_owned` | `connectToNumber.` | The caller ID is not a number of your account. This is not expected, because the app uses the selected number. |
| `FAILED`, `invalid_answer` | Any | Sent could not use the answer. This is not expected. |

For all failure reasons, see the [Sent error catalog](https://docs.sent.dm/reference/api/error-catalog).

### Receive call webhooks

Sent can send `call` events to a webhook endpoint. The app does not receive them. The gateway returns `404` for all paths except the callback path.

To watch call events:

1. Make a webhook endpoint that you control. A request inspection service is enough for tests.
2. In the [Sent dashboard](https://app.sent.dm/dashboard/webhooks), add the endpoint with the event type `call`.
3. Place a test call.

| Event | Extra fields |
| --- | --- |
| `call.initiated` | None. Sent sends it before its own checks, so a call that fails also gets it. |
| `call.answered` | None |
| `call.completed` | `duration_seconds`, and `price` when Sent has priced the call |
| `call.failed` | `reason` |

Each event has `payload.call_id`. This is the same `call_…` ID as in the event log. Sent does not guarantee the order of events. Remove duplicates with the `X-Webhook-Event-ID` header. `GET /v3/calls/{id}` is the source of truth.

### Test the callback yourself

The app tests the callback during Start. You can also run the test while the agent runs:

```sh
curl -s -X POST "https://api.sent.dm/v3/channels/voice/%2B16285550199/test" \
  -H "x-api-key: $SENT_DM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' | jq .data
```

Write the `+` in the number as `%2B`.

The test question looks like an outbound call from an app user to a phone number, with `test: true`. The response shows the request that the gateway got and the answer that it gave, with `callerId` filled in. Sent places no call, charges nothing, and stores nothing.

| `outcome` | Meaning |
| --- | --- |
| `ok` | The gateway answered correctly. |
| `timeout` | The gateway did not answer in time. |
| `connection_failed` | Sent could not connect to the tunnel URL. |
| `http_error` | The gateway returned an error status. A `401` means that the secret or the path is wrong. |
| `invalid_answer` | Sent could not use the answer. |

The gateway answers a test with `connectToNumber` to the test's number. It does not use or clear the pending dial, and it does not write to the event log.

If the test fails during Start, the dashboard shows `Sent callback test: <outcome>. <message>`. The app then restores the routing.

## Troubleshooting

### The contact's phone does not ring

1. Look in the event log for an `Outbound call call_…` line at the time of the call.
2. If there is a `reject` line, one of these is true:
   - More than 20 s passed between the `dialing` line and Sent's question.
   - The SDK is offline. The status line shows `Voice registration is offline and retrying…`.
   - The tab stopped sending heartbeats.
3. If there is a `connectToNumber` line, Sent tried to dial. [Read the call record](#read-one-call) and its `failure_reason`. Look for `destination_blocked` or `caller_id_not_owned`.
4. If there is no line, read the call record. Look for `insufficient_balance`, `destination_blocked`, or `callback_timeout`.
5. If the reason is `callback_timeout`, check the tunnel. Stop the agent, then start it again.

### The call ends at once

1. Look for `call: Call ended (…)` and `sdk error` lines from the browser.
2. If the state is `failed`, read the call record and its `failure_reason`.
3. If the state is `busy`, the line was busy or the contact declined.
4. If a `model` line comes first, the model connection failed. Look for `error` or `notice` lines from the server.
5. If the text is about the software microphone, check the `@sentdm/voice` version. The app needs the SDK to call `getUserMedia`.

### The phone keeps ringing after the contact declines

The dashboard shows the call states that the phone network reports. Many mobile networks do not report a declined call. They send it to voicemail, or they let it ring until the timeout. Then the call ends as `noAnswer` after 30 s, and the event log shows no `picked up` line.

If you see `picked up; connecting the audio.` but no `+1… answered.` line from the server, the phone answered but the call audio did not connect. Look for `sdk error` lines, and check your network.

### The contact answers, but hears nothing

1. Look for the `+1… answered.` line. Without it, the tab did not see the answer, and no audio goes to the model.
2. Look for an `error` line from the server with `OpenAI: …`.
3. Make sure that your OpenAI project can use the selected model.
4. Make sure that the computer does not sleep.

### The agent talks over the contact, or waits too long

The agent waits 3 s for the contact to speak first. The contact's first turn ends after 900 ms of silence, and later turns after 450 ms. Phone networks add delay, so these values can be wrong for your route. Change `DEFAULT_OPENING_WAIT_MS`, `FIRST_TURN_SILENCE_MS`, or `TURN_SILENCE_MS` in `src/openai.ts`, then run `pnpm run build`. See [The first words](./architecture.md#the-first-words).

### The agent talks to a voicemail or an announcement

The agent hears the audio only after the answer. A voicemail service, and some carrier announcements, answer the call like a person. The default instructions tell the agent to wait for the beep, leave one short message, and record `voicemail`. Test this on your own voicemail.

### Start fails

| Message | Cause | Fix |
| --- | --- | --- |
| `Sent callback test: http_error. …` | The gateway refused the test question. | Click **Start agent** again. |
| `Sent callback test: timeout. …` | Sent could not reach the tunnel in time. | Check your network. Try again. |
| `Sent callback test: invalid_answer. …` | Sent could not use the gateway's answer to its test question. | Read the test result with the command in [Test the callback yourself](#test-the-callback-yourself). |
| `A previous routing backup needs recovery before a new activation.` | A routing backup exists for a different number. | Set that number's callback URL in Sent. Then click **Forget routing backup**. |
| `Browser must be registered and the callback tunnel ready before activating.` | The SDK did not register. | Allow notifications. Reload the page. Try again. |
| `Selected number is no longer active.` | The number status changed in Sent. | Select a different number, or turn on voice for the number in Sent. |

### Sent error codes

| Code | Meaning | Fix |
| --- | --- | --- |
| `BUSINESS_023` | The account has no active voice number. | Turn on voice for a number in Sent. |
| `BUSINESS_024` | The number is not one of your active voice numbers. | Select a different number. |
| `VALIDATION_011` | The identity is not valid. | Do not change the identity format in `src/server.ts`. |
| `AUTH_001` | A voice token is not valid or has expired. | Stop the agent and start it again. The SDK then gets a new token. |

### SDK error codes when you click Call

| Code | Meaning | Fix |
| --- | --- | --- |
| `INVALID_ADDRESS` | The SDK did not accept the number. | Use international format. The app checks this first, so this is not expected. |
| `CALL_IN_PROGRESS` | The SDK already has a call. | Wait for the call to end, or click **Hang up**. |
| `NOT_REGISTERED` | The SDK is offline. | Wait until the status shows that registration is back. |

### Contact Sent support

Give Sent support:

- The `call_…` ID from the event log.
- The `X-Request-Id` from the callback test response (`data.request.headers`).
- The time of the call, in UTC.

## Related links

- [Sent voice SDK](https://docs.sent.dm/sdks/voice)
- [Answering calls](https://docs.sent.dm/start/guides/answering-calls)
- [Voice callback contract](https://docs.sent.dm/reference/api/voice-callback)
- [In-app calls and voice tokens](https://docs.sent.dm/start/guides/in-app-calls)
- [Managing calls](https://docs.sent.dm/start/guides/managing-calls)
- [Webhook event types](https://docs.sent.dm/start/webhooks/event-types)
- [Sent error catalog](https://docs.sent.dm/reference/api/error-catalog)
