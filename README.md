# Sent.DM Voice Samples

Runnable sample apps for building voice experiences with [Sent](https://sent.dm). Each sample is self-contained in its own folder with its own setup guide.

## Samples

| Sample | What it shows | Status |
| --- | --- | --- |
| [Inbound agent](./inbound-agent-openai-sent) | An AI agent that answers calls to your Sent number using OpenAI voice models. It shows live transcripts, takes messages and ends calls. | Available |
| Outbound agent | An AI agent that places calls from your Sent number | Coming soon |
| Chat + voice | One customer conversation across messaging and voice | Coming soon |
| Voice feature tour | A reference app covering each Sent voice capability | Coming soon |

## Prerequisites

- A Sent account with voice enabled and an active voice number
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

> These are samples for learning and prototyping, not production services. Test with your own accounts, preferably on a dedicated test number.

## Resources

- [Sent voice SDK](https://docs.sent.dm/sdks/voice)
- [Voice callback reference](https://docs.sent.dm/reference/api/voice-callback)
- [In-app calls and voice tokens](https://docs.sent.dm/start/guides/in-app-calls)

## License

The sample code is [MIT-licensed](./LICENSE). Running it requires a Sent account, and use of the Sent API is subject to [Sent's terms](https://sent.dm/en/legal). Third-party services a sample uses (for example, OpenAI) have their own terms and billing.

Samples that ship prebuilt bundles include third-party packages under their own licenses. See the sample's `THIRD_PARTY_NOTICES.md`.
