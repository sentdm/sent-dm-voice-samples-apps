import { SentVoice } from '@sentdm/voice';
import { INTERNATIONAL_FORMAT_HINT, checkNumberToCall } from '../src/phone.js';
import { DEFAULT_BACKEND_MODEL, DEFAULT_TRANSCRIPTION_MODEL, DEFAULT_VOICE_MODEL, isLiveModel } from '../src/models.js';

type VoiceNumber = {
  number: string;
  status: string;
  default_for_app_calls: boolean;
  callback_url: string | null;
};

type ServerEvent = { id: number; time: string; kind: string; text: string };

type AppState = {
  csrfToken: string;
  configured: boolean;
  keySource?: 'env' | 'dashboard' | null;
  numbers: VoiceNumber[];
  phase: string;
  number?: string;
  identity: string;
  callbackUrl?: string;
  warning?: string;
  error?: string;
  model: string;
  backendModel?: string;
  transcriptionModel?: string;
  greeting: string;
  instructions: string;
  events: ServerEvent[];
  routingBackup?: { number: string; previousUrl: string | null } | null;
};

type BridgeMessage =
  | { type: 'ready'; model: string }
  | { type: 'transcript'; speaker: 'contact' | 'agent'; text: string; start_ms?: number; end_ms?: number }
  | { type: 'clear' }
  | { type: 'error'; message: string }
  | { type: 'closed' }
  | { type: 'end-call'; reason: 'agent' | 'silence' }
  | { type: 'audio-meta'; itemId: string };

// Realtime delivers replies ~6x faster than they play (measured), so its queue must hold a whole answer; Live streams in real time.
const PLAYBACK_LIMIT_MS = { realtime: 120_000, live: 5_000 };

type AudioTestHooks = {
  initAudio: () => Promise<void>;
  softwareStream: () => MediaStream;
  enqueueAudio: (audio: ArrayBuffer) => void;
  attachRemoteStream: (stream: MediaStream) => void;
  clearAudio: () => void;
  shutdownAudio: () => Promise<void>;
};

declare global {
  interface Window {
    __audioTest?: AudioTestHooks;
    __capturedFrames?: ((frame: ArrayBuffer) => void) | ArrayBuffer[];
  }
}

/**
 * Owns the browser-only audio graph. The graph deliberately has no hardware destination:
 * remote provider media is captured at its only input, and model media is emitted solely to
 * a MediaStreamDestination used as the SDK's software microphone.
 */
export class AgentAudioController {
  private context: AudioContext | undefined;
  private processor: AudioWorkletNode | undefined;
  private softwareDestination: MediaStreamAudioDestinationNode | undefined;
  private remoteSource: MediaStreamAudioSourceNode | undefined;
  private remoteStream: MediaStream | undefined;
  private originalGetUserMedia: typeof navigator.mediaDevices.getUserMedia | undefined;
  private initialized: Promise<void> | undefined;
  private drained: (() => void) | undefined;
  /** Whether the SDK has taken the software microphone at least once; false means it reached the hardware microphone some other way. */
  softwareMicrophoneUsed = false;

  onCapture: ((frame: ArrayBuffer) => void) | undefined;
  onRendered: ((itemId: string, audioMs: number) => void) | undefined;
  onOverflow: ((message: string) => void) | undefined;

