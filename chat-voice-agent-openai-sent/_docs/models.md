# Models

This document describes the OpenAI models that the chat + voice agent uses, the defaults, and how to add a model.

## Summary

| Role | Default | Options | Setting |
| --- | --- | --- | --- |
| Text agent | **GPT-6 Luna** | GPT-6 Luna, GPT-5.4 Mini, GPT-6 Sol | **Text model** in Agent settings |
| Voice agent | **GPT-Realtime-2.1** | GPT-Realtime-2.1, GPT-Realtime-2.1 Mini | **Voice model** in Agent settings |
| Contact transcription on calls | **GPT-Live-Transcribe** | none | Fixed in `server/voice-agent.ts` |

The app never uses a different model without telling you. If your OpenAI project can't use the voice model, **Start agent** fails at the model check. If it can't use the text model, the agent's replies fail, and the console shows the error.

## Text agent

The text agent uses the Responses API, with these settings:

| Setting | Value | Why |
| --- | --- | --- |
| Reasoning effort | `none` | Customers wait for every reply. |
| Output tokens | 800 at most | Replies are one to three short sentences. |
| Tool rounds | 4 at most | Enough to record consent, ask to call, and reply. |
| `store` | `false` | OpenAI doesn't keep the conversation. The app sends it with each turn. |

| If you want | Use |
| --- | --- |
| The lowest cost | GPT-6 Luna (default) |
| The fastest replies | GPT-5.4 Mini |
| Stronger reasoning, at a higher price | GPT-6 Sol |

## Voice agent

The voice agent uses the Realtime API, one session for each call it handles. It uses the voice `marin`, reasoning effort `low`, and server-side voice activity detection. The session opens before the phone rings, so the agent is ready the moment the contact answers.

| If you want | Use |
| --- | --- |
| The best instruction following, saved outcomes, and a clean hang-up | GPT-Realtime-2.1 (default) |
| A lower audio cost, and you accept weaker tool use | GPT-Realtime-2.1 Mini |

GPT-Live-1 is not offered. In the inbound and outbound samples, it runs without tools. This agent needs its tools (`record_outcome`, `end_call`) on every call.

## Costs

Check [OpenAI's pricing page](https://developers.openai.com/api/docs/pricing) for current prices. The outbound sample lists the prices of the same voice, transcription, and text models, as checked on 9 October 2026. See its [Costs](../../outbound-agent-openai-sent/_docs/models.md#costs).

Sent charges for messages and calls separately. See your Sent account for its rates.

## Change the default model

Change `textModel` or `voiceModel` in `DEFAULT_SETTINGS` in `server/store.ts`. The default applies only to installs without a saved setting. To change your own setting, use Agent settings.

## Add a model

1. Add it to `TEXT_MODELS` or `VOICE_MODELS` in `lib/models.ts`, with a label and a short note. Agent settings lists it, and the server accepts it.
2. A voice model must be a Realtime model that supports tools.
3. Run `pnpm check` and `pnpm test`.
4. Test a text and a call with your own phone.
