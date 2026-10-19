# Sent API and logs

This document lists every Sent API call that the app makes, and shows how to find a message or a call in Sent. It ends with fixes for common problems.

The server calls Sent through the official TypeScript SDK, `@sentdm/sentdm` (`server/sent.ts`). The phone tab uses the Sent voice SDK, `@sentdm/voice` (`lib/live/phone.ts`).

## The Sent API calls that the app makes

| When | SDK method | Endpoint | What for |
| --- | --- | --- | --- |
| Connect | `channels.voice.list` | `GET /v3/channels/voice` | Lists your voice numbers. |
| Connect, Start | `templates.list` | `GET /v3/templates?status=APPROVED` | Loads your approved templates. Sent's keyword auto-replies are left out. |
| Connect | `conversations.list` | `GET /v3/conversations` | Imports your newest 1,000 messages. |
| Start | `channels.voice.retrieve` | `GET /v3/channels/voice/{number}` | Reads the number's callback URL for the routing backup. |
| Start | `channels.voice.create` | `POST /v3/channels/voice` | Points the number's callback URL at the tunnel. Returns the callback secret. |
| Start | `webhooks.create` | `POST /v3/webhooks` | Subscribes to message events and call failures. Returns the webhook's signing secret. |
| Start | `channels.voice.test` | `POST /v3/channels/voice/{number}/test` | Sends a signed test question through the tunnel. |
| Start, then each time the voice SDK asks for one | `channels.voice.createToken` | `POST /v3/channels/voice/tokens` | A voice token for the phone tab's identity, valid for 600 s. |
| Each text or template | `messages.send` | `POST /v3/messages` | Sends to one contact, with an `Idempotency-Key`. |
| Stop | `webhooks.delete` | `DELETE /v3/webhooks/{id}` | Deletes the webhook. |
| Stop | `channels.voice.update` | `PATCH /v3/channels/voice/{number}` | Restores the old callback URL. |

Calls themselves don't use the REST API. The phone tab places them with the voice SDK's `connect({ to })`, and Sent asks the gateway what to do. The inbound and outbound samples explain this flow in their [Sent calls and logs](../../outbound-agent-openai-sent/_docs/sent-calls-and-logs.md) document.

## What a send contains

| Field | When |
| --- | --- |
| `to` | Always: the contact's number. |
| `text` or `template` | Free text, or an approved template with its variables. |
| `channel` | Only when the agent or a person chose one. Otherwise Sent's routing picks. |
| `channels` | Never. |

`channels` names the senders that a message may go out from. The app never sets it, because a sender serves only some countries. For example, a US number can't text a contact in Kosovo: a send pinned to it fails with `DELIVERY_003`. Without `channels`, Sent's routing picks a sender that serves the contact's country, such as an alphanumeric sender registered for that country.

> [!NOTE]
> Alphanumeric senders can't receive replies. A contact who gets a text from one can't reply to it, so a two-way conversation needs a sender that is a phone number.

## Webhooks

Start creates one webhook, named "Sent chat + voice sample (local)", and Stop deletes it.

| Events | What the app does |
| --- | --- |
| `message.received` | Adds the text to the contact's conversation, and runs the agent. See [Architecture](./architecture.md#a-text-from-a-contact). |
| `message.sent`, `delivered`, `read`, `failed`, `blocked`, `filtered` | Updates the message's status, channel, and, for a template, the rendered text. |
| `call.failed` | Shows Sent's reason on the call card. |

The webhook gets every inbound text on your Sent account, not only texts to the selected number. Use **Only these numbers** while you test on an account with real customers.

### Signatures

Sent signs each webhook and each voice question the same way. The gateway checks it before it reads the body (`verifySentSignature()` in `server/security.ts`):

1. It reads `x-webhook-id`, `x-webhook-timestamp`, and `x-webhook-signature`.
2. It refuses a timestamp more than 5 minutes from now.
3. It computes HMAC-SHA256 over `{id}.{timestamp}.{body}`, with the key in the secret: the part after `whsec_`, base64-decoded.
4. It compares the result with each `v1,<base64>` value in the signature header, in constant time.

