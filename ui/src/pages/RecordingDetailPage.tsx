import { useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import {
  useAnnotations,
  useDeleteRecording,
  useRecording,
  useUpdateRecording,
} from '@/hooks/queries'
import { formatBytes, formatDay, formatDuration, formatTime } from '@/lib/format'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { PlaybackWaveform, type PlaybackHandle } from '@/components/PlaybackWaveform'
import { MomentChips } from '@/components/MomentChips'
import { AnalysisCard } from '@/components/AnalysisCard'
import { RatingHearts } from '@/components/RatingHearts'
import { NotesEditor } from '@/components/NotesEditor'

export function RecordingDetailPage() {
  const params = useParams()
  const id = Number(params.id)
  const navigate = useNavigate()
  const { data: take, isLoading } = useRecording(id)
  const { data: annotations } = useAnnotations(id)
  const updateRecording = useUpdateRecording()
  const deleteRecording = useDeleteRecording()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const playbackRef = useRef<PlaybackHandle | null>(null)
  const seekTo = (seconds: number) => playbackRef.current?.seekTo(seconds)

  if (isLoading) return <Spinner label="Fetching your take…" />
  if (!take) {
    return <Card className="p-8 text-center text-ink-soft">This take seems to have wandered off.</Card>
  }

  const removeTake = async () => {
    await deleteRecording.mutateAsync(id)
    navigate(-1)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between animate-fade-up">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold text-ink-soft transition-colors hover:bg-rose-whisper hover:text-ink"
        >
          <ArrowLeft size={15} /> Back
        </button>
        {confirmingDelete ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-ink-soft">Delete this take and its audio?</span>
            <Button variant="danger" size="sm" onClick={removeTake} disabled={deleteRecording.isPending}>
              Yes, delete
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>
              Keep it
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(true)} className="text-ink-faint">
            <Trash2 size={14} /> Delete
          </Button>
        )}
      </div>

      <div className="animate-fade-up" style={{ animationDelay: '40ms' }}>
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
          {take.script_title ?? 'A take'}
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          {formatDay(take.local_day)} at {formatTime(take.recorded_at)} ·{' '}
          {formatDuration(take.duration_ms)} · {formatBytes(take.size_bytes)}
          {take.analysis?.pitch.median_hz != null ? (
            <>
              {' '}
              · median {Math.round(take.analysis.pitch.median_hz)} Hz
              {take.analysis.pitch.pct_in_band !== null && (
                <> · {Math.round(take.analysis.pitch.pct_in_band)}% in band</>
              )}
            </>
          ) : (
            take.pitch_stats && (
              <>
                {' '}
                · median {Math.round(take.pitch_stats.median_hz)} Hz ·{' '}
                {Math.round(take.pitch_stats.pct_in_band * 100)}% in band
              </>
            )
          )}
        </p>
        <Link
          to={`/practice/${take.script_id}`}
          className="mt-1 inline-block text-sm font-semibold text-rose-deep hover:underline"
        >
          Practice this passage again →
        </Link>
      </div>

      <Card className="space-y-4 p-6 animate-fade-up" style={{ animationDelay: '80ms' }}>
        <PlaybackWaveform
          audioUrl={api.audioUrl(id)}
          annotations={annotations}
          handleRef={playbackRef}
        />
        <MomentChips annotations={annotations ?? []} onSeek={seekTo} />
      </Card>

      <div className="animate-fade-up" style={{ animationDelay: '120ms' }}>
        <AnalysisCard take={take} onSeek={seekTo} />
      </div>

      <Card className="space-y-4 p-6 animate-fade-up" style={{ animationDelay: '160ms' }}>
        <div className="flex items-center gap-4">
          <span className="text-sm font-semibold text-ink-soft">How did it feel?</span>
          <RatingHearts
            value={take.rating}
            onChange={(rating) => updateRecording.mutate({ id, patch: { rating } })}
          />
        </div>
        <NotesEditor
          value={take.notes}
          onSave={(notes) => updateRecording.mutate({ id, patch: { notes } })}
        />
      </Card>
    </div>
  )
}
