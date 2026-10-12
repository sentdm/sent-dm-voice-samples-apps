// The models you can choose in Agent settings. The server checks settings against the same lists.

/** Voice agent models. Realtime only: the agent needs its tools (record_outcome, end_call) on every call. */
export const VOICE_MODELS = [
  { id: "gpt-realtime-2.1", label: "GPT-Realtime-2.1", note: "Best tool use" },
  { id: "gpt-realtime-2.1-mini", label: "GPT-Realtime-2.1 Mini", note: "About 3× cheaper audio" },
] as const

/** Text agent models. Each runs at its lowest reasoning effort, because customers wait on every reply. */
export const TEXT_MODELS = [
  { id: "gpt-6-luna", label: "GPT-6 Luna", note: "Lowest cost" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", note: "Fastest" },
  { id: "gpt-6-sol", label: "GPT-6 Sol", note: "Stronger reasoning" },
] as const

export const isVoiceModel = (id: string) => VOICE_MODELS.some((m) => m.id === id)
export const isTextModel = (id: string) => TEXT_MODELS.some((m) => m.id === id)
export const modelLabel = (id: string) => [...VOICE_MODELS, ...TEXT_MODELS].find((m) => m.id === id)?.label ?? id