Voice questions use the callback secret. Webhooks use the webhook's signing secret.

The gateway answers `200` at once, then handles the event. Sent retries a failed delivery with the same `x-webhook-event-id`, and the app ignores an event id it has seen.

## Message statuses

| Sent status | The console shows |
| --- | --- |
| `QUEUED`, `PROCESSED`, `ROUTED` | **Sending**, and **Sent routing** until Sent reports the channel |
| `SENT` | **Sent** |
| `DELIVERED` | **Delivered** |
| `READ` | **Read** (WhatsApp and RCS) |
| `FAILED`, `BLOCKED`, `FILTERED` | **Not delivered**, with Sent's reason under the message |

| Reason code | Meaning | What to do |
| --- | --- | --- |
| `DELIVERY_003` | The account has no sender for this destination on this channel. | Add a sender for the contact's country in Sent, or let Sent pick the channel. |
| `CONVERSATION_TEMPLATE_REQUIRED` | Free text to a contact who hasn't replied, and no template in the last 7 days. | Send an approved template. The app checks this first, so you see it only if the state changed. |
| `WHATSAPP_TEMPLATE_REQUIRED` | Free text pinned to WhatsApp outside its 24-hour window. | Send a template, or let Sent pick the channel. |

## Call failure reasons

When a call ends without completing, Sent records why as `failure_reason` on the call record, and in the `call.failed` webhook.

| Reason | Meaning | The call card shows |
| --- | --- | --- |
| `destination_blocked` | Sent doesn't allow calls to the contact's country on your account. Refused before Sent asks the gateway. | Sent doesn't allow calls to this country on your account. Ask support@sent.dm to allow it. |
| `insufficient_balance` | Your balance was zero or less. | Your Sent balance is too low to place calls. |
| `invalid_answer` | Sent couldn't use the gateway's answer. | Sent couldn't use the app's answer, for example a dial to a blocked country. |
| `callback_timeout` | Sent couldn't reach the gateway in time. | Sent couldn't reach the app in time to ask about the call. |
| `callback_not_configured` | The number has no callback URL. | The number has no callback URL. |
| `rejected` | The gateway declined the call, or the phone was busy. | The call was declined, or the line was busy. |
| `no_answer` | The phone didn't pick up. | No answer. |

Without a Sent reason, the card shows how the voice SDK ended the call, for example `The call failed (failed: CALL_FAILED The call could not be connected.).`

## Where to find logs

| Where | What you find |
| --- | --- |
| The thread | Each message's status and reason. Each call's outcome, summary, and transcript. |
| **Agent activity** (right panel) | Every tool the agent used, with the details. |
| Notices (top of the console) | Errors from Sent and OpenAI, and requests for a person. |
| The terminal | One line for each call question, and for each call failure. See below. |
| The phone tab's browser console | Warnings and errors from the voice SDK, starting with `Sent voice SDK`. |
| `.sent-agent/conversations.json` | Each message's Sent id (`sentId`) and each call's Sent id (`sentCallId`). |

The terminal lines look like this:

```text
[call] Sent asked about an outbound call to +1415•••42; the app answered connectToNumber.
[call] Sent asked about an inbound call from +1415•••42; the app answered connectToUser.
[call] Sent reports call call_08d4… failed: destination_blocked.
```

If you click **Call** and no `Sent asked about an outbound call` line appears, Sent refused the call before it asked the app.

## Find a message, a call, or a webhook delivery in Sent

Set your key in the shell first: `export SENT_DM_API_KEY=…`.

