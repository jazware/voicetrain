import type { Recording, Script } from './api.ts'

export interface RoutineStep {
  script: Script
  /** Why this step is in the routine, in a few words. */
  why: string
  minutes: number
  done: boolean
}

const STEPS: Array<{ kind: string; why: string; minutes: number }> = [
  { kind: 'siren', why: 'Wake the voice up gently', minutes: 2 },
  { kind: 'sustain', why: 'Settle on one steady note', minutes: 2 },
  { kind: 'hold', why: 'Talk for a minute, at home', minutes: 2 },
  { kind: 'passage', why: 'Put it together on a passage', minutes: 3 },
]

/**
 * The daily routine: a siren, a sustained vowel, a minute holding the
 * band, then a passage (the one practised most recently). A step is done
 * once today has a take of it.
 */
export function routineSteps(scripts: Script[], todaysTakes: Recording[]): RoutineStep[] {
  const takenToday = new Set(todaysTakes.map((t) => t.script_id))
  const passages = scripts.filter((s) => s.kind === 'passage')
  const passage =
    passages.find((s) => takenToday.has(s.id)) ??
    [...passages].filter((s) => s.last_practiced_day).sort((a, b) => (b.last_practiced_day! > a.last_practiced_day! ? 1 : -1))[0] ??
    passages.find((s) => s.title === 'The Rainbow Passage') ??
    passages[0]
  const steps: RoutineStep[] = []
  for (const st of STEPS) {
    const script = st.kind === 'passage' ? passage : scripts.find((s) => s.kind === st.kind)
    if (script) steps.push({ script, why: st.why, minutes: st.minutes, done: takenToday.has(script.id) })
  }
  return steps
}

/** The step after the one for scriptId, or the first one not done yet. */
export function nextStep(steps: RoutineStep[], scriptId: number): RoutineStep | undefined {
  const i = steps.findIndex((s) => s.script.id === scriptId)
  return steps.slice(i + 1).find((s) => !s.done) ?? steps.find((s) => !s.done && s.script.id !== scriptId)
}
