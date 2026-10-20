import type { PitchFrame } from './audio/yin.ts'

export type ExerciseKind = 'siren' | 'sustain' | 'hold'
export type ScriptKind = 'passage' | ExerciseKind

export const EXERCISE_KINDS: ExerciseKind[] = ['siren', 'sustain', 'hold']

export const isExercise = (kind: string | undefined): kind is ExerciseKind =>
  kind === 'siren' || kind === 'sustain' || kind === 'hold'

/** What each exercise is for and how its takes are judged, in Jaz's words. */
export const EXERCISES: Record<
  ExerciseKind,
  { emoji: string; short: string; measure: string; goal: string }
> = {
  siren: {
    emoji: '🌈',
    short: 'Slow glides across your range',
    measure: 'Your range',
    goal: 'An easy, wide range: from the bottom of your voice to wherever the top still feels effortless.',
  },
  sustain: {
    emoji: '🕯️',
    short: 'One steady note on one easy breath',
    measure: 'Your longest steady hold',
    goal: 'A note that stays put. Steadiness first, length second.',
  },
  hold: {
    emoji: '🏡',
    short: 'A minute of talking, inside your home band',
    measure: 'Time at home',
    goal: 'Most of the minute inside the green stripe, with long unbroken stretches.',
  },
}

// A hold survives gaps this short (a flicker of unvoicing mid-note).
const HOLD_GAP_S = 0.15
// The first part of a hold is the onset settling, not its steadiness.
const HOLD_ONSET_S = 0.3
// A streak at home survives breaths and short excursions this long.
const STREAK_GAP_S = 0.35

const BIN_ST = 0.25
const MIN_HZ = 40

/** A running histogram of pitch in quarter-semitone bins, for percentiles. */
class PitchHistogram {
  private readonly bins = new Float64Array(240) // 40 Hz to ~1.3 kHz
  private n = 0

  add(hz: number) {
    const i = Math.floor((12 * Math.log2(hz / MIN_HZ)) / BIN_ST)
    if (i < 0 || i >= this.bins.length) return
    this.bins[i]++
    this.n++
  }

  get count() {
    return this.n
  }

  percentile(p: number): number | null {
    if (this.n === 0) return null
    const target = p * this.n
    let acc = 0
    for (let i = 0; i < this.bins.length; i++) {
      acc += this.bins[i]
      if (acc >= target) return MIN_HZ * 2 ** (((i + 0.5) * BIN_ST) / 12)
    }
    return null
  }
}

export interface ExerciseSummary {
  /** 5th to 95th percentile of voiced pitch, in semitones. */
  range_st: number
  low_hz: number
  high_hz: number
  /** The longest continuous voiced stretch, and how steady it was. */
  longest_hold_s: number
  hold_sd_cents: number | null
  /** The longest stretch at home (inside the band), breaths bridged. */
  longest_in_band_s: number
}

/**
 * The measures every exercise is judged on, kept as frames arrive: the
 * range a siren covered, the longest steady hold, the longest stretch at
 * home. Live and cheap (a histogram and a few running sums), and the
 * same numbers are saved with the take.
 */
export class ExerciseMeter {
  private readonly bandMin: number
  private readonly bandMax: number
  private readonly hist = new PitchHistogram()

  // Current hold: voiced frames with no gap over HOLD_GAP_S.
  private holdStart = -1
  private holdLast = -1
  private holdLog: number[] = []
  private holdStartTime = 0
  bestHoldS = 0
  bestHoldCents: number | null = null

  // Current streak at home.
  private streakStart = -1
  private streakLast = -1
  bestStreakS = 0

  inBandFrames = 0
  voicedFrames = 0

  constructor(bandMin: number, bandMax: number) {
    this.bandMin = bandMin
    this.bandMax = bandMax
  }

