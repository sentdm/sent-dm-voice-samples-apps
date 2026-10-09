type Listener = (...args: any[]) => void;

type FakeVoiceOptions = {
  tokenProvider: () => Promise<string>;
  audio?: { element?: HTMLAudioElement };
};

type EventRecord = { type: string; at: number; [key: string]: unknown };

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

class FakeCall extends Emitter {
  readonly id = 'provider123';
  state = 'connecting';
  disconnectCount = 0;

  async disconnect(): Promise<void> {
    if (this.state === 'disconnected') return;
    this.state = 'disconnected';
    this.disconnectCount += 1;
    fake.events.push({ type: 'call-disconnect', at: Date.now(), id: this.id });
    fake.disconnectCount += 1;
    this.emit('disconnected', { state: 'disconnected' });
  }
}

class FakeInvite extends Emitter {
  state: 'pending' | 'accepted' | 'rejected' = 'pending';
  acceptedAt: number | undefined;
  rejectedAt: number | undefined;
  call: FakeCall | undefined;

  constructor(readonly from: string) {
    super();
  }

  async accept(): Promise<FakeCall> {
    if (this.state !== 'pending') throw new Error(`Invite is already ${this.state}.`);
    this.state = 'accepted';
    this.acceptedAt = Date.now();
    const call = new FakeCall();
    this.call = call;
    fake.acceptCount += 1;
    fake.events.push({ type: 'invite-accept', at: this.acceptedAt, from: this.from, id: call.id });
    this.emit('accepted', call);
    call.state = 'connected';
    call.emit('connected');
    return call;
  }

  async reject(): Promise<void> {
    if (this.state !== 'pending') return;
    this.state = 'rejected';
    this.rejectedAt = Date.now();
    fake.rejectCount += 1;
    fake.events.push({ type: 'invite-reject', at: this.rejectedAt, from: this.from });
  }
}

const fake = {
  instances: [] as SentVoice[],
  invites: [] as FakeInvite[],
  events: [] as EventRecord[],
  acceptCount: 0,
  rejectCount: 0,
  disconnectCount: 0,
  tokenCount: 0,
  latest(): SentVoice {
    const client = this.instances.at(-1);
    if (!client) throw new Error('No fake SentVoice instance exists.');
    return client;
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
    // Exercise the dashboard's patched software microphone path without accessing hardware.
    this.microphone = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.state = 'registered';
    fake.events.push({ type: 'registered', at: Date.now() });
    this.emit('registered');
  }

  async destroy(): Promise<void> {
    this.destroyCount += 1;
    this.microphone?.getTracks().forEach(track => track.stop());
    this.microphone = undefined;
    this.state = 'destroyed';
    fake.events.push({ type: 'destroy', at: Date.now() });
  }

  incoming(from = '+15555550199'): FakeInvite {
    const invite = new FakeInvite(from);
    fake.invites.push(invite);
    fake.events.push({ type: 'incoming', at: Date.now(), from });
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
