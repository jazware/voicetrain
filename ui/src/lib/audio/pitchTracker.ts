import { PitchDetector } from 'pitchy'

/**
 * Streaming pitch tracker: feed PCM chunks, poll estimates.
 *
 * McLeod Pitch Method over a 2048-sample sliding window (~43ms at
 * 48kHz). Tuned for real, un-AGC'd microphone speech:
 *
 * - voicing decided by MPM clarity, not level: quiet mics are normal
 *   when auto-gain is disabled, and clarity separates quiet periodic
 *   voice from loud aperiodic noise better than any RMS threshold
 * - moderate clarity gate — 0.9 only passes pure tones
 * - median filter that resets after silence so stale values don't
 *   drag the pitch when speech resumes
 * - octave-jump rejection: a sudden >6-semitone leap must persist for
 *   two frames before it's believed
 * - EMA-smoothed, briefly-held display value so the readout reads
 *   calm while the raw trace stays honest
 */

const WINDOW_SIZE = 2048
const MIN_HZ = 75
const MAX_HZ = 500
// Schmitt trigger on clarity: starting voicing takes solid evidence,
// but once voiced we keep tracking through weaker stretches — real
// reading voice through a laptop mic dips constantly, and a single
// threshold makes the meter drop out mid-vowel.
const CLARITY_START = 0.75
const CLARITY_CONTINUE = 0.65
const CONTINUE_WINDOW_S = 0.25
// Only guards true silence; voicing itself is decided by clarity.
const SILENCE_RMS = 0.001
const MEDIAN_WINDOW = 5
const MEDIAN_RESET_S = 0.3
const JUMP_LOG2 = 0.5 // ~6 semitones
const DISPLAY_HOLD_S = 0.35
const DISPLAY_EMA_ALPHA = 0.35

export interface PitchSample {
  /** Seconds since tracking started. */
  time: number
  /** Detected pitch in Hz, or null for unvoiced/silent frames. */
  hz: number | null
}

export class PitchTracker {
  private detector = PitchDetector.forFloat32Array(WINDOW_SIZE)
  private window = new Float32Array(WINDOW_SIZE)
  private filled = 0
  private samplesSeen = 0
  private samplesAtLastEstimate = -1
  private lastSample: PitchSample = { time: 0, hz: null }

  private recent: number[] = []
  private lastVoicedAt = -Infinity
  private pendingJump: number | null = null

  private displayLog2: number | null = null
  private displayAt = -Infinity

  /** Decaying peak level, for detecting a too-quiet input device. */
  peakRms = 0

  private readonly sampleRate: number
  /** All voiced estimates, kept for summary stats. */
  readonly voiced: number[] = []

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate
  }

  /** Append a PCM chunk to the sliding window. */
  feed(chunk: Float32Array) {
    this.samplesSeen += chunk.length
    if (chunk.length >= WINDOW_SIZE) {
      this.window.set(chunk.subarray(chunk.length - WINDOW_SIZE))
      this.filled = WINDOW_SIZE
      return
    }
    this.window.copyWithin(0, chunk.length)
    this.window.set(chunk, WINDOW_SIZE - chunk.length)
    this.filled = Math.min(WINDOW_SIZE, this.filled + chunk.length)
  }

  /** Current estimate for the trace; null when unvoiced. */
  estimate(): PitchSample {
    // No new audio since last time — return the cached result rather
    // than re-detecting the identical window.
    if (this.samplesSeen === this.samplesAtLastEstimate) return this.lastSample
    this.samplesAtLastEstimate = this.samplesSeen

    const time = this.samplesSeen / this.sampleRate
    this.lastSample = { time, hz: this.detect(time) }
    return this.lastSample
  }

  private detect(time: number): number | null {
    if (this.filled < WINDOW_SIZE) return null

    let sumSquares = 0
    for (let i = 0; i < WINDOW_SIZE; i++) sumSquares += this.window[i] * this.window[i]
    const rms = Math.sqrt(sumSquares / WINDOW_SIZE)
    this.peakRms = Math.max(this.peakRms * 0.995, rms)
    if (rms < SILENCE_RMS) return null

    const [pitch, clarity] = this.detector.findPitch(this.window, this.sampleRate)
    const voicedRecently = time - this.lastVoicedAt <= CONTINUE_WINDOW_S
    const clarityBar = voicedRecently ? CLARITY_CONTINUE : CLARITY_START
    if (clarity < clarityBar || pitch < MIN_HZ || pitch > MAX_HZ) return null

    // Silence resets the median so stale pitch can't drag new speech.
    if (time - this.lastVoicedAt > MEDIAN_RESET_S) {
      this.recent.length = 0
      this.pendingJump = null
    }

    // A sudden octave-ish leap must occur twice in a row to be real;
    // single-frame leaps are the classic MPM subharmonic blip.
    const reference =
      this.recent.length > 0 ? this.recent[this.recent.length - 1] : null
    if (reference !== null && Math.abs(Math.log2(pitch / reference)) > JUMP_LOG2) {
      if (
        this.pendingJump !== null &&
        Math.abs(Math.log2(pitch / this.pendingJump)) < 0.15
      ) {
        this.recent.length = 0 // the jump is real — follow it
      } else {
        this.pendingJump = pitch
        return null
      }
    }
    this.pendingJump = null

    this.recent.push(pitch)
    if (this.recent.length > MEDIAN_WINDOW) this.recent.shift()
    const sorted = [...this.recent].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]

    this.lastVoicedAt = time
    this.voiced.push(median)

    // Smooth the display value in log-pitch space.
    const log2 = Math.log2(median)
    this.displayLog2 =
      this.displayLog2 === null || time - this.displayAt > DISPLAY_HOLD_S
        ? log2
        : this.displayLog2 + DISPLAY_EMA_ALPHA * (log2 - this.displayLog2)
    this.displayAt = time

    return median
  }

  /**
   * Smoothed, briefly-held pitch for the big readout: survives short
   * consonant gaps so the number doesn't strobe.
   */
  displayHz(): number | null {
    if (this.displayLog2 === null) return null
    const time = this.samplesSeen / this.sampleRate
    if (time - this.displayAt > DISPLAY_HOLD_S) return null
    return 2 ** this.displayLog2
  }

  /** Summary for pitch_stats, or undefined if nothing voiced was heard. */
  stats(targetMinHz: number, targetMaxHz: number) {
    if (this.voiced.length === 0) return undefined
    const sorted = [...this.voiced].sort((a, b) => a - b)
    const inBand = this.voiced.filter((hz) => hz >= targetMinHz && hz <= targetMaxHz).length
    return {
      median_hz: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10,
      pct_in_band: Math.round((inBand / this.voiced.length) * 1000) / 1000,
      min_hz: Math.round(sorted[0] * 10) / 10,
      max_hz: Math.round(sorted[sorted.length - 1] * 10) / 10,
    }
  }
}
