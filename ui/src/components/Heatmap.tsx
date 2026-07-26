import { useMemo } from 'react'
import { clsx } from 'clsx'
import type { HeatmapDay } from '@/lib/api'
import { localDay } from '@/lib/api'
import { formatDay } from '@/lib/format'

/**
 * GitHub-style practice calendar. Sequential rose ramp validated
 * against the cream surface (2:1+ light-end contrast, monotone
 * lightness): #EDA0AE → #E2687A → #C94F62 → #9E3849.
 */
const EMPTY_COLOR = '#F3EAE2'
const RAMP = ['#EDA0AE', '#E2687A', '#C94F62', '#9E3849']

// Minutes of practice → ramp bucket. Fixed thresholds so the meaning
// of a shade never shifts as history grows.
const BUCKETS_MIN = [2, 5, 12]

const CELL = 12
const GAP = 3
const STEP = CELL + GAP

function colorFor(durationMs: number): string {
  if (durationMs <= 0) return EMPTY_COLOR
  const minutes = durationMs / 60000
  let bucket = 0
  for (const threshold of BUCKETS_MIN) {
    if (minutes >= threshold) bucket++
  }
  return RAMP[bucket]
}

export function Heatmap({
  days,
  weeks = 52,
  selectedDay,
  onSelectDay,
}: {
  days: HeatmapDay[]
  weeks?: number
  selectedDay?: string | null
  onSelectDay?: (day: string) => void
}) {
  const byDay = useMemo(() => new Map(days.map((d) => [d.day, d])), [days])

  const grid = useMemo(() => {
    const today = new Date()
    // Start on the Sunday that begins the leftmost week.
    const start = new Date(today)
    start.setDate(start.getDate() - start.getDay() - (weeks - 1) * 7)

    const cells: Array<{ day: string; col: number; row: number; date: Date }> = []
    const monthLabels: Array<{ col: number; label: string }> = []
    let lastMonth = -1

    const cursor = new Date(start)
    let col = 0
    while (cursor <= today) {
      const row = cursor.getDay()
      const day = localDay(cursor)
      cells.push({ day, col, row, date: new Date(cursor) })
      if (row === 0 && cursor.getMonth() !== lastMonth) {
        // Label a month at the first Sunday inside it, skipping a
        // cramped label right at the left edge.
        if (cursor.getDate() <= 14 || col === 0) {
          monthLabels.push({
            col,
            label: cursor.toLocaleDateString(undefined, { month: 'short' }),
          })
          lastMonth = cursor.getMonth()
        }
      }
      cursor.setDate(cursor.getDate() + 1)
      if (cursor.getDay() === 0) col++
    }
    return { cells, monthLabels, cols: col + 1 }
  }, [weeks])

  const width = grid.cols * STEP + 28
  const height = 7 * STEP + 18

  return (
    <div className="overflow-x-auto">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label="Practice calendar"
        className="block"
      >
        {grid.monthLabels.map(({ col, label }) => (
          <text
            key={`${label}-${col}`}
            x={28 + col * STEP}
            y={10}
            className="fill-ink-faint"
            fontSize={9}
            fontFamily='"Nunito Variable", sans-serif'
          >
            {label}
          </text>
        ))}
        {(['Mon', 'Wed', 'Fri'] as const).map((label, i) => (
          <text
            key={label}
            x={0}
            y={18 + (1 + i * 2) * STEP + CELL - 3}
            className="fill-ink-faint"
            fontSize={9}
            fontFamily='"Nunito Variable", sans-serif'
          >
            {label}
          </text>
        ))}
        {grid.cells.map(({ day, col, row }) => {
          const data = byDay.get(day)
          const duration = data?.total_duration_ms ?? 0
          const selected = selectedDay === day
          const title =
            duration > 0
              ? `${formatDay(day)} — ${data!.count} ${data!.count === 1 ? 'take' : 'takes'}, ${Math.max(1, Math.round(duration / 60000))} min`
              : `${formatDay(day)} — rest day`
          return (
            <rect
              key={day}
              x={28 + col * STEP}
              y={18 + row * STEP}
              width={CELL}
              height={CELL}
              rx={3.5}
              fill={colorFor(duration)}
              stroke={selected ? '#52404F' : 'none'}
              strokeWidth={selected ? 1.5 : 0}
              className={clsx(onSelectDay && 'cursor-pointer')}
              onClick={onSelectDay ? () => onSelectDay(day) : undefined}
            >
              <title>{title}</title>
            </rect>
          )
        })}
      </svg>
      <div className="mt-2 flex items-center justify-end gap-1.5 pr-1 text-xs text-ink-faint">
        rest
        <span className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: EMPTY_COLOR }} />
        {RAMP.map((c) => (
          <span key={c} className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: c }} />
        ))}
        glow
      </div>
    </div>
  )
}
