// Browser-only audio graph, adapted from the inbound and outbound samples.
//
// The Sent voice SDK asks for a microphone with getUserMedia. This class
// answers with a "software microphone": a MediaStreamDestination that carries
// the agent's voice. A person can take over by connecting the real
// microphone into the same destination, so the call keeps its audio track.

/** Realtime models send audio about 6 times faster than real time, so the queue must hold a full answer. */
export const PLAYBACK_LIMIT_MS = 120_000

export class AudioEngine {
  private context?: AudioContext
  private processor?: AudioWorkletNode
  private destination?: MediaStreamAudioDestinationNode
  private remoteSource?: MediaStreamAudioSourceNode
  private remoteStream?: MediaStream
  private microphone?: { stream: MediaStream; source: MediaStreamAudioSourceNode }
  private nativeGetUserMedia?: typeof navigator.mediaDevices.getUserMedia
  private initialized?: Promise<void>
  private drained?: () => void
  /** Whether the SDK took the software microphone; false means it reached the real microphone some other way. */
  softwareMicrophoneUsed = false

  onCapture?: (frame: ArrayBuffer) => void
  onRendered?: (itemId: string, audioMs: number) => void
  onOverflow?: (message: string) => void

  /** Call during the Start click: browsers start audio only in a user gesture. */
  init(): Promise<void> {
    this.initialized ??= this.initialize().catch((error: unknown) => {
      this.initialized = undefined
      throw error
    })
    return this.initialized
  }

  private async initialize() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't capture audio on this page.")
    const context = (this.context = new AudioContext({ sampleRate: 24_000 }))
    // resume() must run in the synchronous part of the click, before the first await.
    const resumed = context.resume()
    await context.audioWorklet.addModule("/audio-worklet.js")
    const processor = new AudioWorkletNode(context, "sent-agent-pcm", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
      outputChannelCount: [1],
    })
    const destination = context.createMediaStreamDestination()
    processor.connect(destination)
    processor.port.onmessage = (event: MessageEvent) => {
      const message = event.data as { type?: string; audio?: ArrayBuffer; itemId?: string; audioMs?: number; message?: string }
      if (message.type === "capture" && message.audio instanceof ArrayBuffer) this.onCapture?.(message.audio)
      if (message.type === "rendered" && typeof message.itemId === "string" && typeof message.audioMs === "number") this.onRendered?.(message.itemId, message.audioMs)
      if (message.type === "overflow") this.onOverflow?.(message.message ?? "The agent's audio queue overflowed.")
      if (message.type === "drained") this.drained?.()
    }
    processor.port.postMessage({ type: "set-playback-limit", milliseconds: PLAYBACK_LIMIT_MS })
    this.processor = processor
    this.destination = destination
    this.patchGetUserMedia()
    await resumed
  }

  private patchGetUserMedia() {
    if (this.nativeGetUserMedia || !this.destination) return
    const mediaDevices = navigator.mediaDevices
    const native = mediaDevices.getUserMedia.bind(mediaDevices)
    this.nativeGetUserMedia = native
    mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      const audioOnly = Boolean(constraints?.audio) && !constraints?.video
      if (!audioOnly) return native(constraints)
      this.softwareMicrophoneUsed = true
      // A clone keeps the SDK from stopping the graph's master track when one call ends.
      return this.destination!.stream.clone()
    }
  }

  /** Sends the contact's audio to the agent. Off until the call connects: before that the line carries ringback. */
  setCapturing(enabled: boolean) {
    this.processor?.port.postMessage({ type: "capture", enabled })
  }

  enqueueAudio(audio: ArrayBuffer, itemId?: string) {
    if (!this.processor) return
    const copy = audio.slice(0)
    this.processor.port.postMessage({ type: "model-audio", audio: copy, itemId }, [copy])
  }

  clearAudio() {
    this.processor?.port.postMessage({ type: "clear" })
  }

  /** Calls back once every queued agent sample has played into the call. */
  whenDrained(callback: () => void) {
    this.drained = callback
    this.processor?.port.postMessage({ type: "notify-drained" })
  }

  /** Returns false while the stream has no audio track yet. */
  attachRemoteStream(stream: MediaStream): boolean {
    if (!this.context || !this.processor) return false
    if (this.remoteStream === stream) return true
    if (!stream.getAudioTracks().length) return false
    const source = this.context.createMediaStreamSource(stream)
    this.remoteSource?.disconnect()
    source.connect(this.processor)
    this.remoteSource = source
    this.remoteStream = stream
    return true
  }

  detachRemoteStream() {
    this.remoteSource?.disconnect()
    this.remoteSource = undefined
    this.remoteStream = undefined
  }

  /** A person speaks into the call: the real microphone joins the software microphone's output. */
  async attachMicrophone() {
    if (this.microphone || !this.context || !this.destination || !this.nativeGetUserMedia) return
    const stream = await this.nativeGetUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    const source = this.context.createMediaStreamSource(stream)
    source.connect(this.destination)
    this.microphone = { stream, source }
  }

  detachMicrophone() {
    this.microphone?.source.disconnect()
    this.microphone?.stream.getTracks().forEach((track) => track.stop())
    this.microphone = undefined
  }

  setMicrophoneMuted(muted: boolean) {
    this.microphone?.stream.getAudioTracks().forEach((track) => (track.enabled = !muted))
  }

  async shutdown() {
    this.setCapturing(false)
    this.clearAudio()
    this.detachRemoteStream()
    this.detachMicrophone()
    this.processor?.disconnect()
    this.processor = undefined
    this.destination?.disconnect()
    this.destination?.stream.getTracks().forEach((track) => track.stop())
    this.destination = undefined
    if (this.nativeGetUserMedia) {
      navigator.mediaDevices.getUserMedia = this.nativeGetUserMedia
      this.nativeGetUserMedia = undefined
    }
    const context = this.context
    this.context = undefined
    this.initialized = undefined
    if (context && context.state !== "closed") await context.close()
  }
}
