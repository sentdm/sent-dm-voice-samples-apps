import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { fetchWithReason } from './http.js';
import { DEFAULT_BACKEND_MODEL, DEFAULT_TRANSCRIPTION_MODEL, backendReasoning, isLiveModel, type BackendModel, type TranscriptionModel, type VoiceModel } from './models.js';
export { MODELS, type VoiceModel } from './models.js';

const OPENAI_HTTP = 'https://api.openai.com';
/** Validates a key without opening a voice session; the model-specific preflight happens at Start. */
export async function checkKey(key: string, httpBase = OPENAI_HTTP): Promise<void> {
  const response = await fetchWithReason(httpBase + '/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(12_000) });
  await response.body?.cancel(); // Only the status matters; don't download the model list.
  if (!response.ok) throw new Error(`OpenAI key check failed (${response.status}).`);
}

export const OUTCOMES = ['interested', 'callback_requested', 'not_interested', 'do_not_call', 'wrong_number', 'voicemail'] as const;
type Outcome = typeof OUTCOMES[number];
export interface CallOutcome { outcome: Outcome; summary: string; callbackTime?: string; }
export interface VoiceConfig {
  key: string; model: VoiceModel; backendModel?: BackendModel; transcriptionModel?: TranscriptionModel; instructions: string; wsBase?: string; httpBase?: string;
  /** The opening line, spoken once the contact answers. */
  greeting: string;
  /** Persists a record_outcome tool call; the model is told whether it was saved. Realtime models only. */
  saveOutcome?: (outcome: CallOutcome) => Promise<void>;
  /** Ends the call after this long with neither contact speech nor agent audio, counted from the answer. */
  idleTimeoutMs?: number;
  /** How long the agent waits for the contact's "Hello?" after the answer before it speaks the opening line itself. */
  openingWaitMs?: number;
}
export type ModelEvent = { type: string; [key: string]: unknown };
export type Emit = (event: ModelEvent | Buffer) => void;

// "Most errors are recoverable and the session will stay open" (OpenAI Realtime server events), e.g. cancelling a response
// that already finished. Only billing/limit/auth failures leave it unusable; a closed model socket always ends the call.
// Billing errors may carry `credit_balance_exhausted` while `error.type` is still `insufficient_quota` (OpenAI error codes guide).
const FATAL_ERROR_CODES = new Set(['session_expired', 'invalid_api_key', 'insufficient_quota', 'credit_balance_exhausted',
  'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded']);
const isFatal = (error: { code?: string; type?: string } | undefined) => FATAL_ERROR_CODES.has(error?.code ?? '') || error?.type === 'insufficient_quota';
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
// Live test 2026-10-10: at 1.5 s the opening line started while people were still saying who they were. A silent pickup
// waits this long for the opening line; anyone who speaks first is answered by the model instead.
const DEFAULT_OPENING_WAIT_MS = 3_000;
// The silence that ends a turn. People pause inside their first words ("Hello? … yes, Betim here"), so until the agent
// has spoken its opening line the turn ends after a longer pause; then replies go back to the faster setting.
const FIRST_TURN_SILENCE_MS = 900;
const TURN_SILENCE_MS = 450;
const TOOLS = [
  {
    type: 'function', name: 'record_outcome',
    description: 'Record how the call went, once you know. Call it without announcing it, before end_call.',
    parameters: { type: 'object', additionalProperties: false, required: ['outcome', 'summary'], properties: {
      outcome: { type: 'string', enum: OUTCOMES, description: 'do_not_call: they asked not to be called again. voicemail: you left a voicemail.' },
      summary: { type: 'string', description: 'One or two sentences on what they said. Don’t add details they didn’t say.' },
      callback_time: { type: 'string', description: 'When they asked to be called back, in their words, if they did.' },
    } },
  },
  {
    type: 'function', name: 'end_call',
    description: 'Hang up once the conversation is over. Don’t say goodbye first: you’ll be asked to say it right after, and the call ends once it has played.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];
// Live tests of the inbound sample: left to the model, the goodbye before end_call was skipped or narrated ("let's wrap this up")
// in 4 of 5 calls, so the app asks for it explicitly, with tools off, and hangs up when it has finished.
const GOODBYE = 'Say a short, warm goodbye, like “Thanks for your time, bye!”. Nothing else.';
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

export class OpenAIVoice {
  private socket?: WebSocket;
  private ready = false;
  private ending = false;
  private pickedUp = false;
  private firstReplyDone = false;
  private closing?: Promise<void>;
  private transcript: { speaker: string; text: string }[] = [];
  private tasks = new Map<string, AbortController>();
  private playback = new Map<string, number>();
  private activeItem?: string;
  private pendingByte = Buffer.alloc(0);
  private inputTranscripts = new Map<string, string>();
  private toolCalls: Promise<'continue' | 'end'>[] = [];
  private hangUpAfterResponse = false;
  private lastActivity = 0;
  private idleTimer?: NodeJS.Timeout;
  private openingTimer?: NodeJS.Timeout;
  constructor(private config: VoiceConfig, private sink: Emit) {}
  get connected(): boolean { return this.ready && !this.ending; }
  /** Before the contact picks up, the line carries ringback and carrier messages, which the model must not hear. */
  get isAnswered(): boolean { return this.pickedUp; }
  // Single choke point for the silence timeout: agent audio, either side's transcript, and contact barge-in all count.
  private emit(event: ModelEvent | Buffer): void {
    if (Buffer.isBuffer(event) || event.type === 'transcript' || event.type === 'clear') this.lastActivity = Date.now();
    this.sink(event);
  }
  // The opening line is part of the session, so the model's own first reply uses it when the contact speaks first.
  private sessionInstructions(): string {
    return `${this.config.instructions}\n\nWhen the contact has greeted you or finished their first sentence, open with: “${this.config.greeting}”`;
  }
  // The server cancels the response when the contact starts talking; the client only truncates to what was heard.
  private inputAudio(silenceMs: number) {
    return {
      format: { type: 'audio/pcm', rate: 24000 },
      turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: silenceMs, create_response: true, interrupt_response: true },
      transcription: { model: this.config.transcriptionModel ?? DEFAULT_TRANSCRIPTION_MODEL },
    };
  }
  async connect(): Promise<void> {
    if (this.socket) throw new Error('Model session already created.');
    const live = isLiveModel(this.config.model);
    const base = this.config.wsBase ?? 'wss://api.openai.com';
    const route = live ? '/v1/live/sessions' : `/v1/realtime?model=${encodeURIComponent(this.config.model)}`;
    const socket = this.socket = new WebSocket(base + route, { headers: { Authorization: `Bearer ${this.config.key}` }, maxPayload: 4 * 1024 * 1024, handshakeTimeout: 12_000 });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) { socket.terminate(); reject(error); } else { this.ready = true; resolve(); }
      };
      const timer = setTimeout(() => finish(new Error('OpenAI session startup timed out. Check model access and network.')), 15_000);
      socket.on('open', () => {
        if (live) this.send({ type: 'session.start', event_id: randomUUID(), session: {
          model: this.config.model, instructions: this.sessionInstructions(),
          audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'marin' } },
          delegation: { type: 'client' },
        } });
        else this.send({ type: 'session.update', session: {
          type: 'realtime', model: this.config.model, output_modalities: ['audio'], instructions: this.sessionInstructions(), tools: TOOLS, tool_choice: 'auto',
          // OpenAI's voice prompting guide: "Start with `low` for most production voice agents" (verified accepted; no first-audio penalty measured).
          reasoning: { effort: 'low' },
          audio: {
            input: this.inputAudio(FIRST_TURN_SILENCE_MS),
            output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'marin' },
          },
        } });
      });
      socket.on('message', data => {
        try {
          const event = JSON.parse(data.toString());
          if ((live && event.type === 'session.started') || (!live && event.type === 'session.updated')) finish();
          if (event.type === 'error' && !settled) finish(new Error(`OpenAI: ${event.error?.message ?? 'Session rejected.'}`));
          this.handle(event);
        } catch (error) { this.emit({ type: 'error', message: `Invalid model event: ${(error as Error).message}` }); }
      });
      socket.on('error', error => { finish(new Error(`OpenAI connection: ${error.message}`)); if (this.ready && !this.ending) this.emit({ type: 'error', message: error.message }); });
      socket.on('unexpected-response', (_req, response) => { response.resume(); finish(new Error(`OpenAI connection refused (${response.statusCode}). Check key and selected model access.`)); });
      socket.on('close', () => { finish(new Error('OpenAI disconnected before becoming ready.')); this.ready = false; if (!this.ending) this.emit({ type: 'closed' }); });
    });
  }
  private send(event: object): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event)); }
  audio(bytes: Buffer): void {
    if (!this.connected || !this.pickedUp) return;
    if ((this.socket?.bufferedAmount ?? 0) > 128 * 1024) { this.emit({ type: 'error', message: 'OpenAI audio transport is congested; ending instead of building latency.' }); void this.close(); return; }
    const chunk = Buffer.concat([this.pendingByte, bytes]);
    const count = chunk.length - chunk.length % 2;
    this.pendingByte = chunk.subarray(count);
    if (count) this.send({ type: isLiveModel(this.config.model) ? 'session.input_audio.append' : 'input_audio_buffer.append', audio: chunk.subarray(0, count).toString('base64') });
  }
  /** The contact picked up: start the silence clock, and speak the opening line unless the contact speaks first. */
  answered(): void {
    if (!this.connected || this.pickedUp) return;
    this.pickedUp = true;
    this.lastActivity = Date.now();
    const limit = this.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastActivity < limit) return;
      clearInterval(this.idleTimer);
      this.emit({ type: 'end-call', reason: 'silence' });
    }, Math.min(5_000, limit));
    // Most people say "Hello?" or who they are when they pick up. Answering that sounds natural; talking over it does not.
    // The contact speaking first (speech_started, or a GPT-Live transcript) cancels this timer.
    this.openingTimer = setTimeout(() => this.open(), this.config.openingWaitMs ?? DEFAULT_OPENING_WAIT_MS);
  }
  private open(): void {
    if (!this.connected) return;
    const content = `The person you called has answered. Say, in English: ${this.config.greeting} Then pause and listen. Identify yourself as an AI assistant. Do not repeat the opening line.`;
    if (isLiveModel(this.config.model)) this.send({ type: 'session.instructions.append', event_id: randomUUID(), delegation_id: null, content });
    else this.send({ type: 'response.create', response: { instructions: content } });
  }
  reportPlayback(itemId: string, milliseconds: number): void {
    if (typeof itemId !== 'string' || !Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.playback.set(itemId, milliseconds);
    // Realtime audio arrives several times faster than it plays, so the agent is "speaking" until playback catches up.
    this.lastActivity = Date.now();
  }
  private handle(event: any): void {
    if (this.ending && event.type !== 'session.closed') return;
    switch (event.type) {
      case 'session.output_audio.delta':
      case 'response.output_audio.delta': {
        if (typeof event.delta !== 'string') return;
        if (event.item_id) { this.activeItem = event.item_id; this.emit({ type: 'audio-meta', itemId: event.item_id }); }
        this.emit(Buffer.from(event.delta, 'base64')); break;
      }
      case 'session.input_transcript.delta': this.record('contact', event.delta, event); break;
      case 'session.output_transcript.delta':
      case 'response.output_audio_transcript.delta': this.record('agent', event.delta, event); break;
      case 'conversation.item.input_audio_transcription.delta': {
        if (typeof event.delta !== 'string') break;
        if (typeof event.item_id === 'string') {
          const key = `${event.item_id}:${event.content_index ?? 0}`;
          this.inputTranscripts.set(key, (this.inputTranscripts.get(key) ?? '') + event.delta);
          if (this.inputTranscripts.size > 100) this.inputTranscripts.delete(this.inputTranscripts.keys().next().value!);
        }
        this.record('contact', event.delta, event); break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const key = `${event.item_id}:${event.content_index ?? 0}`;
        const streamed = this.inputTranscripts.get(key);
        if (streamed === undefined) this.record('contact', event.transcript, event);
        else if (typeof event.transcript === 'string' && event.transcript.startsWith(streamed)) this.record('contact', event.transcript.slice(streamed.length), event);
        // A corrected final transcript is separate metadata, not a duplicate appended turn.
        this.emit({ type: 'transcript-final', speaker: 'contact', itemId: event.item_id, text: event.transcript });
        this.inputTranscripts.delete(key); break;
      }
      case 'input_audio_buffer.speech_started':
        clearTimeout(this.openingTimer);
        this.emit({ type: 'clear' });
        if (this.activeItem) this.send({ type: 'conversation.item.truncate', item_id: this.activeItem, content_index: 0, audio_end_ms: Math.floor(this.playback.get(this.activeItem) ?? 0) });
        this.activeItem = undefined; break;
      case 'response.output_item.done':
        // Also emitted for items of an interrupted or cancelled response; a cut-off end_call must not hang up.
        if (event.item?.type === 'function_call' && event.item.status === 'completed') this.toolCalls.push(this.callTool(event.item)); break;
      case 'response.done': {
        // The opening line has been spoken: from now on, a normal pause ends the contact's turn.
        if (!this.firstReplyDone && this.pickedUp && event.response?.status !== 'cancelled') {
          this.firstReplyDone = true;
          // The whole input block, so the update cannot reset the format or the transcription model.
          if (!isLiveModel(this.config.model)) this.send({ type: 'session.update', session: { type: 'realtime', audio: { input: this.inputAudio(TURN_SILENCE_MS) } } });
        }
        // The prompted goodbye finished: hang up, unless the contact cut in ("wait, one more thing"), which cancels it.
        if (this.hangUpAfterResponse) {
          this.hangUpAfterResponse = false;
          if (event.response?.status !== 'cancelled') this.emit({ type: 'end-call', reason: 'agent' });
          break;
        }
        // A response.create sent while a response is active is rejected, so tool follow-ups wait for response.done
        // and for the tools themselves (saving an outcome is asynchronous).
        const calls = this.toolCalls.splice(0);
        if (calls.length) void Promise.all(calls).then(outcomes => {
          if (this.ending) return;
          this.hangUpAfterResponse = outcomes.includes('end');
          this.send({ type: 'response.create', ...(this.hangUpAfterResponse ? { response: { instructions: GOODBYE, tool_choice: 'none' } } : {}) });
        });
        break;
      }
      case 'session.delegation.created':
        if (event.delegation?.target === 'client' && typeof event.delegation.id === 'string') void this.delegate(event.delegation.id); break;
      case 'error': {
        const message = event.error?.message ?? 'OpenAI session error.';
        this.emit({ type: isFatal(event.error) ? 'error' : 'notice', message: `OpenAI: ${message}` }); break;
      }
      case 'session.closed': this.ready = false; this.emit({ type: 'usage', usage: event.usage, final: true }); this.socket?.close(); break;
      case 'session.usage.updated': this.emit({ type: 'usage', usage: event.usage, final: false }); break;
    }
  }
  private record(speaker: string, text: unknown, event: any): void {
    if (typeof text !== 'string') return;
    // GPT-Live has no speech_started event; the contact's first transcript is the sign that they spoke.
    if (speaker === 'contact') clearTimeout(this.openingTimer);
    this.transcript.push({ speaker, text });
    while (this.transcript.length > 300) this.transcript.shift();
    this.emit({ type: 'transcript', speaker, text, start_ms: event.start_ms, end_ms: event.end_ms });
  }
  private async callTool(item: { name?: string; call_id?: string; arguments?: string }): Promise<'continue' | 'end'> {
    let output: object;
    if (item.name === 'end_call') {
      this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify({ ending: true }) } });
      return 'end';
    }
    try {
      if (item.name !== 'record_outcome') throw new Error(`Unknown tool ${item.name}.`);
      if (!this.config.saveOutcome) throw new Error('Outcomes cannot be saved in this session.');
      const args = JSON.parse(item.arguments || '{}');
      const outcome = OUTCOMES.find(value => value === args.outcome);
      if (!outcome) throw new Error(`The outcome must be one of: ${OUTCOMES.join(', ')}.`);
      const summary = text(args.summary, 2000);
      if (!summary) throw new Error('A summary is required.');
      await this.config.saveOutcome({ outcome, summary, callbackTime: text(args.callback_time, 200) });
      output = { saved: true };
    } catch (error) {
      this.emit({ type: 'notice', message: `Tool ${item.name} failed: ${(error as Error).message}` });
      output = { saved: false, error: (error as Error).message };
    }
    this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(output) } });
    return 'continue';
  }
  private async delegate(id: string): Promise<void> {
    if (this.tasks.has(id) || this.ending) return;
    const abort = new AbortController(); this.tasks.set(id, abort);
    const timer = setTimeout(() => abort.abort(), 15_000);
    try {
      // Conversation-only backend: no functions, network searches, or account actions.
      const turns: { speaker: string; text: string }[] = [];
      for (const fragment of this.transcript) {
        const last = turns.at(-1);
        if (last?.speaker === fragment.speaker) last.text += fragment.text;
        else turns.push({ ...fragment });
      }
      const context = turns.map(p => `${p.speaker}: ${p.text}`).join('\n').slice(-12000);
      const backendModel = this.config.backendModel ?? DEFAULT_BACKEND_MODEL;
      // Reasoning models spend output tokens on thinking, so only effort 'none' fits the small budget.
      const effort = backendReasoning(backendModel);
      const response = await fetchWithReason((this.config.httpBase ?? OPENAI_HTTP) + '/v1/responses', {
        method: 'POST', headers: { Authorization: `Bearer ${this.config.key}`, 'Content-Type': 'application/json' }, signal: abort.signal,
        body: JSON.stringify({ model: backendModel, instructions: `${this.config.instructions}\nYou support a live voice assistant on a call it placed. Return at most two short spoken sentences answering the latest thing the contact said in the transcript. You have no tools or access to private accounts; never invent verified records or completed actions. Only state product facts given above; if you aren't sure, say the team can follow up. Transcript fragments may be incomplete or corrected.`, input: context, max_output_tokens: effort === 'none' ? 600 : 2000, reasoning: { effort } }),
      });
      if (!response.ok) throw new Error(`Backend OpenAI ${response.status}`);
      const result = await response.json() as any;
      const text = result.output?.flatMap((item: any) => item.content ?? []).filter((item: any) => item.type === 'output_text').map((item: any) => item.text).join(' ') || result.output_text;
      if (typeof text !== 'string' || !text) throw new Error('Backend returned no answer.');
      if (!this.ending) this.send({ type: 'session.commentary.append', event_id: randomUUID(), delegation_id: id, content: text.slice(0, 1200) });
    } catch (error) {
      if (!this.ending) {
        this.emit({ type: 'notice', message: `Reasoning backend unavailable: ${(error as Error).message}` });
        this.send({ type: 'session.commentary.append', event_id: randomUUID(), delegation_id: id, content: 'I can’t check that right now. I can have the team follow up with you.' });
      }
    } finally { clearTimeout(timer); this.tasks.delete(id); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.ending = true; this.ready = false;
    clearInterval(this.idleTimer); clearTimeout(this.openingTimer);
    for (const task of this.tasks.values()) task.abort();
    this.tasks.clear();
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    this.closing = new Promise(resolve => {
      let finished = false;
      const finish = () => { if (finished) return; finished = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { this.emit({ type: 'notice', message: 'Model finalization timed out; final usage may be unconfirmed.' }); socket.terminate(); finish(); }, 4000);
      socket.once('close', finish);
      if (socket.readyState === WebSocket.OPEN) {
        if (isLiveModel(this.config.model)) this.send({ type: 'session.close' }); else socket.close();
      } else socket.terminate();
    });
    return this.closing;
  }
}

export async function preflight(config: VoiceConfig): Promise<void> {
  const voice = new OpenAIVoice(config, () => {});
  try { await voice.connect(); } finally { await voice.close(); }
}
