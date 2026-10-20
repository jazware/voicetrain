import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ExerciseMeter, exerciseLine, isExercise, meterAtStart } from '../src/lib/exercises.ts'
import type { PitchFrame } from '../src/lib/audio/yin.ts'

/** 10 ms frames from a pitch function (null = unvoiced). */
function frames(seconds: number, hzAt: (t: number) => number | null, start = 0): PitchFrame[] {
  const out: PitchFrame[] = []
  for (let i = 0; i < Math.round(seconds * 100); i++) {
    const t = start + i / 100
    out.push({ time: t + 0.02, center: t, hz: hzAt(t), confidence: 0.9, rms: 0.05 })
  }
  return out
}

function feed(m: ExerciseMeter, fs: PitchFrame[]) {
  for (const f of fs) m.observe(f)
}

test('siren: the range is the 5th to 95th percentile, in semitones', () => {
  const m = new ExerciseMeter(165, 220)
  // 150 -> 300 -> 150 Hz, exponentially, over 4 s: one octave each way.
  feed(m, frames(4, (t) => 150 * 2 ** (t < 2 ? t / 2 : (4 - t) / 2)))
  const s = m.summary()!
  assert.ok(s.range_st > 10.3 && s.range_st < 11.6, `range ${s.range_st}`)
  assert.ok(Math.abs(s.low_hz - 155) < 6 && Math.abs(s.high_hz - 290) < 10, `${s.low_hz}..${s.high_hz}`)
  // A few stray frames (a tracker blip) don't stretch it.
  const blip = new ExerciseMeter(165, 220)
  feed(blip, frames(4, (t) => (t > 1 && t < 1.03 ? 900 : 200)))
  assert.ok(blip.summary()!.range_st < 0.5)
})

test('sustain: the longest hold bridges flickers, its steadiness skips the onset', () => {
  const m = new ExerciseMeter(165, 220)
  // A shaky onset, then 3 s at 200 Hz with ±5 cents of vibrato, a 100 ms
  // flicker of unvoicing (bridged), 1 more second, a real breath, a short hold.
  const steady = (t: number) => 200 * 2 ** ((5 / 1200) * Math.sin(2 * Math.PI * 5 * t))
  feed(m, frames(0.2, (t) => 180 + 100 * t))
  feed(m, frames(3, steady, 0.2))
  feed(m, frames(0.1, () => null, 3.2))
  feed(m, frames(1, steady, 3.3))
  feed(m, frames(0.6, () => null, 4.3))
  feed(m, frames(1, steady, 4.9))
  feed(m, frames(0.5, () => null, 5.9))
  const s = m.summary()!
  assert.ok(Math.abs(s.longest_hold_s - 4.29) < 0.05, `hold ${s.longest_hold_s}`)
  assert.ok(s.hold_sd_cents !== null && s.hold_sd_cents < 5, `steadiness ${s.hold_sd_cents}`)
})

test('sustain: the hold in progress reads live', () => {
  const m = new ExerciseMeter(165, 220)
  feed(m, frames(2, () => 200))
  assert.ok(Math.abs(m.currentHoldS(1.99) - 1.99) < 0.02)
  assert.equal(m.currentHoldS(3), 0, 'a hold ends after the gap')
})

test('hold the band: a streak survives breaths, ends after a real excursion', () => {
  const m = new ExerciseMeter(165, 220)
  feed(m, frames(5, (t) => (t % 1 > 0.75 ? null : 190))) // 250 ms breaths every second
  feed(m, frames(1, () => 140, 5)) // a second below home: breaks the streak
  feed(m, frames(3, () => 200, 6))
  const s = m.summary()!
  assert.ok(Math.abs(s.longest_in_band_s - 4.75) < 0.05, `streak ${s.longest_in_band_s}`)
  assert.ok(Math.abs(m.currentStreakS(8.99) - 2.99) < 0.02)
  const pct = m.inBandPct()!
  assert.ok(pct > 85 && pct < 90, `in band ${pct}`)
})

test('summaries need a voice', () => {
  assert.equal(new ExerciseMeter(165, 220).summary(), undefined)
})

test('one line per kind for the saved card', () => {
  assert.equal(exerciseLine('siren', { range_st: 13.6, low_hz: 141, high_hz: 310.4 }), 'a 14-semitone range, 141 to 310 Hz')
  assert.equal(exerciseLine('sustain', { longest_hold_s: 6.25, hold_sd_cents: 11.6 }), 'a 6.3 s hold, steady within ±12 cents')
  assert.equal(exerciseLine('hold', { longest_in_band_s: 31.7 }), 'a 32 s stretch at home')
  assert.equal(exerciseLine('siren', undefined), null)
  assert.ok(isExercise('hold') && !isExercise('passage') && !isExercise(undefined))
})

test('a meter takes the band in force when the take starts', () => {
  let band = { min: 165, max: 220 } // the fallback, before settings load
  const newMeter = meterAtStart(() => band)
  band = { min: 180, max: 240 } // settings arrive
  const m = newMeter()
  feed(m, frames(2, () => 230))
  assert.equal(Math.round(m.inBandPct()!), 100, 'judged against the loaded band, not the fallback')
})
