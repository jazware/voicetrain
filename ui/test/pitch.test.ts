// Ground-truth tests for the live pitch tracker on synthetic voices.
// Run with `pnpm test` (node --test; Node strips the types itself).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { YinTracker, OneEuro, type PitchFrame } from '../src/lib/audio/yin.ts'
import { PitchTracker, pitchStats } from '../src/lib/audio/pitchTracker.ts'

const SR = 48000

/** A glottal-ish source: harmonics rolling off 1/n^1.2 through two formant bumps. */
function voice(
  f0At: (t: number) => number,
  seconds: number,
  opts: { amp?: number; skipFundamental?: boolean; formants?: [number, number]; alternate?: number; sr?: number } = {},
): Float32Array {
  const sr = opts.sr ?? SR
  const [fa, fb] = opts.formants ?? [700, 1800]
  const n = Math.round(seconds * sr)
  const out = new Float32Array(n)
  let phase = 0
  let cycle = 0
  for (let i = 0; i < n; i++) {
    const f0 = f0At(i / sr)
    if (f0 <= 0) continue
    phase += f0 / sr
    if (phase >= 1) {
      phase -= 1
      cycle++
    }
    let s = 0
    for (let h = opts.skipFundamental ? 2 : 1; h * f0 < 5000; h++) {
      const fh = h * f0
      const shape = 1 + 3 * Math.exp(-(((fh - fa) / 250) ** 2)) + 2 * Math.exp(-(((fh - fb) / 300) ** 2))
      s += (shape / h ** 1.2) * Math.sin(2 * Math.PI * h * (cycle + phase))
    }
    // Period doubling: every other cycle a little louder, as in creak.
    const alt = opts.alternate && cycle % 2 ? 1 - opts.alternate : 1
    out[i] = s * alt * (opts.amp ?? 0.05)
  }
  return out
}

function noise(seconds: number, rms: number, seed = 1): Float32Array {
  let x = seed
  const out = new Float32Array(Math.round(seconds * SR))
  for (let i = 0; i < out.length; i++) {
    // Sum of uniforms ≈ gaussian, deterministic.
    let s = 0
    for (let k = 0; k < 4; k++) {
      x = (x * 1664525 + 1013904223) >>> 0
      s += x / 2 ** 32 - 0.5
    }
    out[i] = s * rms * Math.sqrt(3)
  }
  return out
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function mix(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(Math.max(a.length, b.length))
  for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0)
  return out
}

/** Feeds audio in render-quantum-sized chunks, like the worklet does. */
function track(x: Float32Array, sr = SR): PitchFrame[] {
  const t = new YinTracker(sr)
  const frames: PitchFrame[] = []
  for (let i = 0; i < x.length; i += 128) frames.push(...t.push(x.subarray(i, i + 128)))
  return frames
}

const cents = (a: number, b: number) => Math.abs(1200 * Math.log2(a / b))
const voicedIn = (frames: PitchFrame[], t0: number, t1: number) =>
  frames.filter((f) => f.center >= t0 && f.center <= t1)

test('steady voices across the speaking range, within 15 cents', () => {
  for (const sr of [48000, 44100]) {
    for (const f0 of [75, 110, 165, 220, 330, 500]) {
      const frames = voicedIn(track(voice(() => f0, 1, { sr }), sr), 0.15, 0.95)
      const voiced = frames.filter((f) => f.hz !== null)
      assert.ok(voiced.length >= frames.length * 0.95, `${f0} Hz @ ${sr}: voiced ${voiced.length}/${frames.length}`)
      for (const f of voiced) assert.ok(cents(f.hz!, f0) < 15, `${f0} Hz @ ${sr}: read ${f.hz}`)
    }
  }
})

test('a missing fundamental still reads as the fundamental', () => {
  const frames = voicedIn(track(voice(() => 180, 1, { skipFundamental: true })), 0.15, 0.95)
  for (const f of frames) assert.ok(f.hz !== null && cents(f.hz, 180) < 20, `read ${f.hz}`)
})

test('a strong first formant at 2*f0 does not pull the reading up an octave', () => {
  const frames = voicedIn(track(voice(() => 175, 1, { formants: [350, 2400] })), 0.15, 0.95)
  for (const f of frames) assert.ok(f.hz !== null && cents(f.hz, 175) < 20, `read ${f.hz}`)
})

test('period doubling (creak-like alternation) does not drop an octave', () => {
  const frames = voicedIn(track(voice(() => 160, 1, { alternate: 0.15 })), 0.15, 0.95)
  for (const f of frames) assert.ok(f.hz !== null && cents(f.hz, 160) < 20, `read ${f.hz}`)
})

test('silence, room noise and mains hum stay unvoiced', () => {
  const t = (i: number) => i / SR
  const hum = new Float32Array(SR * 3).map((_, i) => 0.0015 * Math.sin(2 * Math.PI * 60 * t(i)) + 0.0008 * Math.sin(2 * Math.PI * 120 * t(i)))
  for (const [name, x] of [
    ['silence', new Float32Array(SR * 2)],
    ['noise', noise(3, 0.01)],
    ['hum', mix(hum, noise(3, 0.0005))],
  ] as const) {
    const frames = track(x)
    const voiced = frames.filter((f) => f.hz !== null).length
    assert.ok(voiced <= frames.length * 0.01, `${name}: ${voiced}/${frames.length} frames voiced`)
  }
})

