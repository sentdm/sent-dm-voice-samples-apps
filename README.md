# Sent.DM Voice Samples

Runnable sample apps for building voice experiences with [Sent](https://sent.dm). Each sample is self-contained in its own folder with its own setup guide.

## Samples

| Sample | What it shows | Status |
| --- | --- | --- |
| [Inbound agent](./inbound-agent-openai-sent) | An AI agent that answers calls to your Sent number using OpenAI voice models. It shows live transcripts, takes messages and ends calls. | Available |
| [Outbound agent](./outbound-agent-openai-sent) | An AI agent that calls a phone number from your Sent number using OpenAI voice models. It waits for the person to answer and greet it, shows live transcripts, records the call outcome and ends calls. | Available |
| [Chat + voice agent](./chat-voice-agent-openai-sent) | An AI agent that runs each customer conversation across SMS, WhatsApp, RCS, and calls on your Sent number. It replies to texts, answers and places calls, hands over to a person, and runs template campaigns. | Available |
| [Voice feature tour](./voice-feature-tour-sent) | A reference app that covers each Sent voice capability. It has a browser phone on the Sent voice SDK and the backend that mints tokens, answers call questions with routing rules, receives call webhooks, and lets you try every voice API call from a console. | Available |

## Prerequisites

- A Sent account with voice enabled and an active voice number
- For the chat + voice agent: messaging on the same account, and at least one approved template
- A Sent API key
- [Node.js](https://nodejs.org/) 22+ and [pnpm](https://pnpm.io/installation)
- Any provider keys a sample needs (for example, OpenAI), listed in its README

## Quick start

```sh
git clone https://github.com/sentdm/sent-dm-voice-samples-apps.git
cd sent-dm-voice-samples-apps/inbound-agent-openai-sent
pnpm install
pnpm start
```

Then follow that sample's README for keys, configuration and testing.

## Run all samples at once

From the root of the repository:

```sh
node run-all.mjs                    # all samples
node run-all.mjs inbound outbound   # only the samples whose folder names start with these words
```

From a sample folder, run `node ../run-all.mjs`.

The script runs `pnpm dev` in each sample, each on a different port, and shows all output in one terminal. At the start, it shows the address of each sample. A sample keeps the `PORT` from its own `.env`. The other samples get the next free port from 3000. If a sample has no `node_modules`, the script installs its dependencies first.

Press Ctrl+C one time to stop all samples. The agents restore your Sent routing before they stop. Press Ctrl+C again to force them to stop.

When you run more than one sample:

- When you start a sample, it points the callback URL of your number at itself. On one number, the sample that you started last receives the calls.
- Each sample that uses ngrok opens its own ngrok session. A free ngrok account allows 3 sessions at the same time. To run more, set `TUNNEL_PROVIDER=cloudflare` in the `.env` of one sample.

> These are samples for learning and prototyping, not production services. Test with your own accounts, preferably on a dedicated test number.

## Resources

- [Sent voice SDK](https://docs.sent.dm/sdks/voice)
- [Voice callback reference](https://docs.sent.dm/reference/api/voice-callback)
- [In-app calls and voice tokens](https://docs.sent.dm/start/guides/in-app-calls)

## License

The sample code is [MIT-licensed](./LICENSE). Running it requires a Sent account, and use of the Sent API is subject to [Sent's terms](https://sent.dm/en/legal). Third-party services a sample uses (for example, OpenAI) have their own terms and billing.

Samples that ship prebuilt bundles include third-party packages under their own licenses. See the sample's `THIRD_PARTY_NOTICES.md`.
