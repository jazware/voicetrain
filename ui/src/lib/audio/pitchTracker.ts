import { OneEuro, YinTracker, type PitchFrame } from './yin.ts'

export type { PitchFrame }

/**
 * Live pitch for the practice screen: YIN frames for the trace, a
 * calm readout for the big number, and the take's summary stats.
 */

// The readout is a One-Euro filter in log-pitch, then a deadband:
// speech glides ~10 semitones a second, so a number that followed
// every frame changed 35 times a second on Jaz's takes. Moves over a
// semitone show at once; smaller ones (over a third of a semitone)
// wait out READOUT_DWELL_S. That's ~10 changes a second in speech and
// ~60 ms to follow a 5-semitone step.
const READOUT_MIN_CUTOFF_HZ = 1.0
const READOUT_BETA = 0.6
const READOUT_JUMP_ST = 1
const READOUT_NUDGE_ST = 1 / 3
const READOUT_DWELL_S = 0.25
// Short consonant gaps keep the last value instead of blanking.
const READOUT_HOLD_S = 0.3

/** The calm readout and the take's summary, fed with frames from anywhere. */
export class PitchReadout {
  private readonly readout = new OneEuro(READOUT_MIN_CUTOFF_HZ, READOUT_BETA)
  private readoutAt = -Infinity
  private shown: number | null = null
  private shownAt = -Infinity
  private latest = 0
  /** Every voiced trace value, kept for the take's summary. */
  readonly voiced: number[] = []
  /** Decaying peak level, for spotting a too-quiet input device. */
  peakRms = 0

  observe(f: PitchFrame) {
    this.latest = f.center
    this.peakRms = Math.max(this.peakRms * 0.995, f.rms)
    if (f.hz === null) return
    this.voiced.push(f.hz)
    const log2 = Math.log2(f.hz)
    if (f.center - this.readoutAt > READOUT_HOLD_S) {
      this.readout.reset()
      this.shown = null
    }
    const smooth = 2 ** this.readout.filter(log2, 0.01)
    this.readoutAt = f.center
    const st = this.shown === null ? Infinity : Math.abs(12 * Math.log2(smooth / this.shown))
    const settled = f.center - this.shownAt >= READOUT_DWELL_S
    if (st > READOUT_JUMP_ST || (settled && st > READOUT_NUDGE_ST)) {
      this.shown = smooth
      this.shownAt = f.center
    }
  }

  /** The calm readout value, or null after a real pause. */
  displayHz(): number | null {
    if (this.shown === null || this.latest - this.readoutAt > READOUT_HOLD_S) return null
    return this.shown
  }

  /** Summary for pitch_stats, or undefined if nothing voiced was heard. */
  stats(targetMinHz: number, targetMaxHz: number) {
    return pitchStats(this.voiced, targetMinHz, targetMaxHz)
  }
}

/** YIN tracking plus the readout, for feeding PCM directly (tests, tools). */
export class PitchTracker extends PitchReadout {
  private readonly yin: YinTracker

  constructor(sampleRate: number) {
    super()
    this.yin = new YinTracker(sampleRate)
  }

  /** Feeds PCM; returns the 10 ms frames it completed. */
  push(chunk: Float32Array): PitchFrame[] {
    const frames = this.yin.push(chunk)
    for (const f of frames) this.observe(f)
    return frames
  }
}

export function pitchStats(voiced: number[], targetMinHz: number, targetMaxHz: number) {
  if (voiced.length === 0) return undefined
  const sorted = [...voiced].sort((a, b) => a - b)
  const inBand = voiced.filter((hz) => hz >= targetMinHz && hz <= targetMaxHz).length
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  return {
    median_hz: Math.round(q(0.5) * 10) / 10,
    pct_in_band: Math.round((inBand / voiced.length) * 1000) / 1000,
    // 5th/95th percentiles: a take's extremes are tracker edges, not
    // the voice's range.
    min_hz: Math.round(q(0.05) * 10) / 10,
    max_hz: Math.round(q(0.95) * 10) / 10,
  }
}
