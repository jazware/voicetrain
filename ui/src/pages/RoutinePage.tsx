import { Link } from 'react-router-dom'
import { clsx } from 'clsx'
import { Check, Mic } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Spinner } from '@/components/ui/Spinner'
import { useRecordings, useScripts } from '@/hooks/queries'
import { localDay } from '@/lib/api'
import { EXERCISES, isExercise } from '@/lib/exercises'
import { routineSteps } from '@/lib/routine'

/**
 * The daily routine: four short steps in order, each done once today
 * has a take of it. Each step opens the usual practice page with a bar
 * that leads on to the next one.
 */
export function RoutinePage() {
  const { data: scripts, isLoading } = useScripts()
  const { data: today } = useRecordings({ day: localDay(), limit: 200 })
  if (isLoading || !scripts) return <Spinner label="Laying out today's routine…" />

  const steps = routineSteps(scripts, today ?? [])
  const done = steps.filter((s) => s.done).length
  const minutes = steps.filter((s) => !s.done).reduce((n, s) => n + s.minutes, 0)
  const nextIndex = steps.findIndex((s) => !s.done)

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">Today's routine</h1>
        <p className="text-base leading-relaxed text-ink-soft">
          {done === steps.length
            ? 'All done for today. Lovely work; rest your voice now.'
            : done === 0
              ? `Four small steps, about ${minutes} minutes. Warm up, settle, then put it together.`
              : `${done} of ${steps.length} done, about ${minutes} minutes to go.`}
        </p>
      </header>

      <ol className="relative space-y-4 before:absolute before:top-6 before:bottom-6 before:left-[1.4rem] before:w-0.5 before:bg-rose-soft">
        {steps.map((step, i) => {
          const kind = step.script.kind
          const emoji = isExercise(kind) ? EXERCISES[kind].emoji : '📖'
          const isNext = i === nextIndex
          return (
            <li key={step.script.id} className="relative flex items-start gap-4">
              <span
                className={clsx(
                  'relative z-10 flex h-11 w-11 shrink-0 items-center justify-center rounded-full font-display text-lg font-bold',
                  step.done ? 'bg-sage text-white' : isNext ? 'bg-rose text-white shadow-cozy' : 'bg-card text-ink-soft ring-2 ring-rose-soft',
                )}
                aria-label={step.done ? `Step ${i + 1}, done` : `Step ${i + 1}`}
              >
                {step.done ? <Check size={20} /> : i + 1}
              </span>
              <Card className={clsx('flex flex-1 flex-wrap items-center justify-between gap-3 p-5', isNext && 'ring-2 ring-rose-soft')}>
                <div className="min-w-0">
                  <p className="font-display text-lg font-semibold text-ink">
                    <span className="mr-1.5" aria-hidden>
                      {emoji}
                    </span>
                    {step.script.title}
                  </p>
                  <p className="text-sm text-ink-soft">
                    {step.why}, about {step.minutes} minutes
                  </p>
                </div>
                <Link
                  to={`/practice/${step.script.id}?routine=1`}
                  className={clsx(
                    'inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors',
                    isNext ? 'bg-rose text-white hover:bg-rose-deep' : 'bg-rose-whisper text-rose-deep hover:bg-rose-soft',
                  )}
                >
                  <Mic size={14} />
                  {step.done ? 'Again' : 'Start'}
                </Link>
              </Card>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
