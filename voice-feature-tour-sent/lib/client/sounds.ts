"use client";

/**
 * Ringtone and ringback, generated with the Web Audio API. The SDK plays no sounds on
 * purpose and leaves them to the app: play on `incomingCall` and on an outbound `ringing`,
 * stop on `accepted`, `rejected`, `cancelled`, `connected` and `disconnected`.
 *
 * Browsers only start audio after a user gesture, so `unlock()` is called from the Go online
 * button and the sounds work for every call after that.
 */

type Pattern = {
  frequencies: number[];
  onMs: number;
  offMs: number;
}[];

const RINGTONE: Pattern = [
  { frequencies: [440, 480], onMs: 2000, offMs: 4000 },
];
const RINGBACK: Pattern = [
  { frequencies: [400, 450], onMs: 400, offMs: 200 },
  { frequencies: [400, 450], onMs: 400, offMs: 2000 },
];

class TonePlayer {
  #context: AudioContext | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #nodes: OscillatorNode[] = [];
  #gain: GainNode | null = null;

  unlock(): void {
    const context = this.#ensureContext();
    if (context.state === "suspended") void context.resume();
  }

  startRingtone(): void {
    this.#start(RINGTONE);
  }

  startRingback(): void {
    this.#start(RINGBACK);
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#silence();
  }

  #start(pattern: Pattern): void {
    this.stop();
    const context = this.#ensureContext();
    if (context.state === "suspended") void context.resume();
    let step = 0;
    const play = () => {
      const part = pattern[step % pattern.length];
      step += 1;
      this.#tone(part.frequencies, part.onMs);
      this.#timer = setTimeout(play, part.onMs + part.offMs);
    };
    play();
  }

  #tone(frequencies: number[], durationMs: number): void {
    const context = this.#ensureContext();
    this.#silence();
    const gain = context.createGain();
    gain.gain.value = 0.08;
    gain.connect(context.destination);
    this.#gain = gain;
    const stopAt = context.currentTime + durationMs / 1000;
    this.#nodes = frequencies.map((frequency) => {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start();
      oscillator.stop(stopAt);
      return oscillator;
    });
  }

  #silence(): void {
    for (const node of this.#nodes) {
      try {
        node.stop();
      } catch {
        // Already stopped.
      }
      node.disconnect();
    }
    this.#nodes = [];
    this.#gain?.disconnect();
    this.#gain = null;
  }

  #ensureContext(): AudioContext {
    if (!this.#context) this.#context = new AudioContext();
    return this.#context;
  }
}

let player: TonePlayer | null = null;

export function sounds(): TonePlayer {
  if (!player) player = new TonePlayer();
  return player;
}
