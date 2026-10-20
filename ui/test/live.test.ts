import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LiveAnalyzer } from '../src/lib/audio/liveAnalyzer.ts'
import { LiveStore } from '../src/lib/audio/liveStore.ts'

const SR = 48000

function tone(hz: number, seconds: number): Float32Array {
  const x = new Float32Array(Math.round(seconds * SR))
  for (let i = 0; i < x.length; i++) {
    let s = 0
    for (let h = 1; h <= 8; h++) s += Math.sin((2 * Math.PI * h * hz * i) / SR) / h
    x[i] = 0.1 * s
  }
  return x
}

test('analyzer: frames every 10 ms, peaks every 20 ms, and a WAV of every sample', () => {
  const a = new LiveAnalyzer(SR)
  const x = tone(200, 2)
  let frames = 0
  let peaks = 0
  let last = 0
  for (let i = 0; i < x.length; i += 512) {
    const u = a.push(x.slice(i, i + 512))
    frames += u.frames.length
    peaks += u.peaks.length / 2
    assert.ok(u.time > last)
    last = u.time
  }
  assert.ok(Math.abs(frames - 200) <= 5, `frames ${frames}`)
  assert.equal(peaks, 100)
  assert.equal(last, 2)

  const wav = new DataView(a.finish())
  assert.equal(String.fromCharCode(wav.getUint8(0), wav.getUint8(1), wav.getUint8(2), wav.getUint8(3)), 'RIFF')
  assert.equal(wav.getUint32(24, true), SR)
  assert.equal(wav.getUint32(40, true), x.length * 2)
  // Samples survive the round trip to 16-bit.
  assert.ok(Math.abs(wav.getInt16(44 + 1000 * 2, true) / 32767 - x[1000]) < 1e-3)
})

test('store: keeps ~12 s, interpolates the clock, caps it when updates stall', () => {
  const a = new LiveAnalyzer(SR)
  const store = new LiveStore(a.tracker.frameLag, 0.02)
  const x = tone(200, 15)
  const realNow = performance.now
  let now = 1000
  performance.now = () => now
  try {
    for (let i = 0; i < x.length; i += 512) store.apply(a.push(x.slice(i, i + 512)))
    assert.ok(store.traceT[0] >= 15 - 12 - 0.02, `oldest kept frame ${store.traceT[0]}`)
    assert.ok(store.peaks[0][0] >= 15 - 12 - 0.02)
    assert.equal(store.clock(now), 15)
    assert.equal(store.clock(now + 20), 15.02)
    assert.equal(store.clock(now + 5000), 15.05)
    const hz = store.readout.displayHz()
    assert.ok(hz !== null && Math.abs(hz - 200) < 3, `readout ${hz}`)
    assert.ok(Math.abs(store.readout.stats(165, 220)!.median_hz - 200) < 1)
  } finally {
    performance.now = realNow
  }
})
