# Models

This document describes the OpenAI models that the outbound agent can use, the defaults, and the costs. It also shows how to add a model.

## Summary

The app uses models in three roles. The dashboard shows only the settings that apply to the voice model that you select.

| Role | Default | Options | Used with |
| --- | --- | --- | --- |
| Voice model | **GPT-Realtime-2.1** | GPT-Realtime-2.1, GPT-Realtime-2.1 Mini, GPT-Live-1 | All calls |
| Contact transcription | **GPT-Live-Transcribe** | GPT-Live-Transcribe, GPT-Transcribe | Realtime models only |
| Text helper | **GPT-6 Luna** | GPT-6 Luna, GPT-5.4 Mini, GPT-6 Sol, GPT-6 Astra | GPT-Live-1 only |

The app never uses a different model without telling you. If your OpenAI project cannot use the selected model, **Start agent** fails during the model check.

## Which voice model to use

| If you want | Use |
| --- | --- |
| The best instruction following, saved outcomes, and a clean hang-up | GPT-Realtime-2.1 (default) |
| A lower audio cost, and you accept weaker tool use | GPT-Realtime-2.1 Mini |
| An agent that listens while it speaks, with a per-minute price | GPT-Live-1 |

Start with the default. OpenAI recommends that you test with the larger model first, then try the smaller one.

## Costs

