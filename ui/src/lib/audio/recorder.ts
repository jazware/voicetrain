import { encodeWav } from './wavEncoder'

export interface RecorderSession {
  readonly sampleRate: number
  /** Called for every PCM chunk that arrives from the worklet. */
  onChunk: ((chunk: Float32Array) => void) | null
  stop(): Promise<Blob>
  cancel(): void
}

/**
 * Open the mic and start capturing mono Float32 PCM via an
 * AudioWorklet. Voice-processing (AGC, noise suppression, echo
 * cancellation) is disabled — it distorts exactly what this app
 * exists to observe.
 *
 * Must be called from a user gesture (autoplay policy).
 */
export async function startRecording(): Promise<RecorderSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  })

  // Request 48kHz; the browser resamples if the hardware differs. The
  // actual rate is read back from the context and stamped in the WAV.
  const context = new AudioContext({ sampleRate: 48000 })
  try {
    await context.audioWorklet.addModule('/recorder-worklet.js')
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop())
    void context.close()
    throw err
  }

  const source = context.createMediaStreamSource(stream)
  const worklet = new AudioWorkletNode(context, 'recorder-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
  })
  source.connect(worklet)

  const chunks: Float32Array[] = []

  const session: RecorderSession = {
    sampleRate: context.sampleRate,
    onChunk: null,

    async stop() {
      const blob = teardown()
      return blob
    },

    cancel() {
      teardown()
    },
  }

  worklet.port.onmessage = (e: MessageEvent<Float32Array>) => {
    chunks.push(e.data)
    session.onChunk?.(e.data)
  }

  function teardown(): Blob {
    worklet.port.onmessage = null
    source.disconnect()
    stream.getTracks().forEach((t) => t.stop())
    void context.close()
    return encodeWav(chunks, context.sampleRate)
  }

  return session
}
