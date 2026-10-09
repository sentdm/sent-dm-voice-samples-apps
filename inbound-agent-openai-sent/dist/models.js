// Verified against OpenAI's official model catalog on 2026-10-09.
// Voice, ASR, and text models are not interchangeable between API transports.
export const MODELS = ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini', 'gpt-live-1'];
// GPT-Live text helper. A caller waits on every answer, so each model runs at the lowest reasoning effort it accepts
// (live-tested 2026-10-09). gpt-6.1-sol is omitted: it rejects 'none' and took ~5.7 s at 'low'; gpt-6-sol accepts 'none'
// (~1.8 s) and is the Sol OpenAI's delegation guide names.
export const BACKEND_MODELS = ['gpt-6-luna', 'gpt-5.4-mini', 'gpt-6-sol', 'gpt-6-astra'];
export const TRANSCRIPTION_MODELS = ['gpt-live-transcribe', 'gpt-transcribe'];
export const DEFAULT_VOICE_MODEL = 'gpt-realtime-2.1';
export const DEFAULT_BACKEND_MODEL = 'gpt-6-luna';
export const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-live-transcribe';
export function isLiveModel(model) { return model === 'gpt-live-1'; }
export function backendReasoning(model) {
    return model === 'gpt-6-astra' ? 'low' : 'none';
}
//# sourceMappingURL=models.js.map