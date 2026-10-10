/* Global AudioWorkletProcessor, registerProcessor, sampleRate */

class SentAgentPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.captureEnabled = false;
    this.capture = new Float32Array(480); // 20 ms at 24 kHz
    this.captureFill = 0;
    this.playbackQueue = [];
    this.queueSamples = 0;
    // Hard cap against runaway output (see PLAYBACK_LIMIT_MS in client/app.ts): 5 s until the client sets the model's limit.
    // An overflow is surfaced and the browser ends the call; speech is never silently dropped.
    this.maxQueueSamples = 5 * sampleRate;
    this.overflowed = false;
    this.notifyDrained = false;
    this.port.onmessage = (event) => this.onMessage(event.data);
  }

  onMessage(message) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'capture') {
      this.captureEnabled = Boolean(message.enabled);
      if (!this.captureEnabled) this.captureFill = 0;
      return;
    }
    if (message.type === 'clear') {
      this.playbackQueue = [];
      this.queueSamples = 0;
      this.overflowed = false;
      return;
    }
    if (message.type === 'notify-drained') {
      this.notifyDrained = true;
      return;
    }
    if (message.type === 'set-playback-limit' && typeof message.milliseconds === 'number') {
      const milliseconds = Math.max(500, Math.min(120_000, message.milliseconds));
      this.maxQueueSamples = Math.floor((milliseconds / 1_000) * sampleRate);
      if (this.queueSamples > this.maxQueueSamples) this.failOverflow(milliseconds);
      return;
    }
    if (message.type !== 'model-audio' || !(message.audio instanceof ArrayBuffer)) return;

    const pcm = new Int16Array(message.audio);
    if (pcm.length === 0) return;
    if (this.overflowed) return;
    if (this.queueSamples + pcm.length > this.maxQueueSamples) {
      this.failOverflow(Math.round((this.maxQueueSamples / sampleRate) * 1_000));
      return;
    }

    // Queued as PCM16 (half the memory of floats at the 120 s cap); takeModelSample converts one sample at a time.
    this.playbackQueue.push({ samples: pcm, offset: 0, itemId: typeof message.itemId === 'string' ? message.itemId : undefined });
    this.queueSamples += pcm.length;
  }

  failOverflow(limitMs) {
    if (this.overflowed) return;
    this.overflowed = true;
    this.playbackQueue = [];
    this.queueSamples = 0;
    this.port.postMessage({ type: 'overflow', message: `Model audio queue exceeded its ${limitMs} ms hard limit.` });
  }

  emitCapture() {
    const buffer = new ArrayBuffer(960);
    const view = new DataView(buffer);
    for (let i = 0; i < 480; i += 1) {
      const sample = Math.max(-1, Math.min(1, this.capture[i]));
      const pcm = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
      view.setInt16(i * 2, pcm, true);
    }
    this.port.postMessage({ type: 'capture', audio: buffer }, [buffer]);
  }

  takeModelSample(rendered) {
    const head = this.playbackQueue[0];
    if (!head) return 0;
    const value = head.samples[head.offset++] / 32768;
    this.queueSamples -= 1;
    if (head.itemId) rendered.set(head.itemId, (rendered.get(head.itemId) || 0) + 1);
    if (head.offset === head.samples.length) this.playbackQueue.shift();
    return value;
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0];
    const channel = output && output[0];
    if (!channel) return true;
    const rendered = new Map();

    for (let i = 0; i < channel.length; i += 1) {
      const remote = input && i < input.length ? input[i] : 0;
      if (this.captureEnabled) {
        this.capture[this.captureFill++] = remote;
        if (this.captureFill === 480) {
          this.emitCapture();
          this.captureFill = 0;
        }
      }
      const model = this.takeModelSample(rendered);
      for (let channelIndex = 0; channelIndex < output.length; channelIndex += 1) output[channelIndex][i] = model;
    }

    for (const [itemId, samples] of rendered) {
      this.port.postMessage({ type: 'rendered', itemId, audioMs: (samples / sampleRate) * 1000 });
    }
    if (this.notifyDrained && this.queueSamples === 0) {
      this.notifyDrained = false;
      this.port.postMessage({ type: 'drained' });
    }
    return true;
  }
}

registerProcessor('sent-agent-pcm', SentAgentPcmProcessor);
