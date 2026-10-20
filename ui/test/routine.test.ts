import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextStep, routineSteps } from '../src/lib/routine.ts'
import type { Recording, Script } from '../src/lib/api.ts'

const script = (id: number, kind: string, title: string, last?: string): Script => ({
  id, kind, title, body: '', attribution: '', focus_points: [], is_seeded: true,
  created_at: 0, updated_at: 0, take_count: last ? 1 : 0, last_practiced_day: last,
})
const take = (scriptId: number): Recording => ({
  id: scriptId * 10, script_id: scriptId, file_path: 'x', duration_ms: 1, sample_rate: 48000, channels: 1,
  size_bytes: 1, rating: null, notes: '', recorded_at: 0, local_day: '2026-10-13', created_at: 0, updated_at: 0,
})

const scripts = [
  script(1, 'passage', 'The Rainbow Passage', '2026-10-01'),
  script(2, 'passage', 'Comma Gets a Cure', '2026-10-12'),
  script(3, 'siren', 'Sirens'),
  script(4, 'sustain', 'Sustained “ah”'),
  script(5, 'hold', 'Hold the band'),
]

test('the routine is siren, sustain, hold, then the passage practised most recently', () => {
  const steps = routineSteps(scripts, [])
  assert.deepEqual(steps.map((s) => s.script.id), [3, 4, 5, 2])
  assert.ok(steps.every((s) => !s.done))
})

test("today's passage takes stay the routine's passage", () => {
  const steps = routineSteps(scripts, [take(1)])
  assert.equal(steps[3].script.id, 1)
  assert.ok(steps[3].done)
})

test('steps are done by takes today, and next skips what is done', () => {
  const steps = routineSteps(scripts, [take(3), take(5)])
  assert.deepEqual(steps.map((s) => s.done), [true, false, true, false])
  assert.equal(nextStep(steps, 3)?.script.id, 4)
  assert.equal(nextStep(steps, 4)?.script.id, 2)
  assert.equal(nextStep(routineSteps(scripts, [take(3), take(4), take(5), take(2)]), 2), undefined)
})

test('without exercises the routine is just the passage', () => {
  const steps = routineSteps(scripts.filter((s) => s.kind === 'passage'), [])
  assert.deepEqual(steps.map((s) => s.script.id), [2])
})
