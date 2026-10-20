/**
 * Streaming f0 tracker for live feedback: YIN on a 16 kHz copy of the
 * mic signal, one estimate every 10 ms.
 *
 * Plain DSP with no DOM or audio-API dependencies, so the same code
 * runs in a worker, in the page, and under `node --test`.
 *
 * Why these choices (measured on Jaz's takes against pYIN, see the
 * voicetrain README):
 * - YIN's cumulative-mean-normalized difference makes aperiodicity an
 *   honest voicing confidence, and picking the first dip under a
 *   threshold avoids the subharmonic (octave-down) picks that a
 *   global-minimum or MPM-style peak picker makes on breathy voice.
 * - Decimating to ~16 kHz before YIN costs little accuracy for speech
 *   f0 and cuts the per-frame work ~9x.
 * - The difference window is anchored at the newest samples, so a
 *   frame describes audio ~20 ms old instead of half a 43 ms block.
 * - Octave errors are handled causally: once a voiced track exists,
 *   each frame picks the dip that best trades periodicity against an
 *   octave-jump cost, the same trade Praat's Viterbi pass makes, but
 *   without lookahead, because live feedback can't wait for it.
 */

export interface TrackerOptions {
  minHz?: number
  maxHz?: number
}

export interface PitchFrame {
  /** Seconds of audio consumed when the frame was produced. */
  time: number
  /** Seconds of audio the estimate describes (the window's centre). */
  center: number
  /** Light-smoothed f0 for the trace, or null when unvoiced. */
  hz: number | null
  /** 1 - aperiodicity at the chosen period (0..1). */
  confidence: number
  /** RMS of the newest analysis window (full-scale = 1). */
  rms: number
}

const TARGET_RATE = 16000
const HOP_S = 0.01
const WINDOW_S = 0.02

// CMNDF thresholds. A dip under PICK is taken as the period (YIN's
// absolute threshold). Voicing uses hysteresis: starting needs clean
// periodicity, continuing tolerates the dips of real laptop-mic voice.
const PICK_THRESHOLD = 0.15
const NEAR_GLOBAL = 0.1
const SUBHARMONIC_MARGIN = 0.2
const VOICE_START = 0.25
const VOICE_CONTINUE = 0.4
const CONTINUE_S = 0.12

// Cost, in CMNDF units, of moving one octave away from the recent
// track. Natural intonation moves well under 0.05 octave per frame, so
// only octave-scale leaps pay it.
const OCTAVE_COST = 0.3
const TRACK_MEMORY_S = 0.15
const LONGER_LAG_EDGE = 0.05
const ONSET_FRAMES = 3
const ONSET_SPREAD_OCTAVES = 0.17
const JUMP_OCTAVES = 0.4

// Silence gate: absolute floor plus a margin over a tracked noise floor.
const ABS_MIN_RMS = 0.0003
const NOISE_MARGIN = 2.5
const NOISE_RISE_PER_S = 1.06

/** Windowed-sinc low-pass + downsample by an integer factor. */
class Decimator {
  private readonly taps: Float32Array
  private readonly hist: Float32Array
  private readonly factor: number
  private pos = 0
  private phase = 0

  constructor(factor: number) {
    this.factor = factor
    const n = factor * 10 + 1
    const cutoff = 0.42 / factor // fraction of the input rate
    const taps = new Float32Array(n)
    const mid = (n - 1) / 2
    let sum = 0
    for (let i = 0; i < n; i++) {
      const x = i - mid
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1))
      taps[i] = sinc * w
      sum += taps[i]
    }
    for (let i = 0; i < n; i++) taps[i] /= sum
    this.taps = taps
    this.hist = new Float32Array(n * 2)
  }

  /** Feeds one sample; returns the next output sample every `factor` inputs. */
  push(x: number): number | null {
    const n = this.taps.length
    this.pos = (this.pos + 1) % n
    this.hist[this.pos] = x
    this.hist[this.pos + n] = x
    if (++this.phase < this.factor) return null
    this.phase = 0
    let acc = 0
    const base = this.pos + 1
    for (let i = 0; i < n; i++) acc += this.taps[i] * this.hist[base + i]
    return acc
  }

  /** Group delay in input samples. */
  get delay(): number {
    return (this.taps.length - 1) / 2
  }
}

/** One-Euro filter: heavy smoothing when steady, little lag when moving. */
export class OneEuro {
  private readonly minCutoff: number
  private readonly beta: number
  private readonly dCutoff: number
  private x: number | null = null
  private dx = 0