  async init(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.initialize().catch((error: unknown) => {
        this.initialized = undefined;
        throw error;
      });
    }
    return this.initialized;
  }

  private async initialize(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not support local audio capture on this page.');
    }

    const context = new AudioContext({ sampleRate: 24_000 });
    this.context = context;
    // resume() must be invoked in the synchronous portion of the Start button gesture. Waiting
    // for module download first can leave Chrome's context suspended until another user action.
    const resumed = context.resume();
    await context.audioWorklet.addModule('/audio-worklet.js');

    const processor = new AudioWorkletNode(context, 'sent-agent-pcm', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      outputChannelCount: [1],
    });
    const destination = context.createMediaStreamDestination();
    processor.connect(destination);

    processor.port.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data as { type?: string; audio?: ArrayBuffer; itemId?: string; audioMs?: number; message?: string };
      if (message.type === 'capture' && message.audio instanceof ArrayBuffer) this.onCapture?.(message.audio);
      if (message.type === 'rendered' && typeof message.itemId === 'string' && typeof message.audioMs === 'number') {
        this.onRendered?.(message.itemId, message.audioMs);
      }
      if (message.type === 'overflow') this.onOverflow?.(message.message ?? 'Model audio queue overflowed.');
      if (message.type === 'drained') this.drained?.();
    };

    this.processor = processor;
    this.softwareDestination = destination;
    this.patchGetUserMedia();
    await resumed;
  }

  private patchGetUserMedia(): void {
    if (this.originalGetUserMedia || !this.softwareDestination) return;
    const mediaDevices = navigator.mediaDevices;
    const nativeGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
    this.originalGetUserMedia = nativeGetUserMedia;

    mediaDevices.getUserMedia = async (constraints: MediaStreamConstraints): Promise<MediaStream> => {
      const audioOnly = Boolean(constraints?.audio) && !constraints?.video;
      if (!audioOnly) return nativeGetUserMedia(constraints);
      this.softwareMicrophoneUsed = true;
      // A clone prevents the SDK from stopping the graph's master track when an individual call ends.
      return this.softwareDestination!.stream.clone();
    };
  }

  softwareStream(): MediaStream {
    if (!this.softwareDestination) throw new Error('Audio has not been initialized.');
    return this.softwareDestination.stream;
  }

  setCapturing(enabled: boolean): void {
    this.processor?.port.postMessage({ type: 'capture', enabled });
  }

  setPlaybackLimit(milliseconds: number): void {
    this.processor?.port.postMessage({ type: 'set-playback-limit', milliseconds });
  }

  enqueueAudio(audio: ArrayBuffer, itemId?: string): void {
    if (!this.processor) throw new Error('Audio has not been initialized.');
    const transferable = audio.slice(0);
    this.processor.port.postMessage({ type: 'model-audio', audio: transferable, itemId }, [transferable]);
  }

  clearAudio(): void {
    this.processor?.port.postMessage({ type: 'clear' });
  }

  /** Calls back once every queued model sample has been played into the call. */
  whenDrained(callback: () => void): void {
    this.drained = callback;
    this.processor?.port.postMessage({ type: 'notify-drained' });
  }

  /**
   * Returns false while the stream has no audio track. For a call this tab places, the SDK sets the stream when it
   * dials, before the far end sends media, and createMediaStreamSource() throws on a stream without a track.
   */
  attachRemoteStream(stream: MediaStream): boolean {
    if (!this.context || !this.processor) throw new Error('Audio has not been initialized.');
    if (this.remoteStream === stream) return true;
    if (!stream.getAudioTracks().length) return false;
    const source = this.context.createMediaStreamSource(stream);
    this.remoteSource?.disconnect();
    source.connect(this.processor);
    this.remoteSource = source;
    // Only now: a stream remembered before it could be attached would never be attached later.
    this.remoteStream = stream;
    return true;
  }

  detachRemoteStream(): void {
    this.remoteSource?.disconnect();
    this.remoteSource = undefined;
    this.remoteStream = undefined;
  }

  async shutdown(): Promise<void> {
    this.setCapturing(false);
    this.clearAudio();
    this.detachRemoteStream();
    this.processor?.disconnect();
    this.processor = undefined;
    this.softwareDestination?.disconnect();
    this.softwareDestination?.stream.getTracks().forEach((track) => track.stop());
    this.softwareDestination = undefined;

    if (this.originalGetUserMedia) {
      navigator.mediaDevices.getUserMedia = this.originalGetUserMedia;
      this.originalGetUserMedia = undefined;
    }

    const context = this.context;
    this.context = undefined;
    this.initialized = undefined;
    if (context && context.state !== 'closed') await context.close();
  }
}

class ModelBridge {
  private readonly socket: WebSocket;
  private readonly readyPromise: Promise<void>;
  private readyResolve: (() => void) | undefined;
  private readyReject: ((reason: Error) => void) | undefined;
  private ready = false;
  private closed = false;
  private intentionalClose = false;
  private readyTimer: number | undefined;
  private currentItemId: string | undefined;
  private readonly renderedMs = new Map<string, number>();

  constructor(
    start: { to: string; consent: boolean },
    private readonly handlers: {
      onAudio: (audio: ArrayBuffer, itemId?: string) => void;
      onTranscript: (speaker: 'contact' | 'agent', text: string) => void;
      onReady: (model: string) => void;
      onClear: () => void;
      onError: (message: string) => void;
      onEndCall: () => void;
      onClosed: (intentional: boolean) => void;
    },
  ) {
    // Use the exact local host that served the page so the server's local-only Origin check passes
    // for both http://localhost:<port> and http://127.0.0.1:<port>.
    this.socket = new WebSocket(`ws://${window.location.host}/bridge?token=${encodeURIComponent(csrfToken)}`);
    this.socket.binaryType = 'arraybuffer';
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.readyTimer = window.setTimeout(() => {
      this.failBeforeReady('The local model bridge did not become ready in time.');
      this.close(false);
    }, 20_000);

    this.socket.onopen = () => this.sendJson({ type: 'start', ...start });
    this.socket.onmessage = (event) => this.receive(event.data);
    this.socket.onerror = () => {
      if (!this.ready) this.failBeforeReady('The local model bridge could not be opened.');
    };
    this.socket.onclose = () => {
      if (this.closed) return;
      this.closed = true;
      window.clearTimeout(this.readyTimer);
      if (!this.ready) this.failBeforeReady('The local model bridge closed before it was ready.');
      this.handlers.onClosed(this.intentionalClose);
    };
  }

  waitForReady(): Promise<void> {
    return this.readyPromise;
  }

  private receive(payload: unknown): void {
    if (payload instanceof ArrayBuffer) {
      this.handlers.onAudio(payload, this.currentItemId);
      return;
    }
    if (payload instanceof Blob) {
      void payload.arrayBuffer().then((audio) => this.handlers.onAudio(audio, this.currentItemId));
      return;
    }
    if (typeof payload !== 'string') return;

    let message: BridgeMessage;
    try {
      message = JSON.parse(payload) as BridgeMessage;
    } catch {
      this.fail('The local model bridge returned an invalid control message.');
      return;
    }

    switch (message.type) {
      case 'ready':
        if (!this.ready) {
          this.ready = true;
          window.clearTimeout(this.readyTimer);
          this.handlers.onReady(message.model);
          this.readyResolve?.();
        }
        break;
      case 'audio-meta':
        this.currentItemId = message.itemId;
        break;
      case 'transcript':
        this.handlers.onTranscript(message.speaker, message.text);
        break;
      case 'clear':
        this.handlers.onClear();
        break;
      case 'error':
        this.fail(message.message);
        break;
      case 'end-call':
        this.handlers.onEndCall();
        break;
      case 'closed':
        // A server-originated close always ends the provider call; only this client calls stop().
        this.close(false);
        break;
    }
  }

