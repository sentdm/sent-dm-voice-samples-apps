# Setup

This guide shows how to install the outbound agent, connect your keys, and place a test call. It also gives ideas for things to try after the first call.

The app runs on your computer. A Node.js server and one browser tab do all the work. There is no hosted backend.

## What you need

| Item | Notes |
| --- | --- |
| A Sent account with voice | Sent must turn on phone calls for your account. To ask for it, write to support@sent.dm. |
| Sent balance | Sent charges calls to phones by the minute, at the rate of the destination. Sent refuses a call when the balance is zero or less. |
| An active Sent voice number | The app uses an existing number as the caller ID. It never buys a number. Use a test number if you can. |
| A Sent API key | The key must have access to the voice channel endpoints. |
| An OpenAI API key | Use a direct OpenAI key. A proxy that supports only Chat Completions does not work. Your OpenAI project must have access to the voice model that you select. |
| Node.js 22 or newer | Get it from [nodejs.org](https://nodejs.org/). |
| pnpm | Get it from [pnpm.io](https://pnpm.io/installation), or run `corepack enable pnpm`. |
| Chrome or Edge | Use a current version. Do not use private browsing. |
| A phone to call | For the first tests, call your own mobile phone. |
| Network access | The app must reach `api.sent.dm`, `api.openai.com`, and Cloudflare. On the first Start, it downloads the `cloudflared` binary from GitHub. |

> [!TIP]
> Use a number that already has a callback URL. Then **Stop** can put your old routing back exactly. A number without a callback URL needs one manual step after you stop. See [If your number has no callback URL](#if-your-number-has-no-callback-url).

> [!IMPORTANT]
> While the agent runs, the app rejects inbound calls to the selected number. Do not use a number that people must reach during your tests.

## Install and start the app

1. Open a terminal in the `outbound-agent-openai-sent` folder.
2. Install the production dependencies:

   ```sh
   pnpm install --frozen-lockfile --prod
   ```

3. Start the server:

   ```sh
   pnpm start
   ```

4. Open `http://localhost:3000` in Chrome or Edge.

The repository includes the compiled server and browser files in `dist/`. You do not need to build the app to run it.

You can also use a launcher. On macOS or Linux, run `sh start.sh`. On Windows, double-click `start.cmd`. The launcher installs the dependencies on the first run, then starts the same app.

## Connect your keys

You can give the keys to the app in two ways.

### Option A: Use the dashboard

1. Open the **API keys** panel.
2. Paste your Sent API key.
3. Paste your OpenAI API key.
4. Click **Connect keys**.

The keys stay in the memory of the server process. The app does not write them to disk. The browser does not keep them.

### Option B: Use environment variables

1. Copy `.env.example` to `.env`.
2. Set `SENT_DM_API_KEY` and `OPENAI_API_KEY` in `.env`.
3. Start the app with `pnpm start`.

You can also set the two variables in your shell. A shell value has priority over a value in `.env`.

When the server starts, it checks both keys. It uses the same checks as the dashboard form. The dashboard then shows **Connected · environment**. If you enter keys in the dashboard, they replace the environment keys until the server stops.

If only one of the two variables is set, the server ignores both. It writes a warning in the terminal.

> [!CAUTION]
> `.env` is a plain text file. On a shared computer, use shell variables or a secret manager.

### What "Connect keys" checks

1. The server lists the voice numbers on your Sent account.
2. At the same time, it calls `GET /v1/models` on OpenAI to check the OpenAI key.
3. It keeps only the numbers with the status `ACTIVE`.
4. It selects the number that Sent marks as `default_for_app_calls`. If there is no default, it selects the first active number.
5. If an earlier run left a routing backup, the server restores that number's callback first.

If no number is active, the server shows an error. A number that has no callback URL yet is `INACTIVE` in Sent. To turn it on, set any public HTTPS callback URL on it in Sent. Then connect the keys again.

## Set the behavior of the agent

You can change these settings only while the agent is stopped.

| Setting | Default | Notes |
| --- | --- | --- |
| Call from (caller ID) | The default number for app calls | Only active numbers show. The contact sees this number. |
| Voice model | GPT-Realtime-2.1 | See [Models](./models.md). |
| Contact transcription | GPT-Live-Transcribe | Shows for Realtime models only. |
| Text helper | GPT-6 Luna | Shows for GPT-Live-1 only. |
| Opening line | "Hi, this is an AI assistant calling from Sent. Is now a good time for a quick chat about getting started?" | 1 to 600 characters. |
| Instructions | A short follow-up call from Sent | Up to 5,000 characters. |

The app sends these settings to the server when you click **Start agent**.

The default instructions tell the agent to let the contact speak first and to wait until they finish their greeting. They also tell the agent to say that it is an AI in its first sentence, to keep most replies under 20 words, and to ask one thing at a time. If the contact is busy, the agent asks when to call back. If the contact asks not to be called again, the agent apologizes and ends the call. If the agent reaches voicemail, it leaves one short message. Keep all product facts in the instructions. The agent can state facts that are not true if the instructions do not give them.

## Start the agent

1. Click **Start agent**.
2. If the browser asks for permission to show notifications, click **Allow**.

   The Sent SDK cannot register the tab without this permission, also for outbound calls.

3. Wait for the status **Ready to place calls. Keep this browser tab open.**

The app does these steps in this order. Nothing changes on your Sent number until the last two steps.

1. It creates the browser audio graph and the software microphone.
2. It opens a test session with the selected OpenAI voice model, then closes it.
3. It opens the Cloudflare tunnel and waits until the public URL answers.
4. It registers the browser tab as a Sent app user.
5. It saves your number's current callback URL to `.sent-agent/routing-backup.json`.
6. It sets the tunnel URL as your number's callback URL, then asks Sent to send a test question.

If a step fails, the app undoes the earlier steps and shows the error.

The browser does not use your real microphone. The contact does not hear your room, and your speakers do not play the call.

## Place a test call

1. In **Number to call**, enter your mobile number in international format: `+`, the country code, and the number.

   | You type | The app uses |
   | --- | --- |
   | `+14155550123` | `+14155550123` |
   | `+1 (415) 555-0123` | `+14155550123` |
   | `+383 49 123 456` | `+38349123456` |
   | `4155550123` | Refused. The number has no `+` and no country code. |
   | `0044 20 7946 0958` | Refused. Write `+44 20 7946 0958`. |

2. Select **I have permission to call this number with an AI voice**.
3. Click **Call**.
4. Answer your phone.

The dashboard shows **Calling**, then **Ringing**, then **Talking with**. The **Transcript** panel shows what the contact and the agent say. The **Local event log** shows each step of the call.

Try these things during the call:

| Do this | Expected result |
| --- | --- |
| Answer with "Hello? … Yes, this is Ana. Who's calling?" | The agent waits until you finish, then answers with the opening line. |
| Say nothing when you answer | The agent says the opening line after about 3 seconds. |
| Speak while the agent speaks | The agent stops and listens. |
| Say "I'm busy, call me back tomorrow at 10" | The event log shows an `outcome` line with `callback_requested`. |
| Say "Please don't call me again" | The agent apologizes and ends the call. The outcome is `do_not_call`. |
| Say "That is all, thanks" | The agent says goodbye and ends the call. |
| Say nothing for 60 seconds | The app ends the call. |
| Talk for 5 minutes | The app ends the call at the limit. |
| Do not answer | After 30 seconds, the call ends as `noAnswer`, or your voicemail answers. |
| Decline the call | The call ends as `busy`. |
| Click **Hang up** in the dashboard | The app ends the call at once. If the model is still starting, the app does not dial. |

The outcome, goodbye, and hang-up behaviors work with the Realtime models only. GPT-Live-1 does not have these tools in this app.

The app places one call at a time. **Call** is unavailable until the current call ends.

## Stop the app

1. Click **Stop & restore routing**.
2. Read the event log. Look for `Previous callback URL restored.`
3. In the terminal, push **Ctrl+C**.

> [!WARNING]
> Do not close the terminal or put the computer to sleep while the agent runs. If you do, your number can keep the temporary callback URL. Calls to your number then fail until the app restores the routing.

If you push **Ctrl+C** while the agent runs, the server also tries to restore the routing. It waits up to 20 seconds.

If you close the tab, the server sees no heartbeat for 7 seconds. It then stops and restores the routing. This is a safety net only. Use **Stop & restore routing**.

### If your number has no callback URL

Sent cannot set a callback URL back to "empty". So the app cannot restore an empty callback.

When you stop, the app keeps the routing backup and shows a warning. Calls to your number then fail, because the tunnel is closed.

1. Set the callback URL that you want on the number in Sent.
2. In the dashboard, click **Forget routing backup**.
3. Read the confirmation. It shows the number and the old callback URL.
4. Click **OK**.

While a routing backup exists, the app does not start on a different number.

## Things to try

These changes help you learn how the sample works.

| Try this | How |
| --- | --- |
| Give the agent a new job | Change **Opening line** and **Instructions**, then start again. |
| Compare voice models | Select GPT-Realtime-2.1 Mini or GPT-Live-1. See [Models](./models.md). |
| Read the saved outcomes | Run `cat .sent-agent/call-outcomes.jsonl`. |
| Change the outcome values | Change `OUTCOMES` in `src/openai.ts`. |
| Change the wait before the opening line | Change `DEFAULT_OPENING_WAIT_MS` in `src/openai.ts`. |
| Change the call limit | Change `MAX_CALL_MS` in `src/server.ts`. |
| Change how long the phone rings | Change `DIAL_TIMEOUT_SECONDS` in `src/security.ts`. Also check `DIAL_SETUP_MS` in `src/server.ts`. |
| Find the call in Sent | Copy the `call_…` ID from the event log. See [Find a call in Sent](./sent-calls-and-logs.md#find-a-call-in-sent). |
| Show more SDK logs | See [Get more logs from the Sent SDK](./sent-calls-and-logs.md#get-more-logs-from-the-sent-sdk). |
| Change the agent's voice | Change `'marin'` in `src/openai.ts`. It is in two places, one for each model family. |
| Watch the call flow | Open the [animated walkthrough](./how-it-works.html). |

## Change the source code

1. Install all dependencies, including the development tools:

   ```sh
   pnpm install
   ```

2. Run the app from the source:

   ```sh
   pnpm dev
   ```

   This command builds the browser bundle, then runs `src/server.ts` with `tsx`. After you change the code, stop the server and run `pnpm dev` again.

3. Before you commit, build the app:

   ```sh
   pnpm run build
   ```

   The repository includes `dist/`. The CI build fails if `dist/` does not match the source.

To run the checks and tests:

```sh
pnpm run check                        # server and browser TypeScript
pnpm test                             # server tests with fake Sent and OpenAI services
pnpm exec playwright install chromium
pnpm test:browser                     # real browser audio graph
pnpm test:dashboard                   # dashboard call lifecycle with a fake Sent SDK
```

The tests use local fake services. They do not need keys and they do not make calls.

## Change the port

The dashboard uses port 3000. To use a different port, set `PORT` in your shell or in `.env`. To run the inbound and the outbound samples at the same time, give one of them a different port.

| Shell | Command |
| --- | --- |
| macOS or Linux | `PORT=3001 pnpm start` |
| PowerShell | `$env:PORT=3001; pnpm start` |

The port must be from 1024 to 65535.

## Setup problems

| Problem | Cause | Fix |
| --- | --- | --- |
| `No active voice numbers on this Sent key` | The account has no active voice number, or the key scope is too small. | Turn on voice for a number in Sent. Check the API key. |
| `… is waiting for a first callback URL` | The number has no callback URL, so it is `INACTIVE`. | Set any public HTTPS callback URL on the number in Sent. Then connect the keys again. |
| `OpenAI key check failed (401)` | The OpenAI key is not correct. | Use a direct OpenAI API key. |
| `Notification permission is required…` | The browser blocked notifications. | Allow notifications for `localhost:3000` in the browser settings. |
| `The public callback tunnel did not become reachable…` | Cloudflare is blocked or slow. | Allow outbound access to Cloudflare and GitHub. Try again. |
| `Sent callback test: …` | Sent could not use the gateway's answer to its test question. | See [Start fails](./sent-calls-and-logs.md#start-fails). |
| `Enter the number in international format…` | The number has no `+` and no country code. | Write `+`, the country code, and the number. |
| `Port in use` error at start | A different process uses port 3000. | Stop that process, or set `PORT`. |

For problems during a call, see [Troubleshooting](./sent-calls-and-logs.md#troubleshooting).
