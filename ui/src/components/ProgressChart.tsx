import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { localDay, type TrendPoint } from '@/lib/api'
import { BAND_COLORS, bandState } from '@/lib/band'
import { formatDay } from '@/lib/format'
import { median } from '@/lib/practice'

export type ProgressMetric = 'pitch' | 'home' | 'range' | 'hold' | 'streak'

const H = 220
const PAD = { top: 14, right: 12, bottom: 26, left: 40 }
const DAY_MS = 86_400_000

interface Point {
  id: number
  t: number
  day: string
  v: number
}

/** A take's value for the metric: analyzed numbers first, live ones as a stand-in. */
function valueOf(p: TrendPoint, metric: ProgressMetric): number | null {
  switch (metric) {
    case 'pitch':
      return p.median_hz ?? p.live_median_hz
    case 'home':
      return p.pct_in_band
    case 'range':
      return p.range_st
    case 'hold':
      return p.hold_s
    case 'streak':
      return p.streak_s
  }
}

const LINEAR: Partial<Record<ProgressMetric, { unit: string; label: string }>> = {
  range: { unit: ' st', label: 'Range of each siren, in semitones' },
  hold: { unit: ' s', label: 'Longest steady hold in each take' },
  streak: { unit: ' s', label: 'Longest stretch at home in each take' },
}

/**
 * Every take as a dot, with a line through the median of each run of
 * seven practice days, so one off day doesn't read as a trend. Pitch
 * uses a log axis with the home band; "time at home" is the share of
 * voiced time inside the band.
 */