Prices are from [OpenAI's pricing page](https://developers.openai.com/api/docs/pricing) on 9 October 2026. Latency values are from live tests with this app's settings. Check the pricing page for current prices.

### Voice models

| Model | Price | Notes |
| --- | --- | --- |
| **GPT-Realtime-2.1** | Audio: $32 in and $64 out for each 1M tokens. This is about $0.02 for each minute of contact speech and $0.08 for each minute of agent speech. | First audio in about 0.7 to 0.8 s. |
| GPT-Realtime-2.1 Mini | Audio: $10 in and $20 out for each 1M tokens. This is about 3 times less. | OpenAI says that its instruction following and function calls are weaker. |
| GPT-Live-1 | $0.05 for each minute, billed by the second. Add the text helper tokens. | Full duplex: it listens while it speaks. The session opens before the dial, so the ringing time is also billed: about $0.025 for 30 s of ringing. |

### Contact transcription (Realtime models)

| Model | Price | Notes |
| --- | --- | --- |
| **GPT-Live-Transcribe** | $0.017 for each minute | Shows captions while the contact speaks. The final text comes about 2.3 s after the contact stops. |
| GPT-Transcribe | $0.0045 for each minute | Text starts about 0.15 s after the contact stops. The final text comes in about 0.6 s. |

Transcription feeds the dashboard only. The voice model hears the contact audio directly. GPT-Live-1 makes its own transcripts and ignores this setting.

### Text helper (GPT-Live-1)

| Model | Price for each 1M tokens (in / out) | Reasoning effort | Latency in tests |
| --- | --- | --- | --- |
| **GPT-6 Luna** | $0.10 / $0.50 | `none` | Usually 1 to 1.7 s. Up to 4.7 s. |
| GPT-5.4 Mini | See the pricing page | `none` | Fastest. Median 0.9 s. |
| GPT-6 Sol | $2 / $10 | `none` | About 1.8 s |
| GPT-6 Astra | $10 / $50 | `low` | Slowest. Too strong for two spoken sentences. |

The app does not offer `gpt-6.1-sol`. That model does not accept effort `none`, and it took about 5.7 s at `low`.

These costs are for OpenAI only. Sent also charges for each call to a phone, by the minute, at the rate of the destination. To see the Sent charge for one call, read `price` on the [call record](./sent-calls-and-logs.md#find-a-call-in-sent).

With the Realtime models, the ringing time costs nothing at OpenAI. The session is open, but the app sends no audio before the contact answers.

## Realtime models in detail

GPT-Realtime-2.1 and GPT-Realtime-2.1 Mini use `wss://api.openai.com/v1/realtime`. The adapter sends one `session.update` when the socket opens.

| Setting | Value | Why |
| --- | --- | --- |
| `output_modalities` | `["audio"]` | The agent speaks. It does not send text replies. |
| `reasoning.effort` | `low` | OpenAI recommends `low` for production voice agents. Tests showed no delay to the first audio. |
| `turn_detection.type` | `server_vad` | OpenAI detects when the contact starts and stops speaking. |
| `turn_detection.threshold` | `0.5` | Sensitivity of the voice detection. |
| `turn_detection.prefix_padding_ms` | `300` | Audio kept from before the contact starts speaking. |
| `turn_detection.silence_duration_ms` | `900`, then `450` | Silence that ends a contact turn. The first turn uses 900 ms, so a pause inside the contact's greeting does not end it. After the opening line, the app changes it to 450 ms. |
| `turn_detection.create_response` | `true` | The agent answers after each contact turn. This also answers the contact's first greeting. |
| `turn_detection.interrupt_response` | `true` | OpenAI cancels the agent's answer when the contact speaks. |
| `transcription.model` | Your contact transcription setting | Captions for the dashboard. |
| `voice` | `marin` | The agent's voice. |
| `instructions` | Your instructions, then the opening line | The model knows its opening line if the contact speaks first. See [The first words](./architecture.md#the-first-words). |
| `tools` | `record_outcome`, `end_call` | See [Agent tools](./architecture.md#agent-tools). |
| Audio format | `audio/pcm`, 24000 Hz | The same format as the browser worklet. |

The text helper is not used with Realtime models.

## GPT-Live-1 in detail

GPT-Live-1 uses `wss://api.openai.com/v1/live/sessions`. The adapter sends `session.start` with the model, the instructions with the opening line, the audio format, the `marin` voice, and `delegation: { type: "client" }`.

GPT-Live-1 can give a question to the app ("client delegation"). Then:

1. OpenAI sends `session.delegation.created`.
2. The adapter joins the transcript fragments into turns. It keeps the last 12,000 characters.
3. The adapter sends the turns to the text helper with `POST /v1/responses`. The request asks for at most two short spoken sentences.
4. The adapter sends the answer back with `session.commentary.append`. GPT-Live-1 speaks it.

The text helper gets text only. It never hears the call audio. It has no tools.

If the text helper fails or takes more than 15 seconds, the adapter sends this sentence: "I can't check that right now. I can have the team follow up with you."

| Helper setting | Value |
| --- | --- |
| `reasoning.effort` | `none`, or `low` for GPT-6 Astra |
| `max_output_tokens` | 600 for effort `none`, 2000 for effort `low` |
| Answer length sent to GPT-Live-1 | Up to 1,200 characters |

GPT-Live-1 does not get the `record_outcome` and `end_call` tools in this app. Calls with GPT-Live-1 end when the contact hangs up, after 60 s of silence, at the 5-minute limit, or when you click **Hang up**. OpenAI's [delegation guide](https://developers.openai.com/api/docs/guides/live-delegation) supports tools through Responses delegation (`delegation.responses.tools`). That is the way to add them.

## Facts and the instructions

Each model knows only the facts in the instructions about Sent. In tests, every model confirmed product features that the instructions did not mention. To prevent this:

- Put each product fact in the instructions.
- Tell the agent to offer a follow-up from the team for all other questions.

## Settings that the app does not use yet

These settings need tests on real phone calls first.

| Setting | Status |
| --- | --- |
| `semantic_vad` | OpenAI says that it interrupts the speaker less often. Not tested on real calls. |
| `noise_reduction: near_field` | The API accepts it. Not tested on real phone audio. |
| Fast mode for the helper (`service_tier: priority`) | Costs 2 times more. Tests showed no clear latency gain for GPT-6 Luna. |

## Change the default model

The default is in `src/models.ts`. The server and the dashboard both read it:

```ts
export const DEFAULT_VOICE_MODEL: VoiceModel = 'gpt-realtime-2.1';
export const DEFAULT_BACKEND_MODEL: BackendModel = 'gpt-6-luna';
export const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModel = 'gpt-live-transcribe';
```

Then change the option order and the "(recommended)" labels in `public/index.html`, and run `pnpm run build`.

## Add a model

1. Add the model ID to `MODELS`, `TRANSCRIPTION_MODELS`, or `BACKEND_MODELS` in `src/models.ts`.
2. Add an `<option>` for it in `public/index.html`.
3. Update the error message for that list in `POST /api/settings` in `src/server.ts`.
4. For a helper model, check `backendReasoning()` in `src/models.ts`. Use the lowest effort that the model accepts.
5. Run `pnpm run build`.
6. Run `pnpm test`.

> [!IMPORTANT]
> `isLiveModel()` in `src/models.ts` tells GPT-Live models from Realtime models. The server uses it to select the transport, and the browser uses it to select the playback queue limit and the settings to show. If you add a GPT-Live model, add it to `isLiveModel()`.

## Related links

- [OpenAI model catalog](https://developers.openai.com/api/docs/models)
- [OpenAI Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [OpenAI Live WebSocket protocol](https://developers.openai.com/api/docs/guides/voice-websockets?api=live)
- [OpenAI Live delegation](https://developers.openai.com/api/docs/guides/live-delegation)
