/**
 * AudioWorkletProcessor that streams mono Float32 PCM straight to the
 * live-analysis worker over a MessagePort, in 512-sample batches
 * (~11 ms at 48 kHz). The page's main thread never touches the audio:
 * the worker tracks pitch, keeps the take and encodes the WAV.
 *
 * Kept as plain JS in public/ so the same URL works under the Vite dev
 * server and the Go-embedded production build.
 */
const BATCH = 512

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.out = null
    this.buffer = new Float32Array(BATCH)
    this.offset = 0
    this.stopped = false
    this.port.onmessage = (e) => {
      if (e.data.type === 'port') {
        this.out = e.data.port
      } else if (e.data.type === 'stop') {
        // Flush what's buffered, then mark the end on the same port so
        // the worker sees every sample before it encodes the take.
        this.flush()
        this.out?.postMessage({ type: 'end' })
        this.stopped = true
      }
    }
  }

  flush() {
    if (!this.out || this.offset === 0) return
    const pcm = this.buffer.slice(0, this.offset)
    this.out.postMessage({ type: 'pcm', pcm }, [pcm.buffer])
    this.offset = 0
  }

  process(inputs) {
    if (this.stopped) return false
    const channel = inputs[0] && inputs[0][0]
    if (!channel || !this.out) return true

    let read = 0
    while (read < channel.length) {
      const n = Math.min(BATCH - this.offset, channel.length - read)
      this.buffer.set(channel.subarray(read, read + n), this.offset)
      this.offset += n
      read += n
      if (this.offset === BATCH) {
        this.out.postMessage({ type: 'pcm', pcm: this.buffer }, [this.buffer.buffer])
        this.buffer = new Float32Array(BATCH)
        this.offset = 0
      }
    }
    return true
  }
}

registerProcessor('recorder-processor', RecorderProcessor)
