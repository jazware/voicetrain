/**
 * AudioWorkletProcessor that forwards mono Float32 PCM to the main
 * thread in ~2048-sample batches (~43ms at 48kHz — keeps the pitch
 * meter fresh) using transferable buffers.
 *
 * Kept as plain JS in public/ so the same URL works under the Vite dev
 * server and the Go-embedded production build.
 */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(2048)
    this.offset = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true

    let read = 0
    while (read < channel.length) {
      const space = this.buffer.length - this.offset
      const n = Math.min(space, channel.length - read)
      this.buffer.set(channel.subarray(read, read + n), this.offset)
      this.offset += n
      read += n
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer])
        this.buffer = new Float32Array(2048)
        this.offset = 0
      }
    }
    return true
  }
}

registerProcessor('recorder-processor', RecorderProcessor)