  sendAudio(audio: ArrayBuffer): void {
    if (this.ready && this.socket.readyState === WebSocket.OPEN) this.socket.send(audio);
  }

  reportRendered(itemId: string, incrementalMs: number): void {
    if (!this.ready || !Number.isFinite(incrementalMs)) return;
    const cumulative = (this.renderedMs.get(itemId) ?? 0) + incrementalMs;
    this.renderedMs.set(itemId, cumulative);
    this.sendJson({ type: 'playback', itemId, audioMs: cumulative });
  }

  answered(): void {
    this.sendJson({ type: 'answered' });
  }

  stop(): void {
    this.sendJson({ type: 'stop' });
    this.close(true);
  }

  close(intentional = true): void {
    this.intentionalClose ||= intentional;
    if (this.closed) return;
    window.clearTimeout(this.readyTimer);
    if (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }

  private sendJson(message: Record<string, unknown>): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  /** Before ready, a failure is the reason the call was not placed (for example, a number the server refused). */
  private fail(message: string): void {
    if (this.ready) this.handlers.onError(message);
    else this.failBeforeReady(message);
  }

  private failBeforeReady(message: string): void {
    if (this.ready) return;
    window.clearTimeout(this.readyTimer);
    this.readyReject?.(new Error(message));
  }
}

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: ${id}`);
  return element as T;
};

const dom = {
  credentialsForm: $<HTMLFormElement>('credentials-form'),
  settingsForm: $<HTMLFormElement>('settings-form'),
  sentKey: $<HTMLInputElement>('sent-key'),
  openaiKey: $<HTMLInputElement>('openai-key'),
  connectButton: $<HTMLButtonElement>('connect-button'),
  credentialsNote: $<HTMLParagraphElement>('credentials-note'),
  credentialsPanel: $<HTMLDetailsElement>('credentials-panel'),
  credentialsStatus: $<HTMLSpanElement>('credentials-status'),
  number: $<HTMLSelectElement>('number-select'),
  numberNote: $<HTMLParagraphElement>('number-note'),
  model: $<HTMLSelectElement>('model-select'),
  transcriptionModel: $<HTMLSelectElement>('transcription-model-select'),
  backendModel: $<HTMLSelectElement>('backend-model-select'),
  modelNote: $<HTMLParagraphElement>('model-note'),
  greeting: $<HTMLInputElement>('greeting-input'),
  instructions: $<HTMLTextAreaElement>('instructions-input'),
  start: $<HTMLButtonElement>('start-button'),
  stop: $<HTMLButtonElement>('stop-button'),
  forgetBackup: $<HTMLButtonElement>('forget-backup-button'),
  dialForm: $<HTMLFormElement>('dial-form'),
  dialNumber: $<HTMLInputElement>('dial-number'),
  consent: $<HTMLInputElement>('consent-checkbox'),
  call: $<HTMLButtonElement>('call-button'),
  hangup: $<HTMLButtonElement>('hangup-button'),
  statusDot: $<HTMLDivElement>('status-dot'),
  status: $<HTMLParagraphElement>('status-text'),
  identity: $<HTMLDListElement>('identity-value'),
  activeNumber: $<HTMLDListElement>('active-number-value'),
  callback: $<HTMLElement>('callback-value'),
  callTitle: $<HTMLHeadingElement>('call-title'),
  callDetail: $<HTMLParagraphElement>('call-detail'),
  transcriptState: $<HTMLSpanElement>('transcript-state'),
  transcript: $<HTMLOListElement>('transcript-log'),
  events: $<HTMLOListElement>('event-log'),
  remoteAudio: $<HTMLAudioElement>('remote-audio'),
};

dom.remoteAudio.muted = true;
dom.remoteAudio.volume = 0;

let csrfToken = '';
let appState: AppState | undefined;
let audio: AgentAudioController | undefined;
let voice: SentVoice | undefined;
let bridge: ModelBridge | undefined;
let activeCall: SentVoice.Call | undefined;
/** The call being set up, from Call until connect() returns; Hang up cancels it. */
let dialAttempt: { cancelled: boolean } | undefined;
let online = false;
let starting = false;
let stopping = false;
let registered = false;
let heartbeatTicker: Worker | undefined;
let statePollTimer: number | undefined;
let remoteWatchTimer: number | undefined;
let callAnswered = false;
let lastServerEventId = 0;
let credentialsPanelSettled = false;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function setStatus(kind: 'idle' | 'ready' | 'active' | 'error', text: string): void {
  dom.statusDot.dataset.kind = kind;
  dom.status.textContent = text;
}

function addEvent(kind: string, text: string, time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })): void {
  const item = document.createElement('li');
  const timeNode = document.createElement('time');
  const textNode = document.createElement('span');
  timeNode.textContent = time;
  textNode.textContent = `${kind}: ${text}`;
  item.append(timeNode, textNode);
  dom.events.append(item);
  while (dom.events.children.length > 80) dom.events.firstElementChild?.remove();
  dom.events.scrollTop = dom.events.scrollHeight;
}

function addTranscript(speaker: 'contact' | 'agent', text: string): void {
  const empty = dom.transcript.querySelector('.empty-state');
  empty?.remove();
  const previous = dom.transcript.lastElementChild as HTMLElement | null;
  if (previous?.dataset.speaker === speaker) {
    const words = previous.querySelector('.words');
    if (words) words.textContent = (words.textContent ?? '') + text;
    dom.transcript.scrollTop = dom.transcript.scrollHeight;
    return;
  }
  const item = document.createElement('li');
  item.className = `transcript-entry ${speaker}`;
  item.dataset.speaker = speaker;
  const label = document.createElement('span');
  label.className = 'speaker';
  label.textContent = speaker;
  const words = document.createElement('span');
  words.className = 'words';
  words.textContent = text;
  item.append(label, words);
  dom.transcript.append(item);
  while (dom.transcript.children.length > 120) dom.transcript.firstElementChild?.remove();
  dom.transcript.scrollTop = dom.transcript.scrollHeight;
}

function showCall(title: string, detail: string, state: string): void {
  dom.callTitle.textContent = title;
  dom.callDetail.textContent = detail;
  dom.transcriptState.textContent = state;
}

function resetCallView(detail = online ? 'Enter a number in international format and click Call.' : 'Start the agent, then enter a number and click Call.'): void {
  showCall('No call', detail, 'NO ACTIVE CALL');
}

function updateButtons(): void {
  const configured = Boolean(appState?.configured && dom.number.value);
  const stopped = !starting && !online && !stopping;
  dom.connectButton.disabled = starting || stopping || online;
  dom.number.disabled = !appState?.configured || !stopped;
  dom.model.disabled = !stopped;
  updateModelControls();
  dom.greeting.disabled = !stopped;
  dom.instructions.disabled = !stopped;
  dom.start.disabled = !configured || !stopped;
  dom.stop.disabled = stopping || (!online && !starting && !appState?.routingBackup);
  dom.forgetBackup.hidden = !appState?.routingBackup || !stopped;
  const canDial = online && !stopping && !dialAttempt && !activeCall;
  dom.dialNumber.disabled = !canDial;
  dom.consent.disabled = !canDial;
  dom.call.disabled = !canDial;
  dom.hangup.disabled = (!activeCall && !dialAttempt) || stopping;
}

function updateModelControls(): void {
  const stopped = !starting && !online && !stopping;
  const realtime = !isLiveModel(dom.model.value);
  dom.transcriptionModel.disabled = !stopped || !realtime;
  dom.backendModel.disabled = !stopped || realtime;
  // Show only the setting the chosen voice model uses; a greyed-out field read as broken rather than "not applicable".
  for (const [field, shown] of [[dom.transcriptionModel, realtime], [dom.backendModel, !realtime]] as const) {
    field.hidden = !shown;
    for (const label of field.labels) label.hidden = !shown;
  }
  dom.modelNote.textContent = realtime
    ? 'Realtime models hear the call directly and can record the outcome and hang up. Contact transcription only feeds the dashboard.'
    : 'GPT-Live listens while it speaks and hands text questions to the text helper, which never hears audio. It can’t record outcomes or hang up in this app.';
}

function updateNumberNote(): void {
  const selected = appState?.numbers.find(item => item.number === dom.number.value);
  dom.numberNote.textContent = selected && !selected.callback_url
    ? 'No existing callback: Stop cannot clear a temporary callback to null. Use a test number and set your desired routing in Sent afterward.'
    : 'The contact sees this number. Start temporarily replaces its callback; Stop attempts to restore it.';
}

function renderState(state: AppState): void {
  appState = state;
  // A restarted server issues a new token and numbers its events from 1 again.
  if (state.csrfToken !== csrfToken) lastServerEventId = 0;
  csrfToken = state.csrfToken;
  dom.identity.textContent = state.identity || '—';
  dom.activeNumber.textContent = state.number || '—';
  // Installed on the number by Start (tunnel URL + random path) and restored by Stop; never entered by hand.
  dom.callback.textContent = state.callbackUrl || 'Created on Start';
  dom.credentialsStatus.textContent = !state.configured ? 'Not connected' : state.keySource === 'env' ? 'Connected · environment' : 'Connected';
  // Keys are technical setup: show them only while they're still needed, and decide once so the user's own toggle sticks.
  if (!credentialsPanelSettled) { dom.credentialsPanel.open = !state.configured; credentialsPanelSettled = true; }
  dom.credentialsNote.textContent = state.keySource === 'env'
    ? 'Using SENT_DM_API_KEY and OPENAI_API_KEY from the server environment. Enter keys here to override them for this session.'
    : 'Keys stay in server memory. You can also set SENT_DM_API_KEY and OPENAI_API_KEY before starting the app.';

  const priorNumber = dom.number.value || state.number || state.numbers.find((item) => item.default_for_app_calls)?.number || '';
  dom.number.replaceChildren();
  if (!state.numbers.length) {
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = state.configured ? 'No active voice numbers found' : 'Connect keys to discover numbers';
    dom.number.append(emptyOption);
    dom.numberNote.textContent = state.configured
      ? 'No active Sent voice number is available for this account.'
      : 'Only existing, active Sent voice numbers are available.';
  } else {
    for (const number of state.numbers) {
      const option = document.createElement('option');
      option.value = number.number;
      option.textContent = `${number.number} · ${number.status}${number.default_for_app_calls ? ' · default' : ''}`;
      option.selected = number.number === priorNumber;
      dom.number.append(option);
    }
    updateNumberNote();
  }

  if (!online && !starting && !stopping) {
    dom.model.value = state.model || DEFAULT_VOICE_MODEL;
    if (!dom.model.value) dom.model.value = DEFAULT_VOICE_MODEL;
    dom.transcriptionModel.value = state.transcriptionModel || DEFAULT_TRANSCRIPTION_MODEL;
    if (!dom.transcriptionModel.value) dom.transcriptionModel.value = DEFAULT_TRANSCRIPTION_MODEL;
    dom.backendModel.value = state.backendModel || DEFAULT_BACKEND_MODEL;
    if (!dom.backendModel.value) dom.backendModel.value = DEFAULT_BACKEND_MODEL;
    if (state.greeting) dom.greeting.value = state.greeting;
    if (state.instructions) dom.instructions.value = state.instructions;
  }

  for (const event of state.events ?? []) {
    if (event.id <= lastServerEventId) continue;
    lastServerEventId = event.id;
    addEvent(event.kind, event.text, event.time);
  }

  if (!online && !starting && !stopping) {
    if (state.error) setStatus('error', state.error);
    else if (state.warning) setStatus('idle', state.warning);
    else if (state.configured && state.numbers.length) setStatus('idle', 'Keys connected. Review the behavior, then start the agent.');
    else if (state.configured) setStatus('error', 'No active voice number was discovered.');
    else setStatus('idle', 'Add both keys to configure this local operator console.');
  }
  updateButtons();

  // The local watchdog can restore routing after a stale browser heartbeat. Do not POST /stop
  // again in that case; simply remove this tab's registration and patched media graph.
  if (online && state.phase === 'offline' && !stopping) {
    online = false;
    registered = false;
    stopHeartbeat();
    stopStatePolling();
    addEvent('routing', 'The local service is offline; browser voice registration was cleaned up.');
    void cleanUpBrowserVoice();
    setStatus('error', state.error || 'The local service stopped the agent and restored routing.');
  }
}

async function readFailure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === 'string') return body.error;
    if (typeof body.message === 'string') return body.message;
  } catch {
    // The server may return an empty error body.
  }
  return `Local service request failed (${response.status}).`;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  if (!csrfToken) throw new Error('The local service has not issued a CSRF token yet. Refresh the page and try again.');
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readFailure(response));
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function refreshState(): Promise<void> {
  const response = await fetch('/api/state', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(await readFailure(response));
  renderState((await response.json()) as AppState);
}

async function getVoiceToken(): Promise<string> {
  const response = await postJson<{ token: string }>('/api/voice-token', {});
  if (!response.token) throw new Error('The local service did not return a voice token.');
  return response.token;
}

function settingsPayload(): {
  number: string;
  model: string;
  transcriptionModel: string;
  backendModel: string;
  greeting: string;
  instructions: string;
} {
  return {
    number: dom.number.value,
    model: dom.model.value,
    transcriptionModel: dom.transcriptionModel.value,
    backendModel: dom.backendModel.value,
    greeting: dom.greeting.value.trim(),
    instructions: dom.instructions.value.trim(),
  };
}

async function postHeartbeat(): Promise<void> {
  await postJson<unknown>('/api/heartbeat', { registered });
}

function reportHeartbeatFailure(error: unknown): void {
  if (online || starting) setStatus('error', errorMessage(error, 'Heartbeat to the local service failed.'));
}

const beat = () => void postHeartbeat().catch(reportHeartbeatFailure);

// Chrome stretches chained page timers in a hidden tab to once a minute ("intensive throttling"), which would trip the
// server's 7-second watchdog and silently restore routing. Dedicated-worker timers are exempt, so a worker keeps time
// and the page answers each tick with a heartbeat carrying its current state.
const heartbeatTickerUrl = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 2000);'], { type: 'text/javascript' }));

/** Beats now and every 2 s until stopHeartbeat(); resolves once the first beat is accepted. */
function startHeartbeat(): Promise<void> {
  stopHeartbeat();
  heartbeatTicker = new Worker(heartbeatTickerUrl);
  heartbeatTicker.onmessage = beat;
  return postHeartbeat();
}

function stopHeartbeat(): void {
  heartbeatTicker?.terminate();
  heartbeatTicker = undefined;
}

function startStatePolling(): void {
  window.clearInterval(statePollTimer);
  statePollTimer = window.setInterval(() => {
    void refreshState().catch((error: unknown) => {
      if (online) setStatus('error', errorMessage(error, 'Could not read local service state.'));
    });
  }, 3_000);
}

function stopStatePolling(): void {
  window.clearInterval(statePollTimer);
  statePollTimer = undefined;
}

function stopRemoteWatch(): void {
  window.clearInterval(remoteWatchTimer);
  remoteWatchTimer = undefined;
  dom.remoteAudio.onloadedmetadata = null;
}

/** Returns true once the contact's stream feeds the worklet. */
function attachCurrentRemoteStream(): boolean {
  const stream = dom.remoteAudio.srcObject;
  if (!(stream instanceof MediaStream)) return false;
  try {
    return audio?.attachRemoteStream(stream) ?? false;
  } catch (error) {
    setStatus('error', errorMessage(error, 'The remote call audio could not be connected.'));
    return false;
  }
}

/** Attaches the contact's stream once it has a track, and again if the SDK replaces it, until the call ends. */
/** Runs when the call connects or reconnects. The stream can get its track a moment later, so it retries for up to 10 s. */
function watchRemoteAudio(): void {
  stopRemoteWatch();
  dom.remoteAudio.onloadedmetadata = () => void attachCurrentRemoteStream();
  if (attachCurrentRemoteStream()) return;
  let checks = 0;
  remoteWatchTimer = window.setInterval(() => {
    if (attachCurrentRemoteStream() || ++checks >= 40) window.clearInterval(remoteWatchTimer);
  }, 250);
}

function initializeAudio(): AgentAudioController {
  const controller = new AgentAudioController();
  controller.onCapture = (frame) => bridge?.sendAudio(frame);
  controller.onRendered = (itemId, audioMs) => bridge?.reportRendered(itemId, audioMs);
  controller.onOverflow = (message) => {
    addEvent('audio', message);
    setStatus('error', `${message} Ending the call to prevent lost speech.`);
    bridge?.stop();
    void activeCall?.disconnect();
  };
  return controller;
}

function setupVoiceClient(): SentVoice {
  // SDK warnings and errors are the main evidence when a real call misbehaves; the SDK redacts tokens from them.
  const sdkLog = (level: string) => (message: string) => addEvent(`sdk ${level}`, message);
  const client = new SentVoice({
    tokenProvider: getVoiceToken,
    logLevel: 'warn',
    logger: { error: sdkLog('error'), warn: sdkLog('warn'), info: () => {}, debug: () => {} },
    serviceWorker: { url: '/sw.js', scope: '/' },
    audio: { element: dom.remoteAudio },
  });
  client.on('registered', () => {
    registered = true;
    addEvent('voice', 'Browser voice registration is ready.');
    beat();
    if (online && !activeCall) setStatus('ready', 'Voice registration is back. Ready to place calls.');
  });
  // The gateway never answers connectToUser, so no call should ring here; this is a safeguard.
  client.on('incomingCall', (invite) => {
    addEvent('call', 'Rejected an incoming call: this agent only places calls.');
    void invite.reject().catch(() => {});
  });
  client.on('offline', (reason) => {
    // The SDK retries about every 30 s on its own and a call in progress continues; connect() throws until it is back.
    registered = false;
    addEvent('voice', `${reason.message} Retrying automatically; calls can’t be placed until it reconnects.`);
    beat();
    if (online) setStatus('error', 'Voice registration is offline and retrying. Calls can’t be placed until it reconnects.');
  });
  client.on('error', (error) => {
    addEvent('voice', error.message);
    if (online) setStatus('error', error.message);
  });
  return client;
}

function bindCall(call: SentVoice.Call, to: string): void {
  activeCall = call;
  showCall(`Calling ${to}`, `Provider call ${call.id}`, call.state === 'ringing' ? 'RINGING' : 'DIALING');
  updateButtons();

  call.on('ringing', () => {
    if (activeCall !== call) return;
    showCall(`Calling ${to}`, `Ringing · provider call ${call.id}`, 'RINGING');
    addEvent('call', `Ringing ${to}.`);
  });
  // The phone was picked up; `connected` follows once the call audio is set up, and only then does the agent listen.
  call.on('answered', () => {
    if (activeCall !== call) return;
    showCall(`Calling ${to}`, `Answered · connecting the audio · provider call ${call.id}`, 'ANSWERED');
    addEvent('call', `${to} picked up; connecting the audio.`);
  });
  call.on('connected', () => onCallConnected(call, to));
  call.on('reconnecting', () => {
    dom.callDetail.textContent = 'Call media is reconnecting.';
    addEvent('call', 'Call media is reconnecting.');
  });
  call.on('reconnected', () => {
    dom.callDetail.textContent = `Provider call ${call.id}`;
    watchRemoteAudio();
  });
  call.on('error', (error) => {
    addEvent('call', error.message);
    setStatus('error', error.message);
  });
  call.on('disconnected', (info) => void onCallDisconnected(call, info.state));

  if (call.state === 'connected') onCallConnected(call, to);
}

function onCallConnected(call: SentVoice.Call, to: string): void {
  if (activeCall !== call || callAnswered) return;
  // The software microphone depends on the SDK calling navigator.mediaDevices.getUserMedia, which this tab patches. An SDK
  // that stopped doing so would open the real microphone and send room audio to the contact, so end the call instead.
  if (audio && !audio.softwareMicrophoneUsed) {
    const message = 'The Sent SDK did not take the software microphone and may be using this computer’s microphone. Ending the call; check the @sentdm/voice version.';
    addEvent('audio', message);
    setStatus('error', message);
    bridge?.stop();
    void call.disconnect();
    return;
  }
  callAnswered = true;
  showCall(`Talking with ${to}`, `Provider call ${call.id}`, 'CALL ACTIVE');
  setStatus('active', `On a call with ${to}.`);
  watchRemoteAudio();
  // Only now: before the answer the line carries ringback and carrier messages, which the model must not hear.
  audio?.setCapturing(true);
  bridge?.answered();
}

const ENDINGS: Record<SentVoice.DisconnectInfo['state'], string> = {
  completed: 'The call ended.',
  busy: 'The line was busy or the call was declined.',
  noAnswer: 'Nobody answered.',
  failed: 'The call failed. See the event log.',
};

async function onCallDisconnected(call: SentVoice.Call, state: SentVoice.DisconnectInfo['state']): Promise<void> {
  if (activeCall !== call) return;
  addEvent('call', `Call ended (${state}).`);
  activeCall = undefined;
  callAnswered = false;
  stopRemoteWatch();
  dom.remoteAudio.srcObject = null;
  audio?.setCapturing(false);
  audio?.clearAudio();
  audio?.detachRemoteStream();
  bridge?.stop();
  bridge = undefined;
  const ending = ENDINGS[state] ?? `The call ended (${state}).`;
  resetCallView(ending);
  if (online) setStatus(state === 'failed' ? 'error' : 'ready', `${ending} Ready for the next call.`);
  updateButtons();
}

/** Hangs up once the agent's last words have played into the call, so a goodbye is not cut off. */
function endCallAfterPlayback(): void {
  const call = activeCall;
  if (!call) return;
  audio?.setCapturing(false);
  let fallback: number | undefined;
  const finish = () => { window.clearTimeout(fallback); if (activeCall === call) void call.disconnect(); };
  // The queue never holds more than the Realtime cap, so draining can't legitimately take longer; a stuck queue can't hold the line open.
  fallback = window.setTimeout(finish, PLAYBACK_LIMIT_MS.realtime + 1_000);
  if (audio) audio.whenDrained(finish);
  else finish();
}

async function placeCall(): Promise<void> {
  const client = voice;
  if (!online || !client || dialAttempt || activeCall || stopping) return;
  const { to, error } = checkNumberToCall(dom.dialNumber.value, appState?.number, dom.consent.checked);
  if (error !== undefined) {
    setStatus('error', error);
    if (error === INTERNATIONAL_FORMAT_HINT) dom.dialNumber.focus();
    return;
  }
  dom.dialNumber.value = to;
  const attempt = dialAttempt = { cancelled: false };
  showCall(`Calling ${to}`, 'Opening the model session before dialing.', 'PREPARING MODEL');
  setStatus('active', `Calling ${to}…`);
  updateButtons();

  let localBridge: ModelBridge | undefined;
  try {
    // The model session opens first, so the agent is ready the moment the contact picks up.
    localBridge = new ModelBridge({ to, consent: true }, {
      onAudio: (pcm, itemId) => audio?.enqueueAudio(pcm, itemId),
      onTranscript: addTranscript,
      onReady: (model) => audio?.setPlaybackLimit(isLiveModel(model) ? PLAYBACK_LIMIT_MS.live : PLAYBACK_LIMIT_MS.realtime),
      onClear: () => audio?.clearAudio(),
      onEndCall: endCallAfterPlayback, // The server's event log already records why.
      onError: (message) => {
        addEvent('model', message);
        setStatus('error', message);
        audio?.setCapturing(false);
        audio?.clearAudio();
        void activeCall?.disconnect();
      },
      onClosed: (intentional) => {
        if (bridge !== localBridge) return;
        bridge = undefined;
        audio?.setCapturing(false);
        audio?.clearAudio();
        if (!intentional && activeCall) {
          addEvent('model', 'The local model connection closed. Ending the provider call.');
          void activeCall.disconnect();
        }
      },
    });
    bridge = localBridge;
    await localBridge.waitForReady();
    if (attempt.cancelled) return;
    showCall(`Calling ${to}`, 'Asking Sent to place the call.', 'DIALING');
    const call = await client.connect({ to });
    bindCall(call, to);
    // Hang up, or a model failure, while Sent was setting the call up: both clear the bridge.
    if (bridge !== localBridge) void call.disconnect();
  } catch (error) {
    if (!attempt.cancelled) {
      const message = errorMessage(error, 'The call could not be placed.');
      addEvent('call', message);
      setStatus('error', message);
    }
    localBridge?.close(true);
    if (bridge === localBridge) bridge = undefined;
    if (!activeCall) resetCallView(attempt.cancelled ? 'Call cancelled.' : undefined);
  } finally {
    if (dialAttempt === attempt) dialAttempt = undefined;
    updateButtons();
  }
}

function hangUp(): void {
  if (dialAttempt) dialAttempt.cancelled = true;
  audio?.setCapturing(false);
  bridge?.stop();
  bridge = undefined;
  if (activeCall) {
    void activeCall.disconnect();
    return;
  }
  resetCallView('Call cancelled.');
  if (online) setStatus('ready', 'Call cancelled. Ready for the next call.');
}

async function cleanUpBrowserVoice(): Promise<void> {
  stopRemoteWatch();
  if (dialAttempt) dialAttempt.cancelled = true;
  bridge?.stop();
  bridge = undefined;
  if (activeCall) await activeCall.disconnect().catch(() => {});
  activeCall = undefined;
  callAnswered = false;

  const client = voice;
  voice = undefined;
  registered = false;
  if (client) await client.destroy().catch(() => {});

  const controller = audio;
  audio = undefined;
  if (controller) await controller.shutdown().catch(() => {});
  dom.remoteAudio.srcObject = null;
  resetCallView();
  updateButtons();
}

async function startAgent(): Promise<void> {
  if (starting || online || !appState?.configured) return;
  if (!dom.number.value) {
    setStatus('error', 'Select an active existing voice number first.');
    return;
  }

  starting = true;
  updateButtons();
  // These must begin before this async handler reaches its first await, preserving the user
  // gesture required by browser audio and the SDK's notification permission prompt.
  audio = initializeAudio();
  const audioInitialization = audio.init();
  const notificationPermission: Promise<NotificationPermission> =
    'Notification' in window ? Notification.requestPermission().catch(() => 'denied' as NotificationPermission) : Promise.resolve('denied');
  setStatus('idle', 'Preparing browser audio and notification permission…');
  try {
    const [, permission] = await Promise.all([audioInitialization, notificationPermission]);
    if (permission !== 'granted') throw new Error('Notification permission is required to register this browser with Sent.');
    audio.setCapturing(false);

    setStatus('idle', 'Saving behavior and preparing the temporary callback tunnel…');
    await postJson<unknown>('/api/settings', settingsPayload());
    await postJson<unknown>('/api/prepare', {});
    addEvent('routing', 'Temporary callback tunnel is prepared; current routing is unchanged.');

    voice = setupVoiceClient();
    await voice.register();
    if (!registered || voice.state !== 'registered') throw new Error('Browser voice registration did not complete.');
    await startHeartbeat();

    setStatus('idle', 'Browser voice registration is ready. Activating routing…');
    await postJson<unknown>('/api/activate', {});
    online = true;
    startStatePolling();
    addEvent('routing', 'Routing activated after browser registration completed.');
    setStatus('ready', 'Ready to place calls. Keep this browser tab open.');
    resetCallView();
  } catch (error) {
    const message = errorMessage(error, 'Could not start the agent.');
    await stopAndRestore(true);
    setStatus('error', message);
    addEvent('error', message);
  } finally {
    starting = false;
    updateButtons();
    await refreshState().catch((error: unknown) => setStatus('error', errorMessage(error, 'Could not refresh local state.')));
  }
}

async function stopAndRestore(quiet = false): Promise<void> {
  if (stopping) return;
  stopping = true;
  updateButtons();
  if (!quiet) setStatus('idle', 'Restoring the number’s prior callback routing…');

  // The server restore happens first while the registration heartbeat is still alive.
  try {
    await postJson<unknown>('/api/stop', {});
    addEvent('routing', 'Routing restore was requested from the local service.');
  } catch (error) {
    if (!quiet) setStatus('error', errorMessage(error, 'Could not restore callback routing.'));
  } finally {
    online = false;
    await cleanUpBrowserVoice();
    stopHeartbeat();
    stopStatePolling();
    starting = false;
    stopping = false;
    updateButtons();
  }

  if (!quiet) {
    setStatus('idle', 'Stopped locally. Check the event log for routing restore status.');
    await refreshState().catch(() => {});
  }
}

async function configure(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!dom.sentKey.value || !dom.openaiKey.value) {
    setStatus('error', 'Enter both external API keys.');
    return;
  }
  dom.connectButton.disabled = true;
  setStatus('idle', 'Validating keys and discovering active voice numbers…');
  try {
    await postJson<unknown>('/api/configure', { sentKey: dom.sentKey.value, openaiKey: dom.openaiKey.value });
    // Keys are sent once to the local server and never persisted by this browser.
    dom.sentKey.value = '';
    dom.openaiKey.value = '';
    dom.credentialsPanel.open = false;
    await refreshState();
    addEvent('setup', 'Keys validated; active voice numbers were discovered.');
  } catch (error) {
    setStatus('error', errorMessage(error, 'Key validation failed.'));
  } finally {
    updateButtons();
  }
}

async function forgetBackup(): Promise<void> {
  const saved = appState?.routingBackup;
  if (!saved) return;
  const consequence = saved.previousUrl
    ? `Its previous callback will NOT be restored by this app:\n${saved.previousUrl}\nSet it in Sent yourself if you still need it.`
    : 'It had no previous callback, so there is nothing this app could restore.';
  if (!window.confirm(`Forget the saved routing for ${saved.number}?\n\n${consequence}`)) return;
  try {
    await postJson<unknown>('/api/forget-backup', {});
    await refreshState();
  } catch (error) {
    setStatus('error', errorMessage(error, 'Could not forget the routing backup.'));
  }
}

function installAudioTestHooks(): void {
  if (new URLSearchParams(window.location.search).get('audio-test') !== '1') return;
  if (!Array.isArray(window.__capturedFrames) && typeof window.__capturedFrames !== 'function') {
    window.__capturedFrames = [];
  }
  let testAudio: AgentAudioController | undefined;
  const controller = async (): Promise<AgentAudioController> => {
    if (!testAudio) {
      testAudio = new AgentAudioController();
      testAudio.onCapture = (frame) => {
        const sink = window.__capturedFrames;
        if (typeof sink === 'function') sink(frame);
        else if (Array.isArray(sink)) sink.push(frame);
      };
      await testAudio.init();
      testAudio.setCapturing(true);
    }
    return testAudio;
  };

  window.__audioTest = {
    initAudio: async () => { await controller(); },
    softwareStream: () => {
      if (!testAudio) throw new Error('Call initAudio() before requesting the software stream.');
      return testAudio.softwareStream();
    },
    enqueueAudio: (pcm) => {
      if (!testAudio) throw new Error('Call initAudio() before enqueueAudio().');
      testAudio.enqueueAudio(pcm);
    },
    attachRemoteStream: (stream) => {
      if (!testAudio) throw new Error('Call initAudio() before attachRemoteStream().');
      testAudio.attachRemoteStream(stream);
    },
    clearAudio: () => testAudio?.clearAudio(),
    shutdownAudio: async () => {
      await testAudio?.shutdown();
      testAudio = undefined;
    },
  };
}

dom.credentialsForm.addEventListener('submit', (event) => void configure(event as SubmitEvent));
dom.settingsForm.addEventListener('submit', (event) => event.preventDefault());
dom.dialForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void placeCall();
});
dom.number.addEventListener('change', updateNumberNote);
dom.model.addEventListener('change', updateModelControls);
dom.start.addEventListener('click', () => void startAgent());
dom.stop.addEventListener('click', () => void stopAndRestore());
dom.forgetBackup.addEventListener('click', () => void forgetBackup());
dom.hangup.addEventListener('click', hangUp);

installAudioTestHooks();
void refreshState().catch((error: unknown) => {
  setStatus('error', errorMessage(error, 'The local service is not reachable. Start the app and refresh this page.'));
  updateButtons();
});
