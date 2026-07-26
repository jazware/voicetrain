import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Heart, Play, Trash2 } from 'lucide-react'
import type { Recording } from '@/lib/api'
import { useDeleteRecording } from '@/hooks/queries'
import { formatDuration, formatTime } from '@/lib/format'

/**
 * Compact list of takes: time, duration, pitch summary, rating, and a
 * quick delete for pruning false starts.
 */
export function TakeList({ takes, showScript = false }: { takes: Recording[]; showScript?: boolean }) {
  const deleteRecording = useDeleteRecording()
  const [confirmingId, setConfirmingId] = useState<number | null>(null)

  if (takes.length === 0) return null
  return (
    <ul className="divide-y divide-rose-whisper">
      {takes.map((take) => (
        <li key={take.id} className="group flex items-center">
          <Link
            to={`/recordings/${take.id}`}
            className="flex min-w-0 flex-1 items-center gap-4 rounded-2xl px-3 py-3 transition-colors hover:bg-rose-whisper"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-rose-soft text-rose-deep">
              <Play size={14} className="ml-0.5 fill-current" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-semibold text-ink">{formatTime(take.recorded_at)}</span>
                <span className="text-xs text-ink-faint">{formatDuration(take.duration_ms)}</span>
                {take.analysis?.pitch.median_hz != null ? (
                  <span className="hidden text-xs text-ink-faint sm:inline">
                    · {Math.round(take.analysis.pitch.median_hz)} Hz median
                    {take.analysis.pitch.pct_in_band !== null && (
                      <> · {Math.round(take.analysis.pitch.pct_in_band)}% in band</>
                    )}
                  </span>
                ) : (
                  take.pitch_stats && (
                    <span className="hidden text-xs text-ink-faint sm:inline">
                      · {Math.round(take.pitch_stats.median_hz)} Hz median
                    </span>
                  )
                )}
              </div>
              {showScript && take.script_title && (
                <div className="truncate text-xs text-ink-soft">{take.script_title}</div>
              )}
              {take.notes && <div className="truncate text-xs italic text-ink-soft">{take.notes}</div>}
            </div>
            {take.rating !== null && (
              <span className="flex shrink-0 items-center gap-0.5" aria-label={`${take.rating} hearts`}>
                {Array.from({ length: take.rating }, (_, i) => (
                  <Heart key={i} size={12} className="fill-rose text-rose" />
                ))}
              </span>
            )}
          </Link>

          <div className="flex shrink-0 items-center pl-1 pr-2">
            {confirmingId === take.id ? (
              <span className="flex items-center gap-1.5 text-xs">
                <button
                  onClick={() => deleteRecording.mutate(take.id)}
                  disabled={deleteRecording.isPending}
                  className="rounded-full bg-rose px-2.5 py-1 font-semibold text-white hover:bg-rose-deep"
                >
                  Delete
                </button>
                <button
                  onClick={() => setConfirmingId(null)}
                  className="rounded-full px-2 py-1 font-semibold text-ink-soft hover:bg-rose-whisper"
                >
                  Keep
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmingId(take.id)}
                aria-label={`Delete take from ${formatTime(take.recorded_at)}`}
                className="rounded-full p-2 text-ink-faint opacity-0 transition-all hover:bg-rose-whisper hover:text-rose-deep focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}