| To see | Run |
| --- | --- |
| A message | `curl -s https://api.sent.dm/v3/messages/MESSAGE_ID -H "x-api-key: $SENT_DM_API_KEY"` |
| Each step of a message, and the sender used (`from`) | `curl -s https://api.sent.dm/v3/messages/MESSAGE_ID/activities -H "x-api-key: $SENT_DM_API_KEY"` |
| Your recent calls | `curl -s "https://api.sent.dm/v3/calls?page_size=10" -H "x-api-key: $SENT_DM_API_KEY"` |
| One call, with its timeline | `curl -s https://api.sent.dm/v3/calls/CALL_ID -H "x-api-key: $SENT_DM_API_KEY"` |
| Your senders, by channel and country | `curl -s https://api.sent.dm/v3/channels -H "x-api-key: $SENT_DM_API_KEY"` |
| What Sent posted to the webhook, and what the app answered | `curl -s https://api.sent.dm/v3/webhooks/WEBHOOK_ID/events -H "x-api-key: $SENT_DM_API_KEY"` |

While the agent is on, the webhook's id is `webhookId` in `.sent-agent/backup.json`.

## Troubleshooting

### A text is not delivered

1. Read the reason under the message. See [Message statuses](#message-statuses).
2. Read the message's activities. Without a `ROUTED` step, Sent found no sender for the contact.
3. List your senders. Check that one serves the contact's country on the channel used.
4. If you chose a channel in the composer, choose **Sent picks** and try again.

### Calls stop at INITIATED

**Signs:** a few seconds after **Call**, the call card shows `The call failed (failed: CALL_FAILED The call could not be connected.).` Sent's call record stays at `INITIATED`. The terminal shows no `Sent asked about an outbound call` line.

**Cause:** Sent doesn't allow calls to the contact's country on your account. Sent refuses such a call before it asks the gateway.

**What to do:**

1. Call a number in a country you can call, for example your own number, to check the rest of the path.
2. Ask support@sent.dm to allow calls to the country.

### The agent doesn't reply

| Check | Why |
| --- | --- |
| The status shows **Agent on**. | The agent replies only while it runs. Texts that arrive while it's off don't reach the app. |
| **Only these numbers** is empty or lists the contact. | Otherwise the agent leaves the contact alone. |
| The contact didn't text STOP. | The composer says so when they did. |
| The conversation shows **Agent replies**. | While a person owns it, the agent writes drafts instead. |
| Free text is allowed, or a utility template fits. | Otherwise the agent answers nothing. |
| No OpenAI error in the notices. | A wrong model or a billing problem stops the replies. |

### Inbound calls don't ring

| Check | Why |
| --- | --- |
| The status shows **Agent on**, and the phone tab is open. | Start routes your number to the app, and calls ring in the phone tab. |
| No other call is in progress. | A second caller hears busy. |
| **Only these numbers** is empty or lists the caller. | Otherwise the gateway answers busy. |
| Notifications are allowed for `localhost:3000`. | Sent uses them to ring the tab. |

### Start fails

| Step | Usual cause |
| --- | --- |
| Checking access to the voice model | Your OpenAI project can't use the model. |
| Opening the public tunnel | ngrok has no authtoken or rejects it, or your ngrok account has 3 agent sessions online. Or a firewall or a VPN blocks ngrok, or Cloudflare with `TUNNEL_PROVIDER=cloudflare`. See [Setup problems](./setup.md#setup-problems). |
| Registering this tab with Sent | Notifications are blocked, or the key can't create voice tokens. |
| Routing calls to this app | The number isn't active anymore. |
| Subscribing to messages | The key can't create webhooks. |
| Testing the call path | Sent couldn't reach the tunnel. Try again. |

### The phone tab is offline

The status shows **Phone tab offline** when the tab stops sending heartbeats. After 7 seconds the agent stops and your number's routing goes back. Keep the tab open, and the computer awake. A tab in the background keeps working.

### Contact Sent support

Write to support@sent.dm. Include the message ids or call ids, the time, and the reason codes. Never send your API key.

## Related links

- [Sent voice callback reference](https://docs.sent.dm/reference/api/voice-callback)
- [Sent error catalog and call failure reasons](https://docs.sent.dm/reference/api/error-catalog)
- [Sent webhook signature verification](https://docs.sent.dm/build/signature-verification)
- [Sent channel routing](https://docs.sent.dm/reference/channel-routing)
- [In-app calls and voice tokens](https://docs.sent.dm/start/guides/in-app-calls)