  observe(f: PitchFrame) {
    const t = f.center
    if (f.hz === null) {
      this.closeHoldIfGap(t)
      return
    }
    this.voicedFrames++
    this.hist.add(f.hz)

    if (this.holdLast < 0 || t - this.holdLast > HOLD_GAP_S) {
      this.finishHold()
      this.holdStart = t
      this.holdStartTime = t
      this.holdLog = []
    }
    this.holdLast = t
    if (t - this.holdStartTime >= HOLD_ONSET_S) this.holdLog.push(1200 * Math.log2(f.hz))

    if (f.hz >= this.bandMin && f.hz <= this.bandMax) {
      this.inBandFrames++
      if (this.streakLast < 0 || t - this.streakLast > STREAK_GAP_S) this.streakStart = t
      this.streakLast = t
      this.bestStreakS = Math.max(this.bestStreakS, this.streakLast - this.streakStart)
    }
  }

  private closeHoldIfGap(t: number) {
    if (this.holdLast >= 0 && t - this.holdLast > HOLD_GAP_S) {
      this.finishHold()
      this.holdLast = -1
    }
  }

  private finishHold() {
    if (this.holdLast < 0) return
    const len = this.holdLast - this.holdStart
    if (len > this.bestHoldS) {
      this.bestHoldS = len
      this.bestHoldCents = sd(this.holdLog)
    }
  }

  /** The hold in progress, in seconds (0 when silent). */
  currentHoldS(now: number): number {
    if (this.holdLast < 0 || now - this.holdLast > HOLD_GAP_S) return 0
    return this.holdLast - this.holdStart
  }

  /** How steady the hold in progress is, in cents (null until settled). */
  currentHoldCents(): number | null {
    return sd(this.holdLog)
  }

  /** The streak at home in progress, in seconds. */
  currentStreakS(now: number): number {
    if (this.streakLast < 0 || now - this.streakLast > STREAK_GAP_S) return 0
    return this.streakLast - this.streakStart
  }

  /** Low and high ends of the range so far (5th/95th percentiles). */
  range(): { low: number; high: number; st: number } | null {
    if (this.hist.count < 20) return null
    const low = this.hist.percentile(0.05)!
    const high = this.hist.percentile(0.95)!
    return { low, high, st: 12 * Math.log2(high / low) }
  }

  inBandPct(): number | null {
    return this.voicedFrames ? (100 * this.inBandFrames) / this.voicedFrames : null
  }

  summary(): ExerciseSummary | undefined {
    this.finishHold()
    const r = this.range()
    if (!r) return undefined
    const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d
    return {
      range_st: round(r.st),
      low_hz: round(r.low),
      high_hz: round(r.high),
      longest_hold_s: round(this.bestHoldS, 2),
      hold_sd_cents: this.bestHoldCents === null ? null : round(this.bestHoldCents),
      longest_in_band_s: round(this.bestStreakS, 2),
    }
  }
}

/**
 * Makes a meter for each take with the band as it is when the take
 * starts, not when the page first rendered: settings load after the
 * script on a fresh visit, and a meter built from the fallback band would
 * judge "Hold the band" against the wrong home for the whole visit.
 */
export function meterAtStart(band: () => { min: number; max: number }): () => ExerciseMeter {
  return () => {
    const { min, max } = band()
    return new ExerciseMeter(min, max)
  }
}

function sd(xs: number[]): number | null {
  if (xs.length < 10) return null
  let mean = 0
  for (const x of xs) mean += x
  mean /= xs.length
  let v = 0
  for (const x of xs) v += (x - mean) ** 2
  return Math.sqrt(v / xs.length)
}

/** One line for a saved take, by kind. */
export function exerciseLine(kind: ExerciseKind, s: Partial<ExerciseSummary> | undefined): string | null {
  if (!s) return null
  switch (kind) {
    case 'siren':
      return s.range_st != null && s.low_hz != null && s.high_hz != null
        ? `a ${Math.round(s.range_st)}-semitone range, ${Math.round(s.low_hz)} to ${Math.round(s.high_hz)} Hz`
        : null
    case 'sustain':
      return s.longest_hold_s != null
        ? `a ${s.longest_hold_s.toFixed(1)} s hold${s.hold_sd_cents != null ? `, steady within ±${Math.round(s.hold_sd_cents)} cents` : ''}`
        : null
    case 'hold':
      return s.longest_in_band_s != null ? `a ${Math.round(s.longest_in_band_s)} s stretch at home` : null
  }
}
