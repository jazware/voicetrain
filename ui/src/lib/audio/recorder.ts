import type { WorkerIn, WorkerOut } from './liveProtocol.ts'
import type { PitchFrame } from './yin.ts'

export interface LiveUpdate {
  /** Seconds of audio received so far. */
  time: number
  frames: PitchFrame[]
  /** Interleaved [min, max] pairs, one per `peakSeconds` of audio. */
  peaks: number[]
}

export interface RecorderSession {
  readonly sampleRate: number
  /** Seconds between a sample arriving and the pitch frame describing it. */
  readonly frameLag: number
  readonly peakSeconds: number
  /** Called on the main thread for every batch the worker analyzed (~90/s). */
  onUpdate: ((u: LiveUpdate) => void) | null
  stop(): Promise<Blob>
  cancel(): void
}

/**
 * Open the mic and start the live pipeline:
 *
 *   mic -> AudioWorklet (audio thread) -> MessagePort -> worker
 *       (pitch, peaks, the take itself) -> main thread (drawing only)
 *
 * The PCM never crosses the main thread, so React renders and layout
 * can't delay analysis, and analysis can't make the page jank.
 *
 * Voice-processing (AGC, noise suppression, echo cancellation) is
 * disabled: it distorts exactly what this app exists to observe.
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
  const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
  const worker = new Worker(new URL('./liveWorker.ts', import.meta.url), { type: 'module' })
  const closeAll = () => {
    stream.getTracks().forEach((t) => t.stop())
    void context.close()
    worker.terminate()
  }
  try {
    await context.audioWorklet.addModule('/recorder-worklet.js')
  } catch (err) {
    closeAll()
    throw err
  }

  const source = context.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(context, 'recorder-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
  })
  const channel = new MessageChannel()
  node.port.postMessage({ type: 'port', port: channel.port1 }, [channel.port1])

  const ready = new Promise<{ frameLag: number; peakSeconds: number }>((resolve) => {
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      if (e.data.type === 'ready') resolve(e.data)
    }
  })
  const start: WorkerIn = { type: 'start', sampleRate: context.sampleRate, port: channel.port2 }
  worker.postMessage(start, [channel.port2])
  const { frameLag, peakSeconds } = await ready

  let wavResolve: ((wav: ArrayBuffer) => void) | null = null
  worker.onmessage = (e: MessageEvent<WorkerOut>) => {
    const msg = e.data
    if (msg.type === 'update') session.onUpdate?.(msg)
    else if (msg.type === 'wav') wavResolve?.(msg.wav)
  }
  source.connect(node)

  let done = false
  const session: RecorderSession = {
    sampleRate: context.sampleRate,
    frameLag,
    peakSeconds,
    onUpdate: null,

    async stop() {
      if (done) throw new Error('recording already stopped')
      done = true
      session.onUpdate = null
      const wav = new Promise<ArrayBuffer>((resolve) => {
        wavResolve = resolve
      })
      node.port.postMessage({ type: 'stop' })
      // The worklet's end marker normally arrives within a render
      // quantum; if the context died first, have the worker finish.
      const fallback = setTimeout(() => worker.postMessage({ type: 'finish' } satisfies WorkerIn), 1500)
      const buffer = await wav
      clearTimeout(fallback)
      source.disconnect()
      closeAll()
      return new Blob([buffer], { type: 'audio/wav' })
    },

    cancel() {
      if (done) return
      done = true
      session.onUpdate = null
      source.disconnect()
      closeAll()
    },
  }
  return session
}
