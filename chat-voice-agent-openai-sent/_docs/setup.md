# Setup

This guide shows how to install the chat + voice agent, connect your keys, and run your first tests: a text, a call, and a small campaign.

The app runs on your computer. A Node.js server and one browser tab do all the work. There is no hosted backend.

## What you need

| Item | Notes |
| --- | --- |
| A Sent account with messaging and voice | Sent must turn on phone calls for your account. To ask for it, write to support@sent.dm. |
| Sent balance | Sent charges each message, and each call to a phone by the minute at the destination's rate. |
| An active Sent voice number | Calls come in and go out on it. The app never buys a number. Use a test number if you can. |
| An SMS sender for your contacts' countries | Sent's routing picks the sender for each text. A contact in a country with no sender gets no text. |
| An approved template | Needed to text someone who hasn't written to you, and for every campaign. |
| A Sent API key | The key needs voice numbers, messages, templates, conversations, and webhooks. |
| An OpenAI API key | Your project needs the text model and the voice model that you select. See [Models](./models.md). |
| Node.js 22 or newer | Get it from [nodejs.org](https://nodejs.org/). |
| pnpm | Get it from [pnpm.io](https://pnpm.io/installation), or run `corepack enable pnpm`. |
| Chrome or Edge | Use a current version. Do not use private browsing. Allow notifications for the page. |
| Your own phone | For the first tests, text and call your own mobile phone. |
| A free ngrok account | The app opens its public tunnel with ngrok. Sign up at [dashboard.ngrok.com](https://dashboard.ngrok.com/signup). You don't need it with `TUNNEL_PROVIDER=cloudflare`. See [Set up the public tunnel](#set-up-the-public-tunnel). |
| Network access | The app must reach `api.sent.dm`, `api.openai.com`, and ngrok. With `TUNNEL_PROVIDER=cloudflare`, it must reach Cloudflare instead, and on the first Start it downloads the `cloudflared` binary from GitHub. |

> [!IMPORTANT]
> The webhook that Start creates gets **every** inbound text on your Sent account. If your account has real customers, put your own phone in **Only these numbers** before you start. Then the agent replies to and answers only that number.

> [!NOTE]
> Sent calls only the countries that it allows on your account. A call to another country stops before it rings. See [Calls stop at INITIATED](./sent-api-and-logs.md#calls-stop-at-initiated).

## Install and start the app

1. Open a terminal in the `chat-voice-agent-openai-sent` folder.
2. Install the dependencies:

   ```sh
   pnpm install
   ```

3. Give the app your ngrok authtoken. See [Set up the public tunnel](#set-up-the-public-tunnel).
4. Start the app:

   ```sh
   pnpm dev
   ```

   The terminal shows the tunnel provider, for example `Public tunnel: ngrok.`

5. Open `http://localhost:3000` in Chrome or Edge.

For a production build, run `pnpm build`, then `pnpm start`.

> [!NOTE]
> Run the app with `pnpm dev` or `pnpm start`, not with `next dev`. The console needs the app's own server: it holds the keys and talks to Sent. Without it, the page says that the server isn't answering.

## Set up the public tunnel

Sent sends voice questions and message webhooks only to public HTTPS URLs. So Start opens a public tunnel to the gateway. By default, the tunnel provider is ngrok.

1. Sign up for a free ngrok account at [dashboard.ngrok.com](https://dashboard.ngrok.com/signup).
2. Copy your authtoken from [Your Authtoken](https://dashboard.ngrok.com/get-started/your-authtoken).
3. Set `NGROK_AUTHTOKEN` in `.env` or in your shell. If you ran `ngrok config add-authtoken` before, skip this step: the app reads the token that the ngrok agent saved.
4. Start the app, or restart it. The server reads these variables only at startup.

| Variable | Default | Notes |
| --- | --- | --- |
| `TUNNEL_PROVIDER` | `ngrok` | `ngrok` or `cloudflare`. Another value stops the server at startup. |
| `NGROK_AUTHTOKEN` | the token from `ngrok config add-authtoken` | The server reads it one time and removes it from its environment, like the API keys. |
| `NGROK_DOMAIN` | none | A fixed ngrok domain, for example your free dev domain from [Domains](https://dashboard.ngrok.com/domains). Without it, each Start gets a new `https://<random>.ngrok-free.app` address. |

ngrok runs inside the server process. The server opens one ngrok agent session and uses it again for each Start. Stop closes only the tunnel's endpoint. A free ngrok account can have 3 agent sessions online at the same time. Each running ngrok agent or app uses one.

The voice path and the webhook path are new on each Start, also with `NGROK_DOMAIN`. The app sets them in Sent for you.

To use a Cloudflare quick tunnel, set `TUNNEL_PROVIDER=cloudflare`. It needs no account. On the first Start, the app downloads the `cloudflared` binary from GitHub.

## Connect your keys

You can give the keys to the app in two ways.

### Option A: Use the console

1. Click **Connect Sent**.
2. Paste your Sent API key and your OpenAI API key.
3. Click **Connect**.

The keys stay in the memory of the server process. The app does not write them to disk, and the browser does not keep them.

### Option B: Use environment variables

1. Copy `.env.example` to `.env`.
2. Set `SENT_DM_API_KEY` and `OPENAI_API_KEY`.
3. Start the app.

A variable set in your shell has priority over the same variable in `.env`. If only one of the two keys is set, the server ignores both and writes a warning in the terminal. Keys that you enter in the console replace the environment keys until the server stops.

> [!CAUTION]
> `.env` is a plain text file. On a shared computer, use shell variables or a secret manager.

### What connecting does

1. The server lists the voice numbers on your Sent account and keeps the `ACTIVE` ones.
2. At the same time, it calls `GET /v1/models` on OpenAI to check the OpenAI key.
3. It selects your saved number, or the number that Sent marks as `default_for_app_calls`.
4. If an earlier run left a routing backup, it restores your number and deletes the old webhook first.
5. It loads your approved templates.
6. It imports your newest 1,000 Sent messages. The inbox then shows every number you have texted, one conversation each. The agent never replies to imported messages.

A number that has no callback URL yet is `INACTIVE` in Sent. To turn it on, set any public HTTPS callback URL on it in Sent, then connect again.

## Set up the agent

Click the gear icon to open **Agent settings**.

| Setting | Default | Notes |
| --- | --- | --- |
| Business name | none | Required. The agent greets callers with it. |
| Sent number | your default app-call number | You can change it only while the agent is stopped. |
| Text model, voice model | GPT-6 Luna, GPT-Realtime-2.1 | See [Models](./models.md). |
| Instructions | a short generic brief | What the agent knows and how it should sound. The agent uses them in texts and on calls. |
| Outbound calls | Call on its own | Or **Ask me first**, or **Never call**. See [Calls](./agent.md#calls). |
| Calls from, Until | 09:00 to 20:00 | In the contact's local time. |
| Inbound calls | Ring the team first, for 10 s | Or **Agent answers** at once, or **Team only**. |
| Only these numbers | empty | While it lists numbers, the agent acts only for them. |
| Hand over to a person | on request, when upset, refunds above $20 | See [Handover](./agent.md#handover). |

The settings are saved in `.sent-agent/settings.json`. Saved values win over the defaults.

## Start the agent

1. Click **Start agent**.
2. Allow notifications when the browser asks. Sent uses them to ring this tab when someone calls.
3. Wait while the status shows each step:
   - **Checking access to the voice model.** The server opens a real session with the voice model, then closes it.
   - **Opening the public tunnel.**
   - **Registering this tab with Sent.** This tab becomes the phone tab.
   - **Saving your number's current routing.**
   - **Routing calls to this app.**
   - **Subscribing to messages.**
   - **Testing the call path.** Sent sends a signed test question through the tunnel.
4. The status shows **Agent on** and your number.

Keep the phone tab open and the computer awake. If the tab stops responding for 7 seconds, the agent stops and your number's routing goes back.

For the full sequence, see [Start and Stop](./architecture.md#start-and-stop).

## Run the first tests

Do these tests with your own phone in **Only these numbers**.

### Test 1: A text

1. From your phone, text your Sent number: "Hi, do you have a minute?"
2. The conversation appears in the inbox. The agent shows **typing**, then replies.
3. Open the conversation. The right panel shows the agent's actions under **Agent activity**.

### Test 2: A call from the agent

1. In the same conversation, text: "Can you call me?"
2. The agent records your consent and calls you, because the default policy is **Call on its own**.
3. Answer. The agent says who it is and why it called. The transcript streams into the call card.
4. Say goodbye. The agent ends the call, and texts you anything it promised.

If the call stops at once, see [Calls stop at INITIATED](./sent-api-and-logs.md#calls-stop-at-initiated).

### Test 3: A call to the agent

1. Call your Sent number from your phone.
2. The phone tab rings. A card shows **Incoming call** and counts down 10 seconds.
3. Don't answer in the console. The agent picks up and greets you. It already knows your texts.

To answer yourself, click **Answer** in the phone tab. Use headphones to avoid echo.

### Test 4: Take over

1. While the agent talks with you, click **Take over call** in the phone tab. Your microphone joins the call, and the agent stops speaking.
2. In a text conversation, click **Take over**. The agent stops replying and writes drafts for you instead. Click **Hand back to agent** to give it back.

### Test 5: A small campaign

1. Create a file `test.csv`:

   ```csv
   phone,name
   +14155551234,Your name
   ```

   Use your own number in international format.

2. Click **Campaigns**, then **New campaign**.
3. Upload the file. Choose a template, and map its variables to columns or give one value for everyone.
4. Write a scenario, for example: "Ask whether they'd like a quick call. If they agree, call them."
5. Click **Send to 1 contact**, then click **Confirm: send 1 message**.
6. Reply to the template from your phone: "Sure, call me." The agent calls you.

## Stop the app

1. Click **Stop**. The server ends any call, restores your number's callback URL, deletes the webhook, and closes the tunnel.
2. Push **Ctrl+C** in the terminal to stop the server. It runs the same steps first, for up to 20 seconds.

If the server stops without these steps, for example after a crash, the routing backup stays on disk. The next time the keys connect, the server restores your number and deletes the webhook before anything else.

### If your number has no callback URL

Sent can't clear a callback URL. If your number had none before Start, it keeps the app's address after Stop, and calls to it fail until you set a new callback URL in Sent. The console shows a warning when this applies.

## Things to try

- Text from a WhatsApp account. The agent replies on WhatsApp while the 24-hour window is open.
- Set **Outbound calls** to **Ask me first**. The agent then shows a call request that you approve.
- Ask for a refund above the limit. The agent brings in a person.
- Text **STOP**. Sent stops texts to your number, and the agent stops replying. Text **START** to undo it.
- Search the inbox for a campaign's name to see its conversations.
- Start a campaign from a script. See [Campaigns](../README.md#campaigns).

## Change the source code

`pnpm dev` reloads the console when you change files in `app/`, `components/`, or `lib/`. Restart it after you change files in `server/`.

| Command | What it does |
| --- | --- |
| `pnpm test` | Runs the tests: signatures, call rules, free-text rules, webhooks, campaigns, the text agent's tool loop, and the tunnel settings. |
| `pnpm check` | Checks the types and runs the linter. |
| `pnpm build` | Builds the console for `pnpm start`. |

## Change the port

Set `PORT` in `.env` or in your shell, for example `PORT=3100 pnpm dev`. The value must be from 1024 to 65535.

## Setup problems

| Problem | What to do |
| --- | --- |
| The page says the server isn't answering. | Start the app with `pnpm dev`, not `next dev`. |
| **Connect** says that no voice number is active. | Turn on voice for an existing number in Sent. A number without a callback URL is `INACTIVE` until you set one. |
| **Start agent** asks for the business name. | Enter it in **Agent settings**. |
| Start stops at "Allow notifications". | Allow notifications for `localhost:3000` in the browser's site settings, then start again. |
| Start stops at the model check. | Your OpenAI project can't use the voice model. Choose another one, or ask OpenAI for access. |
| The server stops at startup with `TUNNEL_PROVIDER must be ngrok or cloudflare`. | Fix the value in `.env` or in your shell. |
| The terminal shows `Public tunnel: ngrok, but no authtoken is set`. Start stops with `ngrok needs an authtoken`. | Set `NGROK_AUTHTOKEN`, or run `ngrok config add-authtoken`. Then restart the app. See [Set up the public tunnel](#set-up-the-public-tunnel). |
| Start stops with `ngrok rejected the authtoken`. | The token is wrong, or someone reset it. Copy it again from the ngrok dashboard. |
| Start stops with `ERR_NGROK_108`. | Your ngrok account has 3 agent sessions online. Stop another ngrok agent or app, or set `TUNNEL_PROVIDER=cloudflare`. |
| Start stops with `ERR_NGROK_334`. | Another ngrok agent uses `NGROK_DOMAIN`. Stop that agent, or remove `NGROK_DOMAIN`. |
| Start stops at the tunnel: it did not connect, or did not become reachable. | Check your access to ngrok, or to Cloudflare with `TUNNEL_PROVIDER=cloudflare`. A firewall or a VPN can block it. Try the other provider. |
| Start stops at "Testing the call path". | Sent couldn't reach the tunnel. Try again. If it repeats, see [Start fails](./sent-api-and-logs.md#start-fails). |
| Texts show **Not delivered**. | Read the reason under the message. See [A text is not delivered](./sent-api-and-logs.md#a-text-is-not-delivered). |
| Another tab shows **Calls ring in the tab that started the agent**. | Only the phone tab can answer or take over a call. Use that tab. |