export function ProgressChart({
  points: raw,
  metric,
  bandMin,
  bandMax,
}: {
  points: TrendPoint[]
  metric: ProgressMetric
  bandMin: number
  bandMax: number
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<Point | null>(null)
  const navigate = useNavigate()

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => setWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const points = useMemo(
    () =>
      raw
        .map((p) => ({ id: p.id, t: p.recorded_at, day: p.local_day, v: valueOf(p, metric) }))
        .filter((p): p is Point => p.v !== null),
    [raw, metric],
  )

  // Rolling median over the last seven practice days (not calendar days).
  const trend = useMemo(() => {
    const byDay = new Map<string, number[]>()
    for (const p of points) byDay.set(p.day, [...(byDay.get(p.day) ?? []), p.v])
    const days = [...byDay.keys()].sort()
    return days.map((day, i) => {
      const window = days.slice(Math.max(0, i - 6), i + 1).flatMap((d) => byDay.get(d)!)
      const [y, m, d] = day.split('-').map(Number)
      return { t: new Date(y, m - 1, d, 12).getTime(), v: median(window)! }
    })
  }, [points])

  // The same data as text, a row per week, for screen readers and for
  // reading exact numbers.
  const weeks = useMemo(() => {
    const byWeek = new Map<string, number[]>()
    for (const p of points) {
      const d = new Date(p.t)
      d.setHours(0, 0, 0, 0)
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7)) // Monday
      const key = localDay(d)
      byWeek.set(key, [...(byWeek.get(key) ?? []), p.v])
    }
    return [...byWeek.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([week, vs]) => ({ week, takes: vs.length, median: median(vs)! }))
  }, [points])

  if (points.length === 0) return null

  const t0 = Math.min(...points.map((p) => p.t)) - DAY_MS / 2
  const t1 = Math.max(...points.map((p) => p.t), Date.now()) + DAY_MS / 2
  const innerW = Math.max(0, width - PAD.left - PAD.right)
  const innerH = H - PAD.top - PAD.bottom
  const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * innerW

  let y: (v: number) => number
  let ticks: number[]
  let fmt: (v: number) => string
  if (metric === 'pitch') {
    const vs = points.map((p) => p.v)
    const lo = Math.min(...vs, bandMin) * 0.92
    const hi = Math.max(...vs, bandMax) * 1.06
    y = (v) => PAD.top + innerH - ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * innerH
    ticks = [80, 100, 120, 140, 160, 180, 200, 220, 250, 300, 350].filter((v) => v > lo && v < hi)
    fmt = (v) => `${Math.round(v)} Hz`
  } else if (metric === 'home') {
    y = (v) => PAD.top + innerH - (v / 100) * innerH
    ticks = [0, 25, 50, 75, 100]
    fmt = (v) => `${Math.round(v)}%`
  } else {
    const top = Math.max(...points.map((p) => p.v)) * 1.15 || 1
    const step = top > 40 ? 10 : top > 16 ? 5 : top > 6 ? 2 : 1
    y = (v) => PAD.top + innerH - (v / top) * innerH
    ticks = Array.from({ length: Math.floor(top / step) + 1 }, (_, i) => i * step)
    const unit = LINEAR[metric]!.unit
    fmt = (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)}${unit}`
  }

  const months: Array<{ t: number; label: string }> = []
  const cursor = new Date(t0)
  cursor.setDate(1)
  cursor.setHours(0, 0, 0, 0)
  while (cursor.getTime() < t1) {
    cursor.setMonth(cursor.getMonth() + 1)
    if (cursor.getTime() > t0 && cursor.getTime() < t1) {
      months.push({ t: cursor.getTime(), label: cursor.toLocaleDateString(undefined, { month: 'short' }) })
    }
  }

  const trendPath = trend.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('')
  const dotColor = (v: number) =>
    metric === 'pitch' ? BAND_COLORS[bandState(v, bandMin, bandMax)] : 'rgba(201, 79, 98, 0.85)'

  return (
    <div ref={wrapRef} className="relative">
      {width > 0 && (
        <svg width={width} height={H} className="block" role="img" aria-label={metric === 'pitch' ? 'Median pitch of each take over time' : metric === 'home' ? 'Share of each take spent in your home band' : LINEAR[metric]!.label}>
          {metric === 'pitch' && (
            <rect x={PAD.left} width={innerW} y={y(bandMax)} height={y(bandMin) - y(bandMax)} fill="rgba(127,169,127,0.16)" />
          )}
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={PAD.left + innerW} y1={y(v)} y2={y(v)} stroke="rgba(82,64,79,0.08)" />
              <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" fontSize={11} fill="#76606f" className="font-body tabular-nums">
                {metric === 'pitch' ? v : metric === 'home' ? `${v}%` : `${v}${LINEAR[metric]!.unit}`}
              </text>
            </g>
          ))}
          {months.map((m) => (
            <g key={m.t}>
              <line x1={x(m.t)} x2={x(m.t)} y1={PAD.top} y2={PAD.top + innerH} stroke="rgba(82,64,79,0.06)" />
              <text x={x(m.t) + 4} y={H - 8} fontSize={11} fill="#76606f" className="font-body">
                {m.label}
              </text>
            </g>
          ))}
          {points.map((p) => (
            <circle
              key={p.id}
              cx={x(p.t)}
              cy={y(p.v)}
              r={hover?.id === p.id ? 5 : 3.2}
              fill={dotColor(p.v)}
              fillOpacity={hover?.id === p.id ? 1 : 0.55}
              className="cursor-pointer"
              onMouseEnter={() => setHover(p)}
              onMouseLeave={() => setHover(null)}
              onClick={() => navigate(`/recordings/${p.id}`)}
            />
          ))}
          <path d={trendPath} fill="none" stroke="#C94F62" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      )}
      <details className="mt-3 text-sm text-ink-soft">
        <summary className="cursor-pointer select-none font-semibold text-ink-soft hover:text-ink">
          The numbers, week by week
        </summary>
        <table className="mt-2 w-full max-w-md text-left tabular-nums">
          <thead>
            <tr className="text-xs text-ink-soft">
              <th className="py-1 font-semibold">Week of</th>
              <th className="py-1 font-semibold">Takes</th>
              <th className="py-1 font-semibold">
                {metric === 'pitch' ? 'Median pitch' : metric === 'home' ? 'Median time at home' : 'Median'}
              </th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.week} className="border-t border-rose-whisper text-ink">
                <td className="py-1">{formatDay(w.week)}</td>
                <td className="py-1">{w.takes}</td>
                <td className="py-1">{fmt(w.median)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg bg-ink px-2 py-1 text-[11px] font-semibold whitespace-nowrap text-cream shadow-lifted"
          style={{ left: Math.min(Math.max(x(hover.t), 60), width - 60), top: y(hover.v) - 8 }}
        >
          {formatDay(hover.day)}: {fmt(hover.v)}
        </div>
      )}
    </div>
  )
}
