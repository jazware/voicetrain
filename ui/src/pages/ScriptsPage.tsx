import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { clsx } from 'clsx'
import { Mic, Pencil, Plus } from 'lucide-react'
import { useHeatmap, useRecordings, useScripts } from '@/hooks/queries'
import { greeting, formatDay } from '@/lib/format'
import { focusPointById } from '@/lib/focusPoints'
import { lastWeek, streak } from '@/lib/practice'
import { EXERCISES, EXERCISE_KINDS, isExercise } from '@/lib/exercises'
import { routineSteps } from '@/lib/routine'
import { localDay, type HeatmapDay, type Script } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Spinner } from '@/components/ui/Spinner'
import { ScriptFormDialog } from '@/components/ScriptFormDialog'

/** Seven little suns, one per day, filled by how much you practiced. */
function WeekStrip({ days }: { days: HeatmapDay[] }) {
  const week = lastWeek(days)
  return (
    <ol className="flex gap-2" aria-label="The last seven days">
      {week.map((d) => {
        const level = d.takes === 0 ? 0 : d.minutes < 3 ? 1 : d.minutes < 8 ? 2 : 3
        return (
          <li key={d.day} className="flex flex-col items-center gap-1">
            <span
              title={`${d.name}: ${d.takes ? `${d.takes} ${d.takes === 1 ? 'take' : 'takes'}, ${Math.max(1, Math.round(d.minutes))} min` : 'rest day'}`}
              className={clsx(
                'h-7 w-7 rounded-full transition-colors sm:h-8 sm:w-8',
                level === 0 && 'border-2 border-dashed border-rose-soft',
                level === 1 && 'bg-peach',
                level === 2 && 'bg-[#ec8a7e]',
                level === 3 && 'bg-rose-deep',
                d.isToday && 'outline-2 outline-offset-2 outline-ink/20',
              )}
            />
            <span className={clsx('text-[11px] font-semibold', d.isToday ? 'text-ink' : 'text-ink-soft')}>{d.label}</span>
            <span className="sr-only">
              {d.name}: {d.takes ? `${d.takes} takes` : 'rest'}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function TodayCard({ scripts, days }: { scripts: Script[]; days: HeatmapDay[] }) {
  const { data: todaysTakes } = useRecordings({ day: localDay(), limit: 200 })
  const steps = routineSteps(scripts, todaysTakes ?? [])
  const stepsDone = steps.filter((s) => s.done).length
  const today = localDay()
  const practicedToday = days.some((d) => d.day === today && d.count > 0)
  const run = streak(days)
  // Pick up the passage practiced most recently, or the first one.
  const passages = scripts.filter((s) => s.kind === 'passage')
  const next =
    [...passages].filter((s) => s.last_practiced_day).sort((a, b) => (b.last_practiced_day! > a.last_practiced_day! ? 1 : -1))[0] ??
    passages.find((s) => s.title === 'The Rainbow Passage') ??
    passages[0]
  const firstTime = !scripts.some((s) => s.take_count > 0)

  let line: string
  if (firstTime) line = 'Your first take starts the story. Read a passage aloud and see what your voice is doing.'
  else if (practicedToday && run > 1) line = `That's ${run} days in a row. One more take, or call it a day.`
  else if (practicedToday) line = 'You showed up today. Another take, or call it a day.'
  else if (run > 0) line = `You're on a ${run}-day run. A few minutes today keeps it going.`
  else line = 'A few minutes today is plenty.'

  return (
    <Card className="flex flex-col gap-6 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
      <div className="max-w-md space-y-4">
        <p className="text-base leading-relaxed text-ink-soft">{line}</p>
        {next && (
          <Link
            to={`/practice/${next.id}`}
            className="inline-flex items-center gap-2.5 rounded-full bg-rose py-3 pr-6 pl-4 font-semibold text-white shadow-cozy transition-colors hover:bg-rose-deep"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20">
              <Mic size={17} />
            </span>
            {firstTime ? `Start with ${next.title}` : `Practice ${next.title}`}
          </Link>
        )}
        {steps.length > 0 && (
          <p className="text-sm text-ink-soft">
            Or the{' '}
            <Link to="/routine" className="font-semibold text-rose-deep hover:underline">
              daily routine
            </Link>
            {stepsDone > 0 ? `: ${stepsDone} of ${steps.length} done today` : ': sirens, a steady note, a minute at home, then a passage'}
            .
          </p>
        )}
      </div>
      {!firstTime && <WeekStrip days={days} />}
    </Card>
  )
}

function ScriptCard({ script, onEdit }: { script: Script; onEdit: () => void }) {
  return (
    <Card className="group relative flex flex-col p-6">
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="font-display text-xl font-semibold leading-snug text-ink text-balance">
          <Link
            to={`/practice/${script.id}`}
            className="after:absolute after:inset-0 after:rounded-cozy focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-rose focus-visible:after:ring-offset-2 focus-visible:after:ring-offset-cream"
          >
            {script.title}
          </Link>
        </h3>
        <button
          onClick={onEdit}
          aria-label={`Edit ${script.title}`}
          className="relative z-10 -mt-1 -mr-2 rounded-full p-2 text-ink-soft transition-colors hover:bg-rose-whisper hover:text-ink"
        >
          <Pencil size={15} />
        </button>
      </div>

      <p className="mb-4 line-clamp-2 max-w-[60ch] text-sm leading-relaxed text-ink-soft">{script.body}</p>

      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm text-ink-soft">
          {script.take_count > 0 ? (
            <>
              {script.take_count} {script.take_count === 1 ? 'take' : 'takes'}
              {script.last_practiced_day && <>, last on {formatDay(script.last_practiced_day)}</>}
            </>
          ) : (
            'Not practiced yet'
          )}
        </span>
        <span className="flex flex-wrap gap-1.5">
          {script.focus_points.map((id) => {
            const fp = focusPointById.get(id)
            if (!fp) return null
            return (
              <span key={id} className="rounded-full bg-lavender-soft px-2.5 py-0.5 text-xs font-semibold text-ink-soft">
                {fp.title}
              </span>
            )
          })}
        </span>
      </div>
    </Card>
  )
}

export function ScriptsPage() {
  const { data: scripts, isLoading, error } = useScripts()
  const { data: days } = useHeatmap()
  const [editing, setEditing] = useState<Script | null>(null)
  const [creating, setCreating] = useState(false)
  const hello = useMemo(() => greeting(), [])

  return (
    <div className="space-y-8">
      <h1 className="mt-2 font-display text-4xl font-bold tracking-tight text-ink sm:text-5xl">{hello}</h1>

      {isLoading && <Spinner label="Gathering your passages…" />}
      {error && (
        <Card className="p-6 text-center text-ink-soft">
          Can't reach the voicetrain server. Is it running?
        </Card>
      )}

      {scripts && <TodayCard scripts={scripts} days={days ?? []} />}

      {scripts && (
        <section className="space-y-3">
          <h2 className="px-1 font-display text-xl font-semibold text-ink">Passages</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {scripts.filter((s) => s.kind === 'passage').map((script) => (
              <ScriptCard key={script.id} script={script} onEdit={() => setEditing(script)} />
            ))}
            <button
              onClick={() => setCreating(true)}
              className="flex min-h-24 items-center justify-center gap-2 rounded-cozy border-2 border-dashed border-rose-soft text-ink-soft transition-colors hover:border-rose hover:bg-rose-whisper hover:text-rose-deep"
            >
              <Plus size={20} />
              <span className="text-sm font-semibold">Add your own passage</span>
            </button>
          </div>
        </section>
      )}

      {scripts && scripts.some((s) => isExercise(s.kind)) && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between gap-3 px-1">
            <h2 className="font-display text-xl font-semibold text-ink">Exercises</h2>
            <Link to="/routine" className="text-sm font-semibold text-rose-deep hover:underline">
              Today's routine
            </Link>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {EXERCISE_KINDS.map((kind) => {
              const s = scripts.find((x) => x.kind === kind)
              if (!s) return null
              return (
                <Card key={kind} className="group relative flex flex-col gap-2 p-5">
                  <span className="text-3xl" aria-hidden>
                    {EXERCISES[kind].emoji}
                  </span>
                  <h3 className="font-display text-lg font-semibold text-ink">
                    <Link
                      to={`/practice/${s.id}`}
                      className="after:absolute after:inset-0 after:rounded-cozy focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-rose focus-visible:after:ring-offset-2 focus-visible:after:ring-offset-cream"
                    >
                      {s.title}
                    </Link>
                  </h3>
                  <p className="text-sm leading-relaxed text-ink-soft">{EXERCISES[kind].short}</p>
                  <p className="mt-auto pt-1 text-xs text-ink-soft">
                    {s.take_count > 0 ? `${s.take_count} ${s.take_count === 1 ? 'take' : 'takes'}` : 'Not tried yet'}
                  </p>
                </Card>
              )
            })}
          </div>
        </section>
      )}

      <ScriptFormDialog open={creating} onClose={() => setCreating(false)} script={null} />
      <ScriptFormDialog open={editing !== null} onClose={() => setEditing(null)} script={editing} />
    </div>
  )
}
