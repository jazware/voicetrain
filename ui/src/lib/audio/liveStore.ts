import { PitchReadout } from './pitchTracker.ts'
import type { LiveUpdate } from './recorder.ts'
import type { PitchFrame } from './yin.ts'

const KEEP_S = 12

/**
 * What the practice screen draws while recording: the pitch trace, the
 * waveform peaks and the readout, plus a clock that maps the page's
 * animation frames onto audio time.
 *
 * Updates arrive from the worker ~90 times a second in small batches;
 * drawing happens on requestAnimationFrame. Interpolating the clock
 * between batches is what makes the trace glide instead of stepping.
 * Nothing here touches React state, so recording never re-renders the
 * page.
 */
export class LiveStore {
  readonly readout = new PitchReadout()
  /** Pitch trace: frame centres (s) and Hz (NaN when unvoiced). */
  readonly traceT: number[] = []
  readonly traceHz: number[] = []
  /** Waveform peaks: [min, max] per `peakSeconds`, with end times. */
  readonly peaks: Array<[number, number, number]> = []

  private audioTime = 0
  private perfAt = 0
  private peakSeconds: number
  readonly frameLag: number

  /** Called with every frame as it arrives (an exercise's meter). */
  readonly frameListeners: Array<(f: PitchFrame) => void> = []

  /** For latency measurement in the browser (see README). */
  lastUpdatePerf = 0
  updates = 0

  constructor(frameLag: number, peakSeconds: number) {
    this.frameLag = frameLag
    this.peakSeconds = peakSeconds
  }

  apply(u: LiveUpdate) {
    const now = performance.now()
    for (const f of u.frames) {
      this.readout.observe(f)
      for (const l of this.frameListeners) l(f)
      this.traceT.push(f.center)
      this.traceHz.push(f.hz ?? NaN)
    }
    let t = u.time - (u.peaks.length / 2) * this.peakSeconds
    for (let i = 0; i < u.peaks.length; i += 2) {
      t += this.peakSeconds
      this.peaks.push([t, u.peaks[i], u.peaks[i + 1]])
    }
    const cutoff = u.time - KEEP_S
    let drop = 0
    while (drop < this.traceT.length && this.traceT[drop] < cutoff) drop++
    if (drop > 0) {
      this.traceT.splice(0, drop)
      this.traceHz.splice(0, drop)
    }
    while (this.peaks.length && this.peaks[0][0] < cutoff) this.peaks.shift()

    this.audioTime = u.time
    this.perfAt = now
    this.lastUpdatePerf = now
    this.updates++
  }

  /**
   * Audio time "now" for drawing: the last batch's time advanced by the
   * wall clock since it arrived, capped so a stalled worker can't run
   * the trace ahead of real data.
   */
  clock(perfNow: number): number {
    if (this.perfAt === 0) return 0
    return this.audioTime + Math.min(0.05, Math.max(0, (perfNow - this.perfAt) / 1000))
  }
}
