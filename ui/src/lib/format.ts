/** "1:23" for 83000ms. */
export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${String(sec).padStart(2, '0')}`
}

/** "3.2 MB" for byte counts. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** "Jul 12" or "Jul 12, 2025" if not this year, from YYYY-MM-DD. */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** "2:41 PM" from unix millis. */
export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** A warm little greeting for the home page. */
export function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 5) return 'Up late, songbird?'
  if (hour < 12) return 'Good morning, sunshine'
  if (hour < 17) return 'Good afternoon, lovely'
  return 'Good evening, songbird'
}
