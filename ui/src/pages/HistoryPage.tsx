import { useMemo, useState } from 'react'
import { clsx } from 'clsx'
import { Flame, Mic2, Timer } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Spinner } from '@/components/ui/Spinner'
import { Heatmap } from '@/components/Heatmap'
import { TakeList } from '@/components/TakeList'
import { useHeatmap, useRecordings, useScripts } from '@/hooks/queries'
import { localDay, type HeatmapDay } from '@/lib/api'
import { formatDay } from '@/lib/format'

/** Consecutive practiced days ending today or yesterday. */
function streak(days: HeatmapDay[]): number {
  const practiced = new Set(days.filter((d) => d.count > 0).map((d) => d.day))
  const cursor = new Date()
  if (!practiced.has(localDay(cursor))) cursor.setDate(cursor.getDate() - 1)
  let n = 0
  while (practiced.has(localDay(cursor))) {
    n++
    cursor.setDate(cursor.getDate() - 1)
  }
  return n
}

function Stat({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-card px-4 py-3 shadow-lifted border border-rose-whisper">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-peach-soft text-rose-deep">
        {icon}
      </span>
      <div>
        <div className="font-display text-xl font-bold leading-none text-ink">{value}</div>
        <div className="mt-0.5 text-xs text-ink-soft">{label}</div>
      </div>
    </div>
  )
}

export function HistoryPage() {
  const [scriptFilter, setScriptFilter] = useState<number | undefined>(undefined)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  const { data: scripts } = useScripts()
  const { data: days, isLoading } = useHeatmap({ script_id: scriptFilter })
  const { data: dayTakes } = useRecordings(
    selectedDay ? { script_id: scriptFilter, day: selectedDay } : { limit: 12, script_id: scriptFilter },
  )

  const totals = useMemo(() => {
    if (!days) return { takes: 0, minutes: 0, streak: 0 }
    return {
      takes: days.reduce((sum, d) => sum + d.count, 0),
      minutes: Math.round(days.reduce((sum, d) => sum + d.total_duration_ms, 0) / 60000),
      streak: streak(days),
    }
  }, [days])

  return (
    <div className="space-y-6">
      <div className="animate-fade-up">
        <h1 className="font-display text-3xl font-bold tracking-tight text-ink">Your practice story</h1>
        <p className="mt-1 text-ink-soft">Every square is a day you showed up for yourself.</p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 animate-fade-up" style={{ animationDelay: '40ms' }}>
        <Stat icon={<Mic2 size={16} />} value={String(totals.takes)} label="takes this year" />
        <Stat icon={<Timer size={16} />} value={`${totals.minutes} min`} label="of practice" />
        <Stat
          icon={<Flame size={16} />}
          value={String(totals.streak)}
          label={totals.streak === 1 ? 'day streak' : 'day streak'}
        />
      </div>

      {scripts && scripts.length > 0 && (
        <div className="flex flex-wrap gap-2 animate-fade-up" style={{ animationDelay: '80ms' }}>
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

      <Card className="p-6 animate-fade-up" style={{ animationDelay: '120ms' }}>
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

      <Card className="p-5 animate-fade-up" style={{ animationDelay: '160ms' }}>
        <h2 className="mb-2 px-3 font-display text-sm font-semibold uppercase tracking-wider text-ink-soft">
          {selectedDay ? formatDay(selectedDay) : 'Recent takes'}
        </h2>
        {dayTakes && dayTakes.length > 0 ? (
          <TakeList takes={dayTakes} showScript />
        ) : (
          <p className="px-3 pb-2 text-sm text-ink-soft">
            {selectedDay
              ? 'A rest day — those matter too 🌙'
              : 'No takes yet. Your first recording will land here!'}
          </p>
        )}
      </Card>
    </div>
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
        'rounded-full px-3.5 py-1.5 text-sm font-semibold transition-all',
        active
          ? 'bg-rose text-white shadow-lifted'
          : 'bg-card text-ink-soft border border-rose-soft hover:text-ink hover:border-rose',
      )}
    >
      {children}
    </button>
  )
}
