import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { clsx } from 'clsx'
import { Card } from '@/components/ui/Card'
import { Spinner } from '@/components/ui/Spinner'
import { Heatmap } from '@/components/Heatmap'
import { TakeList } from '@/components/TakeList'
import { ProgressChart, type ProgressMetric } from '@/components/ProgressChart'
import { useHeatmap, useRecordings, useScripts, useSettings, useTrends } from '@/hooks/queries'
import type { HeatmapDay, TrendPoint } from '@/lib/api'
import { EXERCISES, type ExerciseKind } from '@/lib/exercises'
import { formatDay } from '@/lib/format'
import { median, streak } from '@/lib/practice'

const DAY_MS = 86_400_000

/** A few plain sentences about the last week against a month earlier. */
function summarize(points: TrendPoint[], days: HeatmapDay[]): string[] {
  const now = Date.now()
  const pitch = (p: TrendPoint) => p.median_hz ?? p.live_median_hz
  const inWindow = (from: number, to: number) =>
    points.filter((p) => p.recorded_at >= now - to * DAY_MS && p.recorded_at < now - from * DAY_MS)
  const week = inWindow(0, 7)
  const monthAgo = inWindow(28, 35)
  const out: string[] = []

  const takes = days.reduce((n, d) => n + d.count, 0)
  const minutes = Math.round(days.reduce((n, d) => n + d.total_duration_ms, 0) / 60000)
  const run = streak(days)
  if (takes > 0) {
    out.push(
      `${takes} ${takes === 1 ? 'take' : 'takes'} and ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} of practice this year` +
        (run > 1 ? `, and you're on a ${run}-day run.` : '.'),
    )
  }

  const weekMedian = median(week.map(pitch).filter((v): v is number => v !== null))
  const thenMedian = median(monthAgo.map(pitch).filter((v): v is number => v !== null))
  if (weekMedian !== null) {
    let s = `This week your takes centred on ${Math.round(weekMedian)} Hz`
    if (thenMedian !== null) {
      const d = Math.round(weekMedian - thenMedian)
      s += d === 0 ? ', the same as a month ago' : `, ${Math.abs(d)} Hz ${d > 0 ? 'higher' : 'lower'} than a month ago`
    }
    const home = week.map((p) => p.pct_in_band).filter((v): v is number => v !== null)
    if (home.length) {
      s += `, with ${Math.round(home.reduce((a, b) => a + b, 0) / home.length)}% of voiced time at home`
    }
    out.push(s + '.')
  }
  return out
}

