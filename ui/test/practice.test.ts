import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lastWeek, median, streak } from '../src/lib/practice.ts'
import { bandState, pitchY, PITCH_AXIS } from '../src/lib/band.ts'
import { localDay, type HeatmapDay } from '../src/lib/api.ts'

const day = (d: Date, offset: number) => {
  const x = new Date(d)
  x.setDate(x.getDate() + offset)
  return localDay(x)
}
const practiced = (today: Date, offsets: number[], minutes = 3): HeatmapDay[] =>
  offsets.map((o) => ({ day: day(today, o), count: 1, total_duration_ms: minutes * 60000 }))

test('streak counts back from today, or from yesterday before today’s take', () => {
  const today = new Date(2026, 9, 13, 18)
  assert.equal(streak([], today), 0)
  assert.equal(streak(practiced(today, [0, -1, -2]), today), 3)
  assert.equal(streak(practiced(today, [-1, -2]), today), 2, 'a run is still alive the next day')
  assert.equal(streak(practiced(today, [-2, -3]), today), 0, 'a missed day ends it')
  assert.equal(streak(practiced(today, [0, -2]), today), 1)
  // Days with zero takes don't count.
  assert.equal(streak([{ day: day(today, 0), count: 0, total_duration_ms: 0 }], today), 0)
})

test('streak crosses month and DST boundaries', () => {
  const today = new Date(2026, 10, 2, 9) // after the US DST change
  const offsets = Array.from({ length: 10 }, (_, i) => -i)
  assert.equal(streak(practiced(today, offsets), today), 10)
})

test('lastWeek is seven days ending today, oldest first', () => {
  const today = new Date(2026, 9, 13, 18)
  const week = lastWeek(practiced(today, [0, -3], 4), today)
  assert.equal(week.length, 7)
  assert.equal(week[6].day, localDay(today))
  assert.ok(week[6].isToday && !week[0].isToday)
  assert.equal(week[0].day, day(today, -6))
  assert.equal(week[6].minutes, 4)
  assert.equal(week[3].takes, 1)
  assert.equal(week[1].takes, 0)
})

test('median', () => {
  assert.equal(median([]), null)
  assert.equal(median([3]), 3)
  assert.equal(median([5, 1, 3]), 3)
  assert.equal(median([4, 1, 3, 2]), 2.5)
})

test('bandState: home, near (within 10%), away, silent', () => {
  assert.equal(bandState(null, 165, 220), 'none')
  assert.equal(bandState(165, 165, 220), 'in')
  assert.equal(bandState(220, 165, 220), 'in')
  assert.equal(bandState(150, 165, 220), 'near')
  assert.equal(bandState(240, 165, 220), 'near')
  assert.equal(bandState(140, 165, 220), 'out')
  assert.equal(bandState(250, 165, 220), 'out')
})

test('pitchY is a log axis, clamped to the chart', () => {
  const h = 100
  assert.equal(pitchY(PITCH_AXIS.minHz, h), h)
  assert.equal(pitchY(PITCH_AXIS.maxHz, h), 0)
  assert.equal(pitchY(20, h), h)
  assert.equal(pitchY(2000, h), 0)
  // An octave is the same distance anywhere on the axis.
  const a = pitchY(100, h) - pitchY(200, h)
  const b = pitchY(150, h) - pitchY(300, h)
  assert.ok(Math.abs(a - b) < 1e-9)
})
