import { localDay, type HeatmapDay } from './api.ts'

/** Consecutive practiced days ending today or yesterday. */
export function streak(days: HeatmapDay[], today = new Date()): number {
  const practiced = new Set(days.filter((d) => d.count > 0).map((d) => d.day))
  const cursor = new Date(today)
  if (!practiced.has(localDay(cursor))) cursor.setDate(cursor.getDate() - 1)
  let n = 0
  while (practiced.has(localDay(cursor))) {
    n++
    cursor.setDate(cursor.getDate() - 1)
  }
  return n
}

/** The last seven days, oldest first, with practice minutes. */
export function lastWeek(days: HeatmapDay[], today = new Date()) {
  const byDay = new Map(days.map((d) => [d.day, d]))
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today)
    d.setDate(d.getDate() - (6 - i))
    const key = localDay(d)
    const entry = byDay.get(key)
    return {
      day: key,
      label: d.toLocaleDateString(undefined, { weekday: 'narrow' }),
      name: d.toLocaleDateString(undefined, { weekday: 'long' }),
      minutes: entry ? entry.total_duration_ms / 60000 : 0,
      takes: entry?.count ?? 0,
      isToday: i === 6,
    }
  })
}

/** Median of numbers, or null for none. */
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
