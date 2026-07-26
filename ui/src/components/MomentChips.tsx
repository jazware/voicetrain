import { kindMeta } from '@/lib/analysisMeta'
import type { Annotation } from '@/lib/api'

/**
 * Clickable "moments worth a listen" from the analysis — each chip
 * jumps playback to its span on the waveform above. Doubles as the
 * legend for the colored waveform regions.
 */
export function MomentChips({
  annotations,
  onSeek,
}: {
  annotations: Annotation[]
  onSeek: (seconds: number) => void
}) {
  const moments = annotations.filter((a) => a.source === 'auto')
  if (moments.length === 0) return null

  return (
    <div>
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-faint">
        Moments worth a listen
      </p>
      <div className="flex flex-wrap gap-2">
        {moments.map((a) => {
          const meta = kindMeta(a.kind)
          return (
            <button
              key={a.id}
              onClick={() => onSeek(a.start_ms / 1000)}
              title={`${meta.label} — ${meta.describe(a.payload as Record<string, number | null>)}`}
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold text-ink-soft transition-all hover:shadow-lifted hover:text-ink"
              style={{ backgroundColor: meta.fill }}
            >
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: meta.color }}
              />
              {meta.label}
              <span className="tabular-nums text-ink-faint">{clock(a.start_ms)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