  constructor(minCutoff: number, beta: number, dCutoff = 1) {
    this.minCutoff = minCutoff
    this.beta = beta
    this.dCutoff = dCutoff
  }

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff)
    return 1 / (1 + tau / dt)
  }

  reset(value: number | null = null) {
    this.x = value
    this.dx = 0
  }

  get value(): number | null {
    return this.x
  }

  filter(value: number, dt: number): number {
    if (this.x === null) {
      this.x = value
      return value
    }
    const rawDx = (value - this.x) / dt
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (rawDx - this.dx)
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx)
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x)
    return this.x
  }
}

export class YinTracker {
  readonly sampleRate: number
  readonly rate: number
  private readonly decimator: Decimator | null
  private readonly hop: number
  private readonly w: number
  private readonly tauMin: number
  private readonly tauMax: number
  private readonly ring: Float32Array
  private readonly buf: Float32Array
  private ringPos = 0
  private filled = 0
  private sinceHop = 0
  private inputSamples = 0

  private readonly diff: Float64Array
  private readonly cmnd: Float64Array

  private lastVoicedAt = -Infinity
  private lastRawVoicedAt = -Infinity
  private recentLog2: number[] = []
  private pending: number[] = []
  private pendingJump: number | null = null
  private noiseFloor = 0.002

  constructor(sampleRate: number, opts: TrackerOptions = {}) {
    const minHz = opts.minHz ?? 65
    const maxHz = opts.maxHz ?? 600
    this.sampleRate = sampleRate
    const factor = Math.max(1, Math.round(sampleRate / TARGET_RATE))
    this.decimator = factor > 1 ? new Decimator(factor) : null
    this.rate = sampleRate / factor
    this.hop = Math.round(this.rate * HOP_S)
    this.tauMin = Math.max(2, Math.floor(this.rate / maxHz))
    this.tauMax = Math.ceil(this.rate / minHz)
    this.w = Math.max(Math.round(this.rate * WINDOW_S), this.tauMax)
    this.ring = new Float32Array(this.w + this.tauMax + 1)
    this.buf = new Float32Array(this.ring.length)
    this.diff = new Float64Array(this.tauMax + 2)
    this.cmnd = new Float64Array(this.tauMax + 2)
  }

  /** Seconds between the newest input sample and a frame's `center`. */
  get frameLag(): number {
    const decim = this.decimator ? this.decimator.delay / this.sampleRate : 0
    return decim + this.w / 2 / this.rate
  }

  /** Feeds PCM at the input rate; returns the frames it completed. */
  push(chunk: Float32Array): PitchFrame[] {
    const frames: PitchFrame[] = []
    for (let i = 0; i < chunk.length; i++) {
      this.inputSamples++
      const y = this.decimator ? this.decimator.push(chunk[i]) : chunk[i]
      if (y === null) continue
      this.append(y)
      if (++this.sinceHop >= this.hop) {
        this.sinceHop = 0
        if (this.filled === this.ring.length) frames.push(this.frame())
      }
    }
    return frames
  }

  private append(y: number) {
    this.ring[this.ringPos] = y
    this.ringPos = (this.ringPos + 1) % this.ring.length
    if (this.filled < this.ring.length) this.filled++
  }

  private frame(): PitchFrame {
    const time = this.inputSamples / this.sampleRate
    const center = time - this.frameLag
    const { buf, ring, ringPos, w, tauMax, tauMin, diff, cmnd } = this
    buf.set(ring.subarray(ringPos), 0)
    buf.set(ring.subarray(0, ringPos), ring.length - ringPos)
    const end = buf.length

    let energy = 0
    for (let j = end - w; j < end; j++) energy += buf[j] * buf[j]
    const rms = Math.sqrt(energy / w)

    const dt = HOP_S
    if (rms < this.noiseFloor) this.noiseFloor = rms
    else this.noiseFloor *= NOISE_RISE_PER_S ** dt
    this.noiseFloor = Math.max(this.noiseFloor, ABS_MIN_RMS / 4)

    const silent = rms < ABS_MIN_RMS || rms < this.noiseFloor * NOISE_MARGIN
    if (silent) return this.unvoiced(time, center, 0, rms)

    // Difference function anchored at the newest samples:
    // d(tau) = sum over the last w samples of (x[j] - x[j - tau])^2.
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0
      for (let j = end - w; j < end; j++) {
        const d = buf[j] - buf[j - tau]
        s += d * d
      }
      diff[tau] = s
    }
    cmnd[0] = 1
    let running = 0
    for (let tau = 1; tau <= tauMax; tau++) {
      running += diff[tau]
      cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1
    }

