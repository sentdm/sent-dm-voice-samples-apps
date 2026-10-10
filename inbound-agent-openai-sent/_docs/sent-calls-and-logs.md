# Sent calls and logs

This document describes how Sent sends a phone call to the inbound agent. It also shows where each part of a call is logged, and how to use the logs to find a problem.

- [What Sent does in this sample](#what-sent-does-in-this-sample)
- [The Sent API calls that the app makes](#the-sent-api-calls-that-the-app-makes)
- [The life of an inbound call](#the-life-of-an-inbound-call)
- [The callback question and answer](#the-callback-question-and-answer)
- [Identity, voice token, and registration](#identity-voice-token-and-registration)
- [Routing changes on your number](#routing-changes-on-your-number)
- [Where to find logs](#where-to-find-logs)
- [Find a call in Sent](#find-a-call-in-sent)
- [Troubleshooting](#troubleshooting)

## What Sent does in this sample

Sent does five jobs in each call:

1. Sent owns the phone number and receives the call.
2. Sent asks the number's callback URL what to do with the call.
3. Sent sends the call to the app user that the answer names. In this sample, the app user is the browser tab.
4. Sent carries the call audio between the phone and the browser. The SDK uses WebRTC for this.
5. Sent keeps a call record. It can also send `call` webhooks.

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

The browser SDK also sends requests to Sent. It registers the tab, receives calls by browser push, and sends [telemetry](#sdk-telemetry).

## The life of an inbound call

This table shows one call from start to end. It shows what Sent does, what the app does, and what you see in the event log.

| # | Sent | App | Event log |
| --- | --- | --- | --- |
| 1 | The caller dials your number. Sent makes a call record with an ID `call_…`. | — | — |
| 2 | Sent sends a signed `call.request` question to your callback URL. | The gateway checks the signature and the content. | — |
| 3 | — | The gateway answers `connectToUser` with the identity. It holds the agent for 20 s and pre-warms an OpenAI session. | `call: Inbound call call_…: connectToUser.` |
| 4 | Sent sends the call to the identity by browser push. | The SDK shows an incoming call. The tab opens the bridge. | — |
| 5 | — | The server gives the pre-warmed session to the bridge. | `call: OpenAI voice pre-warmed; waiting for phone media.` |
| 6 | Sent connects the phone and the browser. | The tab accepts the call. The agent says the greeting. | — |
| 7 | Sent carries the audio. | The agent and the caller speak. | `message: …` if the agent takes a message |
| 8 | The call ends. Sent sets the final status and the duration. | The tab closes the bridge. | `call: Call ended (completed).` and `call: Call media disconnected.` |

The `call_…` ID in step 3 is the ID that Sent uses for the call record. Use it to [find the call in Sent](#find-a-call-in-sent).

If the gateway rejects the call in step 3, the event log shows `call: Inbound call call_…: reject.`. Sent then ends the call with the status `FAILED` and the reason `rejected`.

## The callback question and answer

### The question

Sent sends a `POST` request to the callback URL. This is an example:

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
  "direction": "inbound",
  "from": { "kind": "number", "number": "+14155550123" },
  "to": { "kind": "number", "number": "+16285550199" }
}
```

On a retry, Sent also sends `X-Sent-Retry: 1`.

### How the gateway checks the question

The gateway does these checks in this order. It reads the JSON body only after the signature is correct.

1. The path must be the random callback path for this run. If not, the gateway returns `401`.
2. The gateway must have a callback secret for the number. If not, it returns `401`.
3. The timestamp must be within 5 minutes of the server clock. If not, it returns `401`.
4. The signature must match. The gateway removes `whsec_` from the secret and decodes the rest from base64. It calculates HMAC-SHA256 over `{id}.{timestamp}.{raw body}`. It compares the result in constant time with each `v1,` value in the header. If none match, it returns `401`.
5. The body must be valid JSON, with a `callId` of 100 characters or fewer and the selected `number`. If not, it returns `400`.

Sent does not retry a `4xx` response. It ends the call with the reason `rejected`. The gateway does not write a `400` or `401` to the event log.

### How the gateway decides

`decideInbound()` in `src/security.ts` makes the decision. The first rule that matches gives the answer.

| Rule | Answer |
| --- | --- |
| `type` is not `call.request`, `version` is not `1`, or `number` is not the selected number | `reject`, reason `declined` |
| `test` is `true` | `connectToUser`. A test never starts a call. |
| `direction` is not `inbound`, or `to` is not the selected number | `reject`, reason `declined` |
| The phase is not `answering`, the tab is not alive, or the SDK is not registered | `reject`, reason `busy` |
| A call is active, the tab has an incoming call, or a hold is active | `reject`, reason `busy` |
| All other questions | `connectToUser` with the identity |

The answer for "connect" is:

```json
{ "action": { "action": "connectToUser", "identity": "sent-ai-3fa9c1e07b2d" } }
```

The answer for "busy" is:

```json
{ "action": { "action": "reject", "reason": "busy" } }
```

The event log shows only the action, not the reason. To see the reason, check the dashboard status line at the time of the call.

The app does not place calls. An outbound question gets `reject` with reason `declined`.

### Why the gateway answers fast

Sent gives the callback 2.5 seconds for each attempt, and makes 2 attempts. A caller waits while the gateway decides. So the gateway:

- Decides from data in memory only. It makes no network calls before it answers.
- Starts the OpenAI pre-warm in the background. It does not wait for it.
- Keeps each answer for 15 seconds, by call ID. A retry of the same question gets the same answer.

### What Sent does with each result

| Gateway result | Sent call result |
| --- | --- |
| `200` with `connectToUser` | Sent sends the call to the identity. |
| `200` with `reject` | The call ends as `FAILED`, reason `rejected`. |
| `400` or `401` | The call ends as `FAILED`, reason `rejected`. Sent does not retry. |
| No answer in 2.5 s, two times | The call ends as `FAILED`, reason `callback_timeout`. |
| The number has no callback URL | The call ends as `FAILED`, reason `callback_not_configured`. |

## Identity, voice token, and registration

### Identity

The server makes a new identity each time it starts: `sent-ai-` and 12 hex characters. The dashboard shows it under **Identity**.

The callback answer names this identity. So only this browser tab gets the call. A new server start makes a new identity, so an old tab cannot get calls.

### Voice token

The SDK calls the token provider when it registers, and again before each token expires.

1. The tab sends `POST /api/voice-token` to the management server.
2. The server sends `POST /v3/channels/voice/tokens` to Sent, with the identity, the selected number, and `ttl: 600`.
3. The server gives the token to the SDK.

The token lasts 10 minutes. The SDK gets a new token at 80% of its life, which is after about 8 minutes. The voice token also binds the identity to the selected number.

### Registration and push

The SDK receives incoming calls by browser push. For this, the app serves the Sent service worker at `/sw.js`, and the browser must allow notifications.

The SDK client moves through these states:

| State | Meaning | What the app does |
| --- | --- | --- |
| `registering` | The SDK gets a token and registers. | Waits. |
| `registered` | The tab can receive calls. | Writes `voice: Browser voice registration is ready.` |
| `offline` | A token refresh failed. The SDK tries again about every 30 s. | Keeps the routing. New calls get `busy`. A call in progress continues. |
| `destroyed` | The app stopped the SDK. | This happens on Stop. |

Open only one dashboard tab. Tabs of one browser share a registration, so all of them ring.

### Call states in the SDK

An answered call ends with one of these states. The event log shows it as `call: Call ended (<state>).`

| State | Meaning |
| --- | --- |
| `completed` | The call ended normally. |
| `failed` | The call could not connect, or its connection was lost for more than 5 minutes. |
| `busy` | The other side declined the call. |
| `noAnswer` | Nobody answered. |

If the network drops for 2 seconds, the call goes to `reconnecting`. The event log shows `call: Call media is reconnecting.`

## Routing changes on your number

### What Start changes

| Item | Change |
| --- | --- |
| Callback URL of the selected number | Set to the tunnel URL. Saved first in `.sent-agent/routing-backup.json`. |
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
| Event log | Dashboard, **Local event log** | Setup, routing, call, and error events from the server and the browser | Server: last 150 events. Page: last 80 lines. |
| Transcript | Dashboard, **Transcript** panel | What the caller and the agent say | Until you reload the page |
| Terminal | The window where you ran `pnpm start` | Startup, environment key checks, and shutdown | Until you close it |
| Messages file | `.sent-agent/messages.jsonl` | Messages that the agent took | Until you delete it |
| Routing backup | `.sent-agent/routing-backup.json` | The routing that the app must restore | Until the app restores it |
| Call records | Sent API, `GET /v3/calls` | Status, failure reason, duration, and price of each call | Kept by Sent |
| Call webhooks | Your webhook endpoint | `call.initiated`, `call.answered`, `call.completed`, `call.failed` | Kept by your endpoint |
| Callback test result | Sent API, `POST /v3/channels/voice/{number}/test` | The exact request that the gateway got, and its answer | Not stored |
| SDK telemetry | Sent | Registration and call quality data from the browser | Kept by Sent. You cannot read it. |

### The event log

Each line has a time, a kind, and a text:

```text
2026-10-10T12:00:03.120Z  call: Inbound call call_8f2…: connectToUser.
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
| `routing` | `Answering incoming calls on +16285550199. Keep this tab and computer awake.` | The callback URL now points to the app. |
| `routing` | `Previous callback URL restored.` | Stop or recovery put the old callback URL back. |
| `routing` | `Previous routing is already restored.` | The number already had its old callback URL. |
| `routing` | `Forgot the routing backup for +16285550199. …` | You clicked **Forget routing backup**. The text shows the old URL. |
| `call` | `Inbound call call_…: connectToUser.` | The gateway sent the call to the tab. |
| `call` | `Inbound call call_…: reject.` | The gateway declined the call. |
| `call` | `OpenAI voice pre-warmed; waiting for phone media.` | The call uses the session that started early. |
| `call` | `OpenAI voice connected; waiting for phone media.` | The pre-warm was not available. The server opened a new session. |
| `call` | `The agent said goodbye and is ending the call.` | The agent used `end_call`. |
| `call` | `Ending the call after a long silence.` | Nobody spoke for 60 s. |
| `call` | `Call media disconnected.` | The bridge for the call closed. |
| `message` | `Ana (+14155550123): Please call me about WhatsApp pricing.` | The agent saved a message. |
| `notice` | `OpenAI: …` | OpenAI sent an error that does not stop the call. |
| `notice` | `Model pre-warm failed (…); connecting on answer instead.` | The early session failed. The call still works. |
| `notice` | `Tool take_message failed: …` | The message was not saved. The model knows this. |
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
| `routing` | `Inbound routing activated after browser registration completed.` | Start is complete. |
| `routing` | `The local service is offline; browser voice registration was cleaned up.` | The server stopped by itself, for example after the watchdog. |
| `voice` | `Browser voice registration is ready.` | The SDK is `registered`. |
| `voice` | `… Retrying automatically; new calls are declined until it reconnects.` | The SDK is `offline`. |
| `sdk warn` | Text from the SDK | A warning from `@sentdm/voice`. The SDK removes tokens from its messages. |
| `sdk error` | Text from the SDK | An error from `@sentdm/voice`. |
| `call` | `Rejected a second or unavailable inbound invite.` | A second call came while the tab was busy. |
| `call` | `Call media is reconnecting.` | The call network dropped for 2 s. |
| `call` | `Call ended (completed).` | The SDK call ended. See [Call states in the SDK](#call-states-in-the-sdk). |
| `model` | `The local model bridge did not become ready in time.` | The model was not ready in 20 s. The tab rejected the call. |
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

Sent inbound agent
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

1. In the event log, find the line `Inbound call call_…: connectToUser.` or `… reject.`
2. Copy the `call_…` ID.
3. Set your Sent API key in your shell as `SENT_DM_API_KEY`.
4. Run this command:

   ```sh
   curl -s "https://api.sent.dm/v3/calls/call_8f2…" \
     -H "x-api-key: $SENT_DM_API_KEY" | jq .data
   ```

The response has this shape. Your values are different.

```json
{
  "id": "call_8f2…",
  "direction": "inbound",
  "from": { "kind": "number", "value": "+14155550123" },
  "to": { "kind": "number", "value": "+16285550199" },
  "number": "+16285550199",
  "status": "COMPLETED",
  "failure_reason": null,
  "started_at": "2026-10-10T12:00:00Z",
  "answered_at": "2026-10-10T12:00:03Z",
  "ended_at": "2026-10-10T12:01:37Z",
  "duration_seconds": 94,
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
curl -s "https://api.sent.dm/v3/calls?direction=inbound&number=%2B16285550199&page_size=10" \
  -H "x-api-key: $SENT_DM_API_KEY" | jq .data
```

You can filter by `direction`, `status`, `number`, and start time (`from`, `to`). The newest calls come first. A page has 20 calls by default and 100 at most.

The callback test does not make a call record.

### Match the Sent result to the event log

| Sent `status` and `failure_reason` | Event log | Cause |
| --- | --- | --- |
| `COMPLETED` | `Inbound call call_…: connectToUser.` and later `Call ended (completed).` | A normal call. |
| `FAILED`, `rejected` | `Inbound call call_…: reject.` | The gateway answered `busy` or `declined`. See [How the gateway decides](#how-the-gateway-decides). |
| `FAILED`, `rejected` | No `Inbound call` line | The gateway returned `400` or `401`. The callback path or the secret is wrong. |
| `FAILED`, `callback_timeout` | No `Inbound call` line | Sent could not reach the gateway. The tunnel is closed, the app is stopped, or the computer is asleep. |
| `FAILED`, `callback_not_configured` | No line | The number has no callback URL. |
| `FAILED`, `invalid_answer` | Any | Sent could not use the answer. This sample sends fixed answers, so this is not expected. |

For all failure reasons, see the [Sent error catalog](https://docs.sent.dm/reference/api/error-catalog).

### Receive call webhooks

Sent can send `call` events to a webhook endpoint. The app does not receive them. The gateway returns `404` for all paths except the callback path.

To watch call events:

1. Make a webhook endpoint that you control. A request inspection service is enough for tests.
2. In the [Sent dashboard](https://app.sent.dm/dashboard/webhooks), add the endpoint with the event type `call`.
3. Make a test call.

| Event | Extra fields |
| --- | --- |
| `call.initiated` | None. Sent sends it before its own checks, so a call that fails also gets it. |
| `call.answered` | None |
| `call.completed` | `duration_seconds`, and `price` when Sent has priced the call |
| `call.failed` | `reason` |

Each event has `payload.call_id`. This is the same `call_…` ID as in the event log. Sent does not guarantee the order of events. Remove duplicates with the `X-Webhook-Event-ID` header. `GET /v3/calls/{id}` is the source of truth.

### Test the callback yourself

The app tests the callback during Start. You can also run the test while the agent answers:

```sh
curl -s -X POST "https://api.sent.dm/v3/channels/voice/%2B16285550199/test" \
  -H "x-api-key: $SENT_DM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' | jq .data
```

Write the `+` in the number as `%2B`.

The response shows the request that the gateway got and the answer that it gave. Sent places no call, charges nothing, and stores nothing.

| `outcome` | Meaning |
| --- | --- |
| `ok` | The gateway answered correctly. |
| `timeout` | The gateway did not answer in time. |
| `connection_failed` | Sent could not connect to the tunnel URL. |
| `http_error` | The gateway returned an error status. A `401` means that the secret or the path is wrong. |
| `invalid_answer` | Sent could not use the answer. |

The gateway answers a test with `connectToUser`, but it does not start a call. It does not hold the agent, does not pre-warm a session, and does not write to the event log.

If the test fails during Start, the dashboard shows `Sent callback test: <outcome>. <message>`. The app then restores the routing.

## Troubleshooting

### The caller hears a busy or error tone

1. Look in the event log for an `Inbound call call_…` line at the time of the call.
2. If there is a `reject` line, read the status line. One of these is true:
   - The SDK is offline. The status line shows `Voice registration is offline and retrying…`.
   - The tab stopped sending heartbeats.
   - A different call was active or on hold.
3. If there is no line, [read the call record](#read-one-call) and its `failure_reason`.
4. If the reason is `callback_timeout`, check the tunnel. Stop the agent, then start it again.
5. If the reason is `rejected`, the gateway refused the question. Stop the agent, then start it again. This makes a new callback path and reads the secret again.

### The gateway connects the call, but the tab does not ring

1. Make sure that the browser allows notifications for `localhost:3000`.
2. Look for `sdk warn` or `sdk error` lines in the event log.
3. Make sure that only one dashboard tab is open.
4. Make sure that you do not use private browsing. Private windows can block service workers and push.

The hold on the agent stops after 20 s. Then the next call can connect.

### The tab rings, but the call ends at once

1. Look for `model` lines in the event log.
2. If the text is `The local model bridge did not become ready in time.`, OpenAI was slow or failed. Look for `error` or `notice` lines from the server.
3. If the text is about the software microphone, check the `@sentdm/voice` version. The app needs the SDK to call `getUserMedia`.

### The call connects, but the caller hears nothing

1. Look for an `error` line from the server with `OpenAI: …`.
2. Look for `notice` lines.
3. Make sure that your OpenAI project can use the selected model.
4. Make sure that the computer does not sleep.

### Start fails

| Message | Cause | Fix |
| --- | --- | --- |
| `Sent callback test: http_error. …` | The gateway refused the test question. | Click **Start answering** again. |
| `Sent callback test: timeout. …` | Sent could not reach the tunnel in time. | Check your network. Try again. |
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
