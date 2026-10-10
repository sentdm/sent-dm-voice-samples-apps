type Listener = (...args: any[]) => void;

type FakeVoiceOptions = {
  tokenProvider: () => Promise<string>;
  audio?: { element?: HTMLAudioElement };
};

type EventRecord = { type: string; at: number; [key: string]: unknown };
type EndState = 'completed' | 'failed' | 'busy' | 'noAnswer';
const ENDED: readonly string[] = ['completed', 'failed', 'busy', 'noAnswer'] satisfies EndState[];

class Emitter {
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    let eventListeners = this.listeners.get(event);
    if (!eventListeners) {
      eventListeners = new Set();
      this.listeners.set(event, eventListeners);
    }
    eventListeners.add(listener);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

/** An outbound call; the test moves it through ringing, the answer, and its end. */
class FakeCall extends Emitter {
  readonly to: { kind: 'number'; number: string };
  state = 'initiated';
  private tone: AudioContext | undefined;

  /** `incoming` is the stream the SDK plays the far end into; like the real SDK, it has no track until the answer. */
  constructor(readonly id: string, to: string, private readonly incoming: MediaStream) {
    super();
    this.to = { kind: 'number', number: to };
  }

  ring(): void {
    this.state = 'ringing';
    this.emit('ringing');
  }

  /** The contact picks up and speaks: a 440 Hz tone becomes the stream's track, added by script as the real SDK does. */
  answer(): void {
    this.state = 'answered';
    this.emit('answered');
    const context = this.tone = new AudioContext({ sampleRate: 24_000 });
    const oscillator = context.createOscillator();
    const destination = context.createMediaStreamDestination();
    const gain = context.createGain();
    gain.gain.value = 0.5;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    this.incoming.addTrack(destination.stream.getAudioTracks()[0]);
    this.state = 'connected';
    this.emit('connected');
  }

  end(state: EndState): void {
    if (ENDED.includes(this.state)) return;
    this.state = state;
    void this.tone?.close();
    this.emit('disconnected', { state });
  }

  async disconnect(): Promise<void> {
    if (ENDED.includes(this.state)) return;
    fake.disconnectCount += 1;
    this.end('completed');
  }
}

class FakeInvite extends Emitter {
  private rejected = false;

  constructor(readonly from: string) {
    super();
  }

  async accept(): Promise<never> {
    throw new Error('The outbound dashboard must never accept an invite.');
  }

  async reject(): Promise<void> {
    if (this.rejected) return;
    this.rejected = true;
    fake.rejectCount += 1;
  }
}

const fake = {
  instances: [] as SentVoice[],
  calls: [] as FakeCall[],
  events: [] as EventRecord[],
  rejectCount: 0,
  disconnectCount: 0,
  tokenCount: 0,
  /** When set, the next connect() rejects with this message, as the SDK does for INVALID_ADDRESS or CALL_IN_PROGRESS. */
  connectError: undefined as string | undefined,
  latest(): SentVoice {
    const client = this.instances.at(-1);
    if (!client) throw new Error('No fake SentVoice instance exists.');
    return client;
  },
  latestCall(): FakeCall {
    const call = this.calls.at(-1);
    if (!call) throw new Error('No fake call exists.');
    return call;
  },
  incoming(from = '+15555550199'): FakeInvite { return this.latest().incoming(from); },
  offline(message = 'Fake voice registration went offline.'): void { this.latest().offline(message); },
  reconnect(): void { this.latest().reconnect(); },
};

(globalThis as typeof globalThis & { __fakeVoice?: typeof fake }).__fakeVoice = fake;

export class SentVoice extends Emitter {
  state = 'new';
  destroyCount = 0;
  private microphone: MediaStream | undefined;

  constructor(private readonly options: FakeVoiceOptions) {
    super();
    fake.instances.push(this);
    fake.events.push({ type: 'construct', at: Date.now() });
  }

  async register(): Promise<void> {
    const token = await this.options.tokenProvider();
    if (!token) throw new Error('Fake token provider returned no token.');
    fake.tokenCount += 1;
    fake.events.push({ type: 'token', at: Date.now(), token });
    this.state = 'registered';
    fake.events.push({ type: 'registered', at: Date.now() });
    this.emit('registered');
  }

  /** Like the real SDK, opens the microphone (the dashboard's patched software microphone) for each call. */
  async connect({ to }: { to: string }): Promise<FakeCall> {
    if (this.state !== 'registered') throw new Error('Fake SDK is not registered.');
    fake.events.push({ type: 'connect', at: Date.now(), to });
    if (fake.connectError) {
      const message = fake.connectError;
      fake.connectError = undefined;
      throw new Error(message);
    }
    this.microphone?.getTracks().forEach(track => track.stop());
    this.microphone = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    // The real SDK sets the playback stream when it dials, before the far end sends any media.
    const incoming = new MediaStream();
    if (this.options.audio?.element) this.options.audio.element.srcObject = incoming;
    const call = new FakeCall(`call_fake_${fake.calls.length + 1}`, to, incoming);
    fake.calls.push(call);
    return call;
  }

  async destroy(): Promise<void> {
    this.destroyCount += 1;
    for (const call of fake.calls) await call.disconnect();
    this.microphone?.getTracks().forEach(track => track.stop());
    this.microphone = undefined;
    this.state = 'destroyed';
    fake.events.push({ type: 'destroy', at: Date.now() });
  }

  incoming(from = '+15555550199'): FakeInvite {
    const invite = new FakeInvite(from);
    this.emit('incomingCall', invite);
    return invite;
  }

  offline(message = 'Fake voice registration went offline.'): void {
    this.state = 'offline';
    const reason = new Error(message);
    fake.events.push({ type: 'offline', at: Date.now(), message });
    this.emit('offline', reason);
  }

  /** The real SDK re-registers by itself after an outage (offline → registered). */
  reconnect(): void {
    this.state = 'registered';
    fake.events.push({ type: 'registered', at: Date.now() });
    this.emit('registered');
  }
}