    // Candidate periods: local minima of the CMNDF.
    const cands: Array<{ tau: number; v: number }> = []
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (cmnd[tau] < cmnd[tau - 1] && cmnd[tau] <= cmnd[tau + 1]) {
        cands.push({ tau, v: cmnd[tau] })
      }
    }
    if (cands.length === 0) return this.unvoiced(time, center, 0, rms)

    // YIN's rule: the first dip under the threshold. When nothing dips
    // that low (breathy or noisy voice), the global minimum is usually
    // a subharmonic, so take the first dip close to it instead.
    const global = cands.reduce((a, b) => (b.v < a.v ? b : a))
    let pick =
      cands.find((c) => c.v < PICK_THRESHOLD) ??
      cands.find((c) => c.v <= global.v + NEAR_GLOBAL) ??
      global
    pick = preferUpperOctave(cands, pick)

    const tracking = center - this.lastVoicedAt <= TRACK_MEMORY_S && this.recentLog2.length > 0
    if (tracking) {
      const ref = median(this.recentLog2)
      const first = pick
      let best = Infinity
      for (const c of cands) {
        if (c.v > VOICE_CONTINUE) continue
        // A periodic signal dips about as deep at every multiple of its
        // period, so a track sitting an octave low would happily keep
        // itself there. Moving to a longer lag than the first-dip pick
        // must therefore be earned with a clearly deeper dip.
        if (c.tau > first.tau * 1.5 && c.v > first.v - LONGER_LAG_EDGE) continue
        const cost = c.v + OCTAVE_COST * Math.abs(Math.log2(this.rate / c.tau) - ref)
        if (cost < best) {
          best = cost
          pick = c
        }
      }
    }

    const voicedRecently = center - this.lastRawVoicedAt <= CONTINUE_S
    const bar = voicedRecently ? VOICE_CONTINUE : VOICE_START
    const confidence = Math.max(0, 1 - pick.v)
    if (pick.v > bar) {
      this.pending = []
      return this.unvoiced(time, center, confidence, rms)
    }
    this.lastRawVoicedAt = center
    const log2 = Math.log2(this.rate / refine(cmnd, pick.tau))
    const out = this.stabilize(log2, center)
    return { time, center, hz: out === null ? null : 2 ** out, confidence, rms }
  }

  /**
   * Turns raw per-frame picks into the trace. Most frame-to-frame
   * octave flips happen in the first few frames of a voiced run, while
   * the glottis is still settling, so a run is only believed once
   * ONSET_FRAMES consecutive frames agree (20 ms of onset delay). Inside
   * a run, a leap of more than JUMP_OCTAVES must repeat on the next
   * frame before the trace follows it. Output is the median of the
   * last three accepted frames: 10 ms of lag, no single-frame blips.
   */
  private stabilize(log2: number, center: number): number | null {
    const inRun = center - this.lastVoicedAt <= TRACK_MEMORY_S && this.recentLog2.length > 0
    if (!inRun) {
      this.recentLog2 = []
      this.pending.push(log2)
      if (this.pending.length > ONSET_FRAMES) this.pending.shift()
      if (this.pending.length < ONSET_FRAMES) return null
      const spread = Math.max(...this.pending) - Math.min(...this.pending)
      if (spread > ONSET_SPREAD_OCTAVES) return null
      this.recentLog2 = [...this.pending]
      this.pending = []
    } else {
      const ref = median(this.recentLog2)
      if (Math.abs(log2 - ref) > JUMP_OCTAVES) {
        const confirmed = this.pendingJump !== null && Math.abs(log2 - this.pendingJump) < 0.1
        this.pendingJump = log2
        if (!confirmed) return null
        this.recentLog2 = []
      }
      this.pendingJump = null
      this.recentLog2.push(log2)
      if (this.recentLog2.length > 3) this.recentLog2.shift()
    }
    this.lastVoicedAt = center
    return median(this.recentLog2)
  }

  private unvoiced(time: number, center: number, confidence: number, rms: number): PitchFrame {
    return { time, center, hz: null, confidence, rms }
  }
}

/**
 * A dip at half the chosen lag that is nearly as deep means the chosen
 * lag is a subharmonic: creaky or diplophonic phonation makes every
 * other cycle alike, which deepens the 2x-period dip. Praat breaks the
 * tie with its octave cost; this is the causal equivalent.
 */
function preferUpperOctave(cands: Array<{ tau: number; v: number }>, pick: { tau: number; v: number }) {
  let best = pick
  for (;;) {
    const half = best.tau / 2
    const up = cands.find((c) => Math.abs(c.tau - half) <= Math.max(1.5, half * 0.06) && c.v <= best.v + SUBHARMONIC_MARGIN)
    if (!up) return best
    best = up
  }
}

/** Parabolic interpolation of a minimum at integer lag `tau`. */
function refine(v: Float64Array, tau: number): number {
  const a = v[tau - 1]
  const b = v[tau]
  const c = v[tau + 1]
  const denom = a - 2 * b + c
  if (denom <= 0) return tau
  const shift = (0.5 * (a - c)) / denom
  return tau + Math.max(-0.5, Math.min(0.5, shift))
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
