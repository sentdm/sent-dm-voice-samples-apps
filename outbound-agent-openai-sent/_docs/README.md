# Outbound agent documentation

These documents help you run the outbound agent sample, understand it, and change it.

| Document | Read it to |
| --- | --- |
| [Setup](./setup.md) | Install the app, connect your keys, and place your first test call. |
| [Architecture](./architecture.md) | Learn the parts of the app and how a call moves through them. |
| [Models](./models.md) | Choose the voice, transcription, and helper models. See the defaults and the costs. |
| [Sent calls and logs](./sent-calls-and-logs.md) | Learn how Sent places a call for the app, and how to find a call in each log. |
| [How it works (animated)](./how-it-works.html) | Watch a call move through the system, one step at a time. |

## Recommended order

1. Read [Setup](./setup.md) and place one test call to your own phone.
2. Open the [animated walkthrough](./how-it-works.html).
3. Read [Sent calls and logs](./sent-calls-and-logs.md) before you change the dial rules or debug a call.

## Open the animated walkthrough

The walkthrough is one HTML file. It has no dependencies and needs no server. Open it from the sample folder:

| System | Command |
| --- | --- |
| macOS | `open _docs/how-it-works.html` |
| Windows | `start _docs\how-it-works.html` |
| Linux | `xdg-open _docs/how-it-works.html` |

Use the arrow keys to move between steps. Push the space bar to pause. Each step shows links to the source lines that it describes.

## Words used in these documents

These documents use each term with one meaning only.

| Term | Meaning |
| --- | --- |
| Agent | The OpenAI voice model that speaks on the call. |
| Contact | The person that the agent calls. |
| Dashboard | The page at `http://localhost:3000`. You control the app from it. |
| Management server | The local HTTP server for the dashboard, the keys, the voice tokens, and the bridge. Only your computer can reach it. |
| Gateway | The second local HTTP server. It receives the callback from Sent. The tunnel makes it public. |
| Tunnel | The Cloudflare quick tunnel. It gives the gateway a temporary public HTTPS address. |
| Callback URL | The URL that Sent asks what to do with each call on your number. Sent calls the request a "question". |
| Callback secret | The `whsec_…` key that Sent uses to sign each callback question. Each number has its own secret. |
| Identity | The name of the Sent app user that the browser tab registers as, for example `sent-ai-3fa9c1e07b2d`. |
| Voice token | A short-lived token. It lets the browser register as the identity, and it binds the identity to your number. |
| Pending dial | The one number that the dashboard asked to call. It is valid for 20 seconds and for one call. |
| Caller ID | The number that the contact's phone shows. It is the selected Sent number. |
| Software microphone | The audio stream that the app gives to the Sent SDK in place of your real microphone. The agent's voice goes into it. |
| Bridge | The WebSocket between the browser tab and the management server. It carries the call audio. |
| Routing backup | The file `.sent-agent/routing-backup.json`. It keeps the old callback URL of your number. |
| Outcome | The result of a call that the agent records, for example `callback_requested`. |
| Event log | The **Local event log** panel in the dashboard. |
| Call record | The record that Sent keeps for each call. You read it with `GET /v3/calls/{id}`. |
