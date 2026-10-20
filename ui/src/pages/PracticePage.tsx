import { useCallback, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Spinner } from '@/components/ui/Spinner'
import { Recorder } from '@/components/Recorder'
import { PassageText } from '@/components/PassageText'
import { FocusPointsPanel } from '@/components/FocusPointsPanel'
import { TakeList } from '@/components/TakeList'
import { ExerciseCoach, SIREN_AXIS } from '@/components/ExerciseCoach'
import { useRecordings, useScript, useScripts, useSettings } from '@/hooks/queries'
import { localDay, type Recording, type Script } from '@/lib/api'
import { EXERCISES, exerciseLine, isExercise, meterAtStart, type ExerciseKind, type ExerciseMeter } from '@/lib/exercises'
import { nextStep, routineSteps } from '@/lib/routine'
import type { LiveStore } from '@/lib/audio/liveStore'

/** A slim bar on top of a routine step: where you are and what's next. */
function RoutineBar({ script }: { script: Script }) {
  const { data: scripts } = useScripts()
  const { data: today } = useRecordings({ day: localDay(), limit: 200 })
  if (!scripts || !today) return null
  const steps = routineSteps(scripts, today)
  const i = steps.findIndex((s) => s.script.id === script.id)
  if (i < 0) return null
  const next = nextStep(steps, script.id)
  const done = steps.filter((s) => s.done).length
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-full bg-lavender-soft/70 px-5 py-2.5 text-sm">
      <Link to="/routine" className="font-semibold text-ink hover:underline">
        Today's routine: step {i + 1} of {steps.length}
        <span className="ml-2 font-normal text-ink-soft">
          ({done} done)
        </span>
      </Link>
      {next ? (
        <Link
          to={`/practice/${next.script.id}?routine=1`}
          className="flex items-center gap-1.5 font-semibold text-rose-deep hover:underline"
        >
          Next: {next.script.title} <ArrowRight size={14} />
        </Link>
      ) : (
        <span className="font-semibold text-sage-deep">All done today 🌸</span>
      )}
    </div>
  )
}

export function PracticePage() {
  const params = useParams()
  const [search] = useSearchParams()
  const scriptId = Number(params.scriptId)
  const { data: script, isLoading } = useScript(scriptId)
  const { data: settings } = useSettings()
  const today = localDay()
  const { data: todaysTakes } = useRecordings({ script_id: scriptId, day: today })

  const [followCount, setFollowCount] = useState(-1)

  // An exercise's meter: a fresh one for each take, kept after it ends.
  const bandMin = settings?.target_min_hz ?? 165
  const bandMax = settings?.target_max_hz ?? 220
  const [meter, setMeter] = useState<ExerciseMeter | null>(null)
  const [recording, setRecording] = useState(false)
  const storeRef = useRef<LiveStore | null>(null)
  const meterRef = useRef<ExerciseMeter | null>(null)
  const bandRef = useRef({ min: bandMin, max: bandMax })
  bandRef.current = { min: bandMin, max: bandMax }
  const newMeter = useMemo(() => meterAtStart(() => bandRef.current), [])
  const onLive = useCallback(
    (store: LiveStore | null) => {
      storeRef.current = store
      if (store) {
        const m = newMeter()
        store.frameListeners.push((f) => m.observe(f))
        meterRef.current = m
        setMeter(m)
      }
      setRecording(store !== null)
    },
    [newMeter],
  )
  const clock = useCallback(() => {
    const s = storeRef.current
    return s ? s.clock(performance.now()) - s.frameLag : Infinity
  }, [])
  const extraStats = useCallback(() => meterRef.current?.summary(), [])

  const kind = script?.kind
  const exercise = isExercise(kind) ? (kind as ExerciseKind) : null
  const savedLine = useMemo(
    () => (exercise ? (take: Recording) => exerciseLine(exercise, take.pitch_stats) : undefined),
    [exercise],
  )

  if (isLoading) return <Spinner label="Fetching your passage…" />
  if (!script) {
    return (
      <Card className="mx-auto max-w-md p-8 text-center text-ink-soft">
        <p>This passage isn't here anymore.</p>
        <Link to="/" className="mt-3 inline-block font-semibold text-rose-deep hover:underline">
          Pick another passage
        </Link>
      </Card>
    )
  }

  return (
    // On phones the studio docks to the bottom; --dock-h keeps the
    // passage's last lines clear of it.
    <div className="space-y-6 max-lg:pb-[calc(var(--dock-h,0px)+1.5rem)]">
      {search.get('routine') && <RoutineBar script={script} />}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-8">
        <div className="min-w-0 space-y-6">
          <header>
            <h1 className="font-display text-3xl font-bold tracking-tight text-ink text-balance sm:text-4xl">
              {exercise && (
                <span className="mr-2" aria-hidden>
                  {EXERCISES[exercise].emoji}
                </span>
              )}
              {script.title}
            </h1>
            {script.attribution && <p className="mt-1.5 text-sm text-ink-soft">{script.attribution}</p>}
          </header>

          {exercise ? (
            <>
              <ExerciseCoach
                kind={exercise}
                meter={meter}
                clock={clock}
                recording={recording}
                bandMin={bandMin}
                bandMax={bandMax}
              />
              <Card className="px-6 py-6 sm:px-8">
                <h2 className="mb-2 font-display text-base font-semibold text-ink">How to do it</h2>
                <div className="max-w-[65ch] space-y-3 text-base leading-relaxed text-ink">
                  {script.body.split(/\n\s*\n/).map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
              </Card>
            </>
          ) : (
            <Card className="px-6 py-7 sm:px-10 sm:py-9">
              <PassageText body={script.body} highlightCount={followCount} />
            </Card>
          )}

          <div className="lg:hidden">
            <FocusPointsPanel focusPointIds={script.focus_points} />
          </div>

          {todaysTakes && todaysTakes.length > 0 && (
            <section className="rounded-cozy border border-rose-whisper bg-card/70 p-4 sm:p-5">
              <h2 className="mb-1 px-3 font-display text-base font-semibold text-ink">
                Today's takes <span className="font-body text-sm font-normal text-ink-soft">({todaysTakes.length})</span>
              </h2>
              <TakeList takes={todaysTakes} />
            </section>
          )}
        </div>

        <aside className="lg:pt-[4.25rem]">
          <div className="space-y-5 lg:sticky lg:top-6">
            <Recorder
              scriptId={scriptId}
              passage={exercise ? '' : script.body}
              onFollowProgress={exercise ? undefined : setFollowCount}
              followAlong={!exercise}
              onLive={exercise ? onLive : undefined}
              extraStats={exercise ? extraStats : undefined}
              savedLine={savedLine}
              axis={exercise === 'siren' ? SIREN_AXIS : undefined}
              idleTitle={exercise ? 'Start the exercise' : undefined}
              idleHint={exercise ? EXERCISES[exercise].short + '.' : undefined}
            />
            <div className="max-lg:hidden">
              <FocusPointsPanel focusPointIds={script.focus_points} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
