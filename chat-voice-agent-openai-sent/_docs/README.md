# Chat + voice agent documentation

These documents help you run the chat + voice agent sample, understand it, and change it.

| Document | Read it to |
| --- | --- |
| [Setup](./setup.md) | Install the app, connect your keys, and run your first text, call, and campaign tests. |
| [Architecture](./architecture.md) | Learn the parts of the app, and how texts, calls, and campaigns move through them. |
| [The agent](./agent.md) | Learn what the agent sees, which tools it has, and how it chooses channels, templates, and calls. |
| [Models](./models.md) | See the OpenAI models the app uses, the defaults, and how to add a model. |
| [Sent API and logs](./sent-api-and-logs.md) | See every Sent API call the app makes, find a message or a call in Sent, and fix common problems. |

## Recommended order

1. Read [Setup](./setup.md). Text your Sent number from your own phone, then ask the agent to call you.
2. Read [The agent](./agent.md) before you change the instructions or the call rules.
3. Read [Sent API and logs](./sent-api-and-logs.md) when a message or a call doesn't do what you expect.

## Words used in these documents

These documents use each term with one meaning only.

| Term | Meaning |
| --- | --- |
| Agent | The OpenAI models that text and talk with contacts: the text agent and the voice agent. |
| Contact | A person you text or call. Each contact has one conversation. |
| Conversation | All texts and calls with one contact, on every channel. |
| Console | The page at `http://localhost:3000`. You control the app from it. |
| Phone tab | The browser tab that clicked **Start agent**. It registers with Sent as an app user. Calls ring there, and a person talks from there. |
| Management server | The local server for the console, the API (`/api`), and the two WebSockets (`/ws`, `/bridge`). Only your computer can reach it. |
| Gateway | The second local server. It receives Sent's voice questions and message webhooks. The tunnel makes it public. |
| Tunnel | The public tunnel: ngrok by default, or a Cloudflare quick tunnel with `TUNNEL_PROVIDER=cloudflare`. It gives the gateway a public HTTPS address while the agent is on. |
| Callback URL | The URL that Sent asks what to do with each call on your number. Sent calls the request a "question". |
| Webhook | The endpoint that Start registers with Sent. Sent posts message events and call failures to it. |
| Signing secret | A `whsec_…` key. Sent signs each voice question and each webhook with one. The callback and the webhook have different secrets. |
| Routing | Sent's choice of the channel and the sender for a message. The app never chooses the sender. |
| Free-text window | The time when Sent delivers free-form text to a contact. Outside it, only a template goes out. |
| Template | A message approved in Sent, with named variables. |
| Proposal | A request from the agent in the thread: to call the contact, or to bring in a person. |
| Handover | A person takes a conversation or a call from the agent. |
| Consent | The contact asked for a call or agreed to one. No one calls a contact without it. |
| Campaign | One template sent to a list of contacts. The agent then handles the replies and calls. |
| Scenario | What the agent must achieve with a campaign's contacts, in your words. |
| Callback queue | Callbacks the agent promised while another call was on the line. |
| Only these numbers | A setting. While it lists numbers, the agent acts only for them. Use it to test on an account with real customers. |
| Routing backup | The file `.sent-agent/backup.json`. It keeps what Start changed in Sent, so Stop can put it back. |