test('voice in moderate noise (20 dB SNR) keeps its pitch', () => {
  const v = voice(() => 190, 1.5)
  let e = 0
  for (const s of v) e += s * s
  const rms = Math.sqrt(e / v.length)
  const frames = voicedIn(track(mix(v, noise(1.5, rms / 10))), 0.2, 1.4)
  const voiced = frames.filter((f) => f.hz !== null)
  assert.ok(voiced.length >= frames.length * 0.9, `voiced ${voiced.length}/${frames.length}`)
  for (const f of voiced) assert.ok(cents(f.hz!, 190) < 25, `read ${f.hz}`)
})

test('glides are followed without lag beyond the frame offset', () => {
  // 150 -> 300 Hz over 1 s, exponential: an octave a second.
  const frames = voicedIn(track(voice((t) => 150 * 2 ** t, 1.2)), 0.15, 1.0)
  for (const f of frames) {
    assert.ok(f.hz !== null)
    assert.ok(cents(f.hz, 150 * 2 ** f.center) < 40, `t=${f.center.toFixed(2)} read ${f.hz} want ${150 * 2 ** f.center}`)
  }
})

test('the trace follows a 5-semitone step within 40 ms of audio', () => {
  const x = voice((t) => (t < 1 ? 180 : 240), 2)
  const frames = track(x)
  const first = frames.find((f) => f.center > 1 && f.hz !== null && cents(f.hz, 240) < 50)
  assert.ok(first, 'never reached 240 Hz')
  assert.ok(first.time - 1 < 0.04, `trace reached the new pitch ${((first.time - 1) * 1000).toFixed(0)} ms after the step`)
})

test('voice onsets need a few agreeing frames, so isolated blips never show', () => {
  // 15 ms bursts of voice in silence: shorter than the onset check.
  const parts: Float32Array[] = []
  for (let i = 0; i < 20; i++) parts.push(voice(() => 200, 0.015), new Float32Array(SR * 0.2))
  const voiced = track(concat(...parts)).filter((f) => f.hz !== null)
  assert.equal(voiced.length, 0)
})

test('readout settles on steady notes and jumps for real moves', () => {
  const p = new PitchTracker(SR)
  const x = voice((t) => (t < 1 ? 180 * (1 + 0.004 * Math.sin(2 * Math.PI * 5 * t)) : 240), 2)
  const shown: Array<[number, number | null]> = []
  for (let i = 0; i < x.length; i += 128) {
    for (const f of p.push(x.subarray(i, i + 128))) shown.push([f.center, p.displayHz()])
  }
  // Vibrato of ±7 cents: the readout should change rarely.
  const steady = shown.filter(([t, v]) => t > 0.3 && t < 1 && v !== null).map(([, v]) => Math.round(v!))
  const changes = steady.slice(1).filter((v, i) => v !== steady[i]).length
  assert.ok(changes <= 3, `readout changed ${changes} times on a steady note`)
  const after = shown.find(([t, v]) => t > 1 && v !== null && cents(v, 240) < 100)
  assert.ok(after && after[0] - 1 < 0.1, `readout reached 240 Hz ${after ? ((after[0] - 1) * 1000).toFixed(0) : '∞'} ms after the step`)
})

test('readout holds through a short gap, blanks after a pause', () => {
  const p = new PitchTracker(SR)
  const x = concat(voice(() => 200, 0.5), new Float32Array(SR * 0.15), voice(() => 200, 0.3), new Float32Array(SR * 0.6))
  const shown: Array<[number, number | null]> = []
  for (let i = 0; i < x.length; i += 128) for (const f of p.push(x.subarray(i, i + 128))) shown.push([f.center, p.displayHz()])
  const at = (t: number) => shown.reduce((best, s) => (Math.abs(s[0] - t) < Math.abs(best[0] - t) ? s : best))[1]
  assert.ok(at(0.58) !== null, 'blanked during a 150 ms gap')
  assert.equal(at(1.5), null)
})

test('one-euro: converges on constants, tracks ramps', () => {
  const f = new OneEuro(1, 0.6)
  let v = 0
  for (let i = 0; i < 300; i++) v = f.filter(5, 0.01)
  assert.ok(Math.abs(v - 5) < 1e-6)
  f.reset()
  for (let i = 0; i < 100; i++) v = f.filter(i * 0.01, 0.01)
  assert.ok(Math.abs(v - 0.99) < 0.1, `ramp lag ${0.99 - v}`)
})

test('pitch stats summarize a take', () => {
  const voiced = [150, 160, 170, 180, 190, 200, 210, 220, 230, 240]
  const s = pitchStats(voiced, 165, 220)!
  assert.equal(s.median_hz, 200)
  assert.equal(s.pct_in_band, 0.6)
  assert.equal(pitchStats([], 165, 220), undefined)
})

test('runs far faster than real time', () => {
  const x = voice((t) => 150 + 50 * Math.sin(t), 10)
  const t0 = performance.now()
  track(x)
  const ms = performance.now() - t0
  assert.ok(ms < 1000, `10 s of audio took ${ms.toFixed(0)} ms`)
})