export function HistoryPage() {
  const [scriptFilter, setScriptFilter] = useState<number | undefined>(undefined)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [metric, setMetric] = useState<ProgressMetric>('pitch')

  const { data: scripts } = useScripts()
  const { data: settings } = useSettings()
  const { data: days, isLoading } = useHeatmap({ script_id: scriptFilter })
  const { data: trends } = useTrends({ script_id: scriptFilter })
  const { data: takes } = useRecordings(
    selectedDay ? { script_id: scriptFilter, day: selectedDay } : { limit: 12, script_id: scriptFilter },
  )

  // Exercises sit apart: a siren's median isn't speaking pitch.
  const passageTrends = useMemo(() => (trends ?? []).filter((p) => p.kind === 'passage'), [trends])
  const exerciseTrends = useMemo(() => (trends ?? []).filter((p) => p.kind !== 'passage'), [trends])
  const lines = useMemo(() => summarize(passageTrends, days ?? []), [passageTrends, days])
  const empty = !isLoading && (days ?? []).every((d) => d.count === 0)
  const bandMin = settings?.target_min_hz ?? 165
  const bandMax = settings?.target_max_hz ?? 220

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">Your progress</h1>
        {lines.map((l) => (
          <p key={l} className="max-w-[65ch] text-base leading-relaxed text-ink-soft">
            {l}
          </p>
        ))}
      </header>

      {empty ? (
        <Card className="p-8 text-center">
          <p className="font-display text-xl font-semibold text-ink">Nothing here yet</p>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-ink-soft">
            Each take you record lands here: your pitch over the weeks, a calendar of practice days,
            and every take to listen back to.
          </p>
          <Link to="/" className="mt-4 inline-block font-semibold text-rose-deep hover:underline">
            Record your first take
          </Link>
        </Card>
      ) : (
        <>
          {scripts && scripts.length > 1 && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by passage">
              <FilterPill active={scriptFilter === undefined} onClick={() => setScriptFilter(undefined)}>
                All passages
              </FilterPill>
              {scripts.map((s) => (
                <FilterPill
                  key={s.id}
                  active={scriptFilter === s.id}
                  onClick={() => setScriptFilter(scriptFilter === s.id ? undefined : s.id)}
                >
                  {s.title}
                </FilterPill>
              ))}
            </div>
          )}

          {passageTrends.length > 0 && (
            <Card className="p-5 sm:p-6">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-display text-lg font-semibold text-ink">
                  {metric === 'pitch' ? 'Median pitch per take' : 'Time at home per take'}
                </h2>
                <div className="flex rounded-full bg-cream p-1" role="tablist" aria-label="Chart">
                  {(
                    [
                      ['pitch', 'Pitch'],
                      ['home', 'Time at home'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      role="tab"
                      aria-selected={metric === key}
                      onClick={() => setMetric(key)}
                      className={clsx(
                        'rounded-full px-3 py-1 text-sm font-semibold transition-colors',
                        metric === key ? 'bg-card text-ink shadow-lifted' : 'text-ink-soft hover:text-ink',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <ProgressChart points={passageTrends} metric={metric} bandMin={bandMin} bandMax={bandMax} />
              <p className="mt-2 text-xs leading-relaxed text-ink-soft">
                Dots are takes; the line is the median of your last seven practice days.
                {metric === 'pitch' && ' The green stripe is your home band.'} Click a dot to open the take.
              </p>
            </Card>
          )}

          {exerciseTrends.length > 0 && <ExerciseProgress points={exerciseTrends} bandMin={bandMin} bandMax={bandMax} />}

          <Card className="p-5 sm:p-6">
            <h2 className="mb-3 font-display text-lg font-semibold text-ink">Practice days</h2>
            {isLoading ? (
              <Spinner label="Painting your year…" />
            ) : (
              <Heatmap
                days={days ?? []}
                selectedDay={selectedDay}
                onSelectDay={(day) => setSelectedDay(selectedDay === day ? null : day)}
              />
            )}
          </Card>

          <Card className="p-4 sm:p-5">
            <h2 className="mb-1 px-3 font-display text-lg font-semibold text-ink">
              {selectedDay ? `Takes on ${formatDay(selectedDay)}` : 'Recent takes'}
            </h2>
            {takes && takes.length > 0 ? (
              <TakeList takes={takes} showScript />
            ) : (
              <p className="px-3 pb-2 text-sm text-ink-soft">
                {selectedDay ? 'A rest day. Those count too.' : 'No takes yet.'}
              </p>
            )}
          </Card>
        </>
      )}
    </div>
  )
}

const EXERCISE_CHARTS: Array<{ kind: ExerciseKind; metric: ProgressMetric; title: string; note: string }> = [
  { kind: 'siren', metric: 'range', title: 'Siren range', note: 'Semitones from the low to the high end of each siren.' },
  { kind: 'sustain', metric: 'hold', title: 'Steady holds', note: 'The longest steady note in each take, in seconds.' },
  { kind: 'hold', metric: 'streak', title: 'Time at home', note: 'The longest unbroken stretch inside your home band, in seconds.' },
]

/** Each exercise's own measure over time, one at a time. */
function ExerciseProgress({ points, bandMin, bandMax }: { points: TrendPoint[]; bandMin: number; bandMax: number }) {
  const available = EXERCISE_CHARTS.filter((c) => points.some((p) => p.kind === c.kind))
  const [pick, setPick] = useState<ExerciseKind>(available[0]?.kind ?? 'siren')
  const chart = available.find((c) => c.kind === pick) ?? available[0]
  if (!chart) return null
  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-semibold text-ink">Exercises</h2>
        <div className="flex rounded-full bg-cream p-1" role="tablist" aria-label="Exercise">
          {available.map((c) => (
            <button
              key={c.kind}
              role="tab"
              aria-selected={chart.kind === c.kind}
              onClick={() => setPick(c.kind)}
              className={clsx(
                'rounded-full px-3 py-1 text-sm font-semibold transition-colors',
                chart.kind === c.kind ? 'bg-card text-ink shadow-lifted' : 'text-ink-soft hover:text-ink',
              )}
            >
              <span aria-hidden className="mr-1">
                {EXERCISES[c.kind].emoji}
              </span>
              {c.title}
            </button>
          ))}
        </div>
      </div>
      <ProgressChart
        points={points.filter((p) => p.kind === chart.kind)}
        metric={chart.metric}
        bandMin={bandMin}
        bandMax={bandMax}
      />
      <p className="mt-2 text-xs leading-relaxed text-ink-soft">
        {chart.note} The line is the median of your last seven days of it.
      </p>
    </Card>
  )
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors',
        active
          ? 'bg-rose text-white'
          : 'border border-rose-soft bg-card text-ink-soft hover:border-rose hover:text-ink',
      )}
    >
      {children}
    </button>
  )
}
