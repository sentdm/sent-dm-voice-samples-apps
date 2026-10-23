# Sent voice feature tour

A reference app that covers each Sent voice capability. It has two sides:

- **A browser phone** on [`@sentdm/voice`](https://docs.sent.dm/sdks/voice), Sent's browser voice SDK: register, place and
  receive calls, mute, DTMF, devices, call quality, conference rooms, and the API commands the SDK
  leaves to your backend (participants, transfer, recording, hangup).
- **The customer backend**, as Next.js route handlers: it mints voice tokens, answers the questions Sent
  asks about every call, receives call webhooks, relays SDK telemetry, and proxies every public voice
  API call so you can try them from the console.

Everything is real: every button places a real call or makes a real request to the Sent API and shows
the real response. Nothing is simulated.

## What you need

- [Node.js](https://nodejs.org/) 22 or newer and [pnpm](https://pnpm.io/installation).
- A Sent account with Voice enabled, and an API key from the dashboard (API keys page).
- A number on your account. The setup screen turns phone calls on for it and points it at this app.
- A free [ngrok](https://ngrok.com) account. Sent only calls public URLs, so the app opens an ngrok tunnel
  to itself when it starts. Put the authtoken in `NGROK_AUTHTOKEN` in `.env`, or save it one time with
  `ngrok config add-authtoken`. For a Cloudflare quick tunnel, which needs no account, set
  `TUNNEL_PROVIDER=cloudflare`.
- A positive balance for calls that reach a phone. App-to-app calls are free.

## Quick start

```sh
pnpm install
cp .env.example .env   # set NGROK_AUTHTOKEN, unless the ngrok CLI has it already
pnpm dev
```

1. Open http://localhost:3000. The setup screen shows the public URL once the tunnel is open, after a few
   seconds.
2. Enter the API key and press **Connect**. It checks the key with `GET /v3/me` and lists your voice
   numbers with `GET /v3/channels/voice`. Nothing is saved yet.
3. Pick the number and press **Route to this app**. It sets the number's callback URL to
   `https://<public URL>/api/voice/callback` with `POST /v3/channels/voice` and fills in the callback
   signing secret Sent returns. Then press **Save**.
4. On the Phone screen pick an identity, for example `agent-1`, and press **Go online**. Allow
   notifications and the microphone.
5. Open the public URL on a second computer or a phone, pick `agent-2`, go online, and call `agent-1`
   from the dialer. Or dial a phone number, or call your voice number from a phone. On a free ngrok
   account, the browser first shows an ngrok warning page: press **Visit Site**.

The tunnel gets a new URL each time the app starts. After a restart the header shows **Public URL
changed**: on the setup screen press **Route to this app** and **Save** again. Save also moves the webhook
subscription to the new URL with `PUT /v3/webhooks/{id}`. To keep one URL, set `NGROK_DOMAIN` in `.env` to
your free ngrok dev domain from the [ngrok dashboard](https://dashboard.ngrok.com/domains). Or set
`PUBLIC_BASE_URL` to a tunnel of your own; the app then opens no tunnel.

Before the first call, press **Send a test question** in the console's callback studio. It calls
`POST /v3/channels/voice/{number}/test`, which makes Sent send a signed synthetic question to the app and
report the verdict, and it warms the callback route in the development server.

## How the pieces fit

```
Browser (identity agent-1) ─┐                     ┌─> Sent API: tokens, calls, participants, webhooks
Browser (identity agent-2)  ├─> this app's server ┤
Phone browser (tunnel URL)  ┘   (Next.js routes)  └─< Sent asks /api/voice/callback, delivers /api/sent/webhooks
```

**Tokens.** The SDK's `tokenProvider` calls `POST /api/voice/token`. The server holds the API key, calls
`POST /v3/channels/voice/tokens` with the identity and the configured number, and returns the token as
text. The SDK refreshes it before it expires by calling `tokenProvider` again.

**Questions and answers.** When a call starts, Sent POSTs a `call.request` to the number's callback URL
and waits at most 2.5 seconds for the answer. The server verifies the signature, decides with the rules
from the routing panel, and answers with an action and optional instructions:

```json
{
  "instructions": [{ "instruction": "say", "text": "Connecting you" }],
  "action": { "action": "connectToUser", "identity": "agent-1" }
}
```

Actions: `connectToUser`, `connectToNumber`, `connectToConference`, `playMenu`, `park`, `hangup`,
`reject`. Instructions: `say`, `play`, `sendDigits`, `answer`, `setCookie`, `startRecording`,
`stopRecording`. Menu keypresses come back as `call.input` questions. See `lib/server/routing.ts`.

**Signature verification.** Questions and webhooks carry `X-Webhook-ID`, `X-Webhook-Timestamp` and
`X-Webhook-Signature`. The signature is `v1,` plus the Base64 HMAC-SHA256 of `{id}.{timestamp}.{body}`,
keyed with the Base64-decoded secret after its `whsec_` prefix: the number's callback secret for a
question, the webhook's signing secret for a delivery. `X-Webhook-ID` is the id of the configuration that
signed the request, the voice number's row or the webhook. One function, `lib/server/signature.ts`,
verifies both. A request that does not verify is refused with 401.

**Presence.** Each browser sends a heartbeat while registered. The default routing rings the app user when
online and falls back to a phone number otherwise. This is the customer backend's own knowledge, not
something Sent stores.

**Call ids.** The SDK's `call.id` is not Sent's `call_` id. Sent's id arrives with the question, so the
server keeps a map from identities to calls and hands the phone screen the id it needs for the API
commands.

**Webhooks.** The Webhooks tab creates a subscription on the `call` group pointing at
`/api/sent/webhooks` and stores the secret from the response. Deliveries of `call.initiated`,
`call.answered`, `call.completed`, `call.failed` and `call.recording_ready` are verified and listed. Their
payload carries `account_id`, `call_id`, `channel`, `number`, `status` (upper-case) and `updated_at`,
plus `recording_id` on `call.recording_ready`.

**Telemetry.** The SDK reports usage and call quality to Sent. The phone screen's developer options can
set the SDK's telemetry base URL to `/api/telemetry-relay` on this app. The relay records each batch for
the Telemetry tab and forwards it unchanged, with the same bearer token, to Sent, which answers 202. The
token route remembers which identity each token belongs to, so every batch shows its app user.

## What the SDK leaves to the API, and where it is here

| Capability | How this example offers it |
|---|---|
| Add, mute, remove participants | Participants panel on a call in a room, the call log, the explorer. Uses `POST /v3/calls/{id}/participants`, `PATCH .../participants/{id}` with `muted`, `DELETE .../participants/{id}` |
| Transfer | Transfer form on a call in a room: the server dials the target into the room, waits for the roster, then removes your leg (`lib/server/transfer.ts`) |
| Hold | The `park` action: park mode in the routing panel, or a menu key |
| Recording | `record: true` on connect answers, `startRecording` instruction, `POST /v3/calls/{id}/recordings`, the `call.recording_ready` webhook and `GET .../recordings`, which lists the call's recordings |
| Hang up from the server | `POST /v3/calls/{id}/hangup` from the active call card and the call log |
| Room per call | Routing option: every call is answered into a room named after it and the other party is dialed in, so participants and transfer work on every call, not only on room joins |

A call that is a direct connection has no room, so participants and transfer answer 409 until it is in
one. That is a rule of the platform, and the app says so where it applies.

## Screens

- **Phone**: registration state and token expiry, dialer (number, identity, room), incoming call with
  ringtone, active call with mute, DTMF, live stats, quality warnings, reconnect state, the API commands,
  the participants and transfer panel, audio devices, developer options (token TTL, log level, retries,
  telemetry) and an event log of every SDK event.
- **Console**: API explorer for every voice and webhook endpoint, callback studio with the routing panel
  and the test button, webhooks subscription and inbox, telemetry feed, call log with the call commands.
- **Setup**: API base URL, API key, Connect, the number and its secret, and the public URL.

## Configuration and data

- `.data/config.json` holds the configuration from the setup screen, including the API key and the
  secrets. It is git-ignored. `DATA_DIR` moves it.
- `.data/routing.json` holds the routing rules.
- `TUNNEL_PROVIDER` selects the tunnel the app opens: `ngrok` (the default) or `cloudflare`.
- `NGROK_AUTHTOKEN` is the ngrok authtoken. Without it, the app uses the token that
  `ngrok config add-authtoken` saved. `NGROK_DOMAIN` keeps one ngrok URL on every start.
- `PUBLIC_BASE_URL`, when set, is the app's fixed public URL, and the app opens no tunnel.
- `SETUP_PASSWORD`, when set, protects the setup screen, the routing rules, the webhook subscription and
  the API explorer's changes to webhooks and numbers. The app has no login otherwise. Anyone with the
  public URL can open it, so keep the URL private and stop the app when you are done.
- `public/sw.js` is the service worker from `@sentdm/voice`. `pnpm dev` and `pnpm build` copy it from the
  installed SDK, so it is not committed.

## Troubleshooting

- **The setup screen shows a tunnel error.** The message tells you what to do. Usually ngrok has no
  authtoken: set `NGROK_AUTHTOKEN` and restart. A free ngrok account allows 3 agent sessions at a time,
  so stop other ngrok agents or apps. If the network blocks one provider, set `TUNNEL_PROVIDER` to the
  other, or set `PUBLIC_BASE_URL` to a tunnel of your own, and restart.
- **A request fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` or another certificate error.** Antivirus
  HTTPS scanning or a company proxy replaces HTTPS certificates. The app trusts the system certificate
  store on Node.js 22.19 or later, so update Node.js. If the error continues, export the root certificate
  of the scanner or proxy as a Base-64 (PEM) file. Set `NODE_EXTRA_CA_CERTS` to its path in your shell,
  not in `.env`, and restart.
- **A browser shows an ngrok warning page.** Free ngrok accounts show it to browsers on each new
  domain. Press **Visit Site**. Sent's questions and webhooks do not get this page.
- **The first call fails with `callback_timeout`.** The development server compiles a route on its first
  request. Press the test button in the callback studio before the first call.
- **Questions arrive with `signature invalid`.** The secret on the setup screen is not the number's
  current one: it was rotated in the dashboard or with `POST /v3/channels/voice/{number}/rotate-secret`.
  Paste the new one.
- **Calls end with `callback_not_configured`, or never reach the app.** The number has no callback URL, or
  it still points at an old public URL. Press **Route to this app** on the setup screen.
- **`register()` fails.** Notifications were denied, or the page is not on `localhost` or HTTPS. Incoming
  calls need both.
- **Participants answer 409.** The call is not in a room. Join a room, or turn on room per call.
- **A phone leg fails with `insufficient_balance` or `destination_blocked`.** The account needs balance,
  or the destination country is blocked for the account.
- **Deliveries stop arriving.** A receiver that keeps refusing deliveries gets its subscription disabled
  by Sent. Check the inbox for red rows, fix the secret, and enable the webhook again from the explorer.

## Development

```sh
pnpm check    # route types, type check, lint
pnpm format   # Prettier
```

The phone screen loads with `ssr: false` (`app/phone/page.tsx`). The SDK only runs in the browser, so
the server never renders or bundles it. `instrumentation.ts` opens the tunnel when the server starts, and
`lib/server/tunnel.ts` waits until the public URL serves the app before the setup screen shows it.

## License

MIT, see the [root LICENSE](../LICENSE). Use of the Sent API is subject to [Sent's terms](https://sent.dm/en/legal).
