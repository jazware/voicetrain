import { YinTracker } from './yin.ts'
import { encodeWav } from './wavEncoder.ts'
import type { WorkerOut } from './liveProtocol.ts'

export const PEAK_S = 0.02

type Update = Extract<WorkerOut, { type: 'update' }>

/**
 * What the live worker does with each batch of mic PCM: track pitch,
 * reduce the waveform to [min, max] peaks, and keep the samples for
 * the WAV. Separate from the worker so it runs under `node --test`.
 */
export class LiveAnalyzer {
  readonly tracker: YinTracker
  private readonly sampleRate: number
  private readonly peakSpan: number
  private chunks: Float32Array[] = []
  private samples = 0
  private peakMin = 1
  private peakMax = -1
  private peakFill = 0

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate
    this.tracker = new YinTracker(sampleRate)
    this.peakSpan = Math.round(sampleRate * PEAK_S)
  }

  push(pcm: Float32Array): Update {
    this.chunks.push(pcm)
    this.samples += pcm.length
    const frames = this.tracker.push(pcm)
    const peaks: number[] = []
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i]
      if (v < this.peakMin) this.peakMin = v
      if (v > this.peakMax) this.peakMax = v
      if (++this.peakFill === this.peakSpan) {
        peaks.push(this.peakMin, this.peakMax)
        this.peakMin = 1
        this.peakMax = -1
        this.peakFill = 0
      }
    }
    return { type: 'update', time: this.samples / this.sampleRate, frames, peaks }
  }

  /** The whole take as a WAV file; the analyzer is spent afterwards. */
  finish(): ArrayBuffer {
    const wav = encodeWav(this.chunks, this.sampleRate)
    this.chunks = []
    return wav
  }
}
