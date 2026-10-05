import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BookOpenText, Mic, Square, Trash2, X } from 'lucide-react'
import { clsx } from 'clsx'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { LiveWaveform, type LiveWaveformHandle } from '@/components/LiveWaveform'
import { PitchMeter, type PitchMeterHandle } from '@/components/PitchMeter'
import { RatingHearts } from '@/components/RatingHearts'
import { startRecording, type RecorderSession } from '@/lib/audio/recorder'
import { PitchTracker } from '@/lib/audio/pitchTracker'
import {
  alignWords,
  followAvailability,
  installFollowAlong,
  passageTokens,
  startFollowAlong,
  type FollowAvailability,
  type FollowSession,
} from '@/lib/audio/followAlong'
import { localDay, type Recording } from '@/lib/api'
import {
  useDeleteRecording,
  useSettings,
  useUpdateRecording,
  useUploadRecording,
} from '@/hooks/queries'
import { formatDuration } from '@/lib/format'

type Phase = 'idle' | 'recording' | 'saving' | 'saved'

const ESTIMATE_INTERVAL_MS = 60
const FOLLOW_PREF_KEY = 'voicetrain.followAlong'

export function Recorder({
  scriptId,
  passage,
  onFollowProgress,
  onRecordingChange,
}: {
  scriptId: number
  passage: string
  /** Words of the passage read so far; -1 when follow-along is inactive. */
  onFollowProgress?: (count: number) => void
  onRecordingChange?: (recording: boolean) => void
}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [currentHz, setCurrentHz] = useState<number | null>(null)
  const [lastTake, setLastTake] = useState<Recording | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState('')

  const [micQuiet, setMicQuiet] = useState(false)
  const [followState, setFollowState] = useState<FollowAvailability>('unsupported')
  const [followEnabled, setFollowEnabled] = useState(
    () => localStorage.getItem(FOLLOW_PREF_KEY) !== '0',
  )

  const sessionRef = useRef<RecorderSession | null>(null)
  const trackerRef = useRef<PitchTracker | null>(null)
  const followRef = useRef<FollowSession | null>(null)
  const waveformRef = useRef<LiveWaveformHandle | null>(null)
  const pitchMeterRef = useRef<PitchMeterHandle | null>(null)
  const startedAtRef = useRef(0)

  const tokens = useMemo(() => passageTokens(passage), [passage])

  const { data: settings } = useSettings()
  const uploadRecording = useUploadRecording()
  const updateRecording = useUpdateRecording()
  const deleteRecording = useDeleteRecording()

  const targetMin = settings?.target_min_hz ?? 165
  const targetMax = settings?.target_max_hz ?? 220

  useEffect(() => {
    followAvailability().then(setFollowState)
  }, [])

  useEffect(() => {
    onRecordingChange?.(phase === 'recording')
  }, [phase, onRecordingChange])

  // Estimation + clock loop while recording.
  useEffect(() => {
    if (phase !== 'recording') return
    let raf = 0
    let lastEstimate = 0
    const tick = (now: number) => {
      setElapsedMs(Date.now() - startedAtRef.current)
      if (now - lastEstimate >= ESTIMATE_INTERVAL_MS && trackerRef.current) {
        lastEstimate = now
        const sample = trackerRef.current.estimate()
        // Raw sample feeds the trace; the readout gets the smoothed,
        // briefly-held value so it doesn't strobe during consonants.
        setCurrentHz(trackerRef.current.displayHz())
        pitchMeterRef.current?.push(sample)
        // After a few seconds, a persistently tiny peak level means
        // the input device itself is too quiet.
        if (Date.now() - startedAtRef.current > 3000) {
          setMicQuiet(trackerRef.current.peakRms < 0.008)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [phase])

  const stopFollow = useCallback(() => {
    followRef.current?.stop()
    followRef.current = null
    onFollowProgress?.(-1)
  }, [onFollowProgress])

  // Stop the mic and recognition if the page unmounts mid-recording.
  useEffect(() => {
    return () => {
      sessionRef.current?.cancel()
      followRef.current?.stop()
    }
  }, [])

  const toggleFollow = async () => {
    if (followState === 'downloadable') {
      setFollowState('downloading')
      const ok = await installFollowAlong()
      setFollowState(ok ? 'available' : 'unavailable')
      if (ok) {
        setFollowEnabled(true)
        localStorage.setItem(FOLLOW_PREF_KEY, '1')
      }
      return
    }
    const next = !followEnabled
    setFollowEnabled(next)
    localStorage.setItem(FOLLOW_PREF_KEY, next ? '1' : '0')
    if (!next && followRef.current) stopFollow()
    if (next && phase === 'recording' && followState === 'available' && !followRef.current) {
      onFollowProgress?.(0)
      followRef.current = startFollowAlong((words) => {
        onFollowProgress?.(alignWords(words, tokens))
      })
    }
  }

  const begin = useCallback(async () => {
    setError(null)
    setLastTake(null)
    setNotes('')
    try {
      const session = await startRecording()
      const tracker = new PitchTracker(session.sampleRate)
      session.onChunk = (chunk) => {
        tracker.feed(chunk)
        waveformRef.current?.feed(chunk)
      }
      sessionRef.current = session
      trackerRef.current = tracker
      startedAtRef.current = Date.now()
      setElapsedMs(0)
      setPhase('recording')

      if (followEnabled && followState === 'available') {
        onFollowProgress?.(0)
        followRef.current = startFollowAlong((words) => {
          onFollowProgress?.(alignWords(words, tokens))
        })
      }
    } catch (err) {
      setError(
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone access was declined — voicetrain needs your voice to work its magic.'
          : `Couldn't start the microphone: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }, [followEnabled, followState, onFollowProgress, tokens])

  /** False start? Toss everything, keep nothing. */
  const scrap = useCallback(() => {
    sessionRef.current?.cancel()
    sessionRef.current = null
    trackerRef.current = null
    stopFollow()
    setCurrentHz(null)
    setMicQuiet(false)
    setPhase('idle')
  }, [stopFollow])

  const finish = useCallback(async () => {
    const session = sessionRef.current
    const tracker = trackerRef.current
    if (!session) return
    sessionRef.current = null
    stopFollow()
    setPhase('saving')
    setCurrentHz(null)
    try {
      const blob = await session.stop()
      const recording = await uploadRecording.mutateAsync({
        file: blob,
        script_id: scriptId,
        recorded_at: startedAtRef.current,
        local_day: localDay(new Date(startedAtRef.current)),
        pitch_stats: tracker?.stats(targetMin, targetMax),
      })
      setLastTake(recording)
      setPhase('saved')
    } catch (err) {
      setError(`Saving the take failed: ${err instanceof Error ? err.message : String(err)}`)
      setPhase('idle')
    }
  }, [scriptId, stopFollow, targetMin, targetMax, uploadRecording])

  const discardLastTake = async () => {
    if (!lastTake) return
    await deleteRecording.mutateAsync(lastTake.id)
    setLastTake(null)
    setPhase('idle')
  }

  const rateLastTake = (rating: number | null) => {
    if (!lastTake) return
    setLastTake({ ...lastTake, rating })
    updateRecording.mutate({ id: lastTake.id, patch: { rating } })
  }

  const saveNotes = () => {
    if (!lastTake || notes === lastTake.notes) return
    setLastTake({ ...lastTake, notes })
    updateRecording.mutate({ id: lastTake.id, patch: { notes } })
  }

  const followToggle = followState !== 'unsupported' && followState !== 'unavailable' && (
    <button
      onClick={toggleFollow}
      disabled={followState === 'downloading'}
      aria-pressed={followEnabled && followState === 'available'}
      title={
        followState === 'downloadable'
          ? 'Download the on-device speech model to highlight the passage as you read'
          : 'Highlight the passage as you read (on-device, nothing leaves your laptop)'
      }
      className={clsx(
        'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-all',
        followEnabled && followState === 'available'
          ? 'bg-lavender-soft text-ink shadow-lifted'
          : 'text-ink-faint border border-rose-soft hover:text-ink-soft',
      )}
    >
      <BookOpenText size={13} />
      {followState === 'downloading'
        ? 'Fetching model…'
        : followState === 'downloadable'
          ? 'Enable follow-along'
          : 'Follow along'}
    </button>
  )

  return (
    <>
      {phase === 'idle' && (
        <Card className="p-5">
          <div className="flex flex-col items-center gap-3 py-2">
            <button
              onClick={begin}
              aria-label="Start recording"
              className="flex h-16 w-16 items-center justify-center rounded-full bg-rose text-white shadow-cozy-lg transition-all hover:bg-rose-deep hover:scale-105 active:scale-95 animate-breathe"
            >
              <Mic size={26} />
            </button>
            <p className="text-sm text-ink-soft">Whenever you're ready 💗</p>
            {followToggle}
            {error && (
              <p className="text-center text-sm leading-relaxed text-rose-deep">{error}</p>
            )}
          </div>
        </Card>
      )}

      {phase === 'recording' && (
        <div className="fixed inset-x-0 bottom-0 z-40 animate-fade-up">
          <div className="mx-auto max-w-5xl px-4 sm:px-6">
            <div className="rounded-t-cozy border border-b-0 border-rose-whisper bg-card/95 p-4 shadow-cozy-lg backdrop-blur-md">
              <div className="mb-3 flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <span className="h-2.5 w-2.5 rounded-full bg-rose animate-gentle-pulse" />
                  {formatDuration(elapsedMs)}
                </span>
                <div className="flex items-center gap-2">
                  {followToggle}
                  <Button onClick={scrap} variant="ghost" size="sm" className="text-ink-faint">
                    <X size={13} /> Scrap it
                  </Button>
                  <Button onClick={finish} variant="primary" size="sm">
                    <Square size={12} className="fill-current" /> Done
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr]">
                <div className="hidden sm:block">
                  <LiveWaveform handleRef={waveformRef} heightClass="h-24" />
                </div>
                <PitchMeter
                  handleRef={pitchMeterRef}
                  currentHz={currentHz}
                  targetMinHz={targetMin}
                  targetMaxHz={targetMax}
                  heightClass="h-24"
                />
              </div>
              {micQuiet && (
                <p className="mt-2 text-center text-xs text-honey">
                  Your mic signal is quite quiet — raising the input volume in System Settings
                  will make pitch tracking much happier 🎚️
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {phase === 'saving' && (
        <Card className="p-5">
          <div className="flex flex-col items-center gap-3 py-4 text-ink-soft">
            <div className="h-7 w-7 animate-spin rounded-full border-[3px] border-rose-soft border-t-rose" />
            <p className="text-sm">Tucking your take away safely…</p>
          </div>
        </Card>
      )}

      {phase === 'saved' && lastTake && (
        <Card className="p-5">
          <div className="space-y-3 animate-fade-up">
            <div className="text-center">
              <h3 className="font-display text-lg font-semibold text-ink">
                Take saved — nice work 🌸
              </h3>
              <p className="mt-1 text-sm text-ink-soft">
                {formatDuration(lastTake.duration_ms)}
                {lastTake.pitch_stats && (
                  <>
                    {' '}
                    · median {Math.round(lastTake.pitch_stats.median_hz)} Hz ·{' '}
                    {Math.round(lastTake.pitch_stats.pct_in_band * 100)}% in band
                  </>
                )}
              </p>
            </div>

            <div className="flex flex-col items-center gap-2.5">
              <RatingHearts value={lastTake.rating} onChange={rateLastTake} size={24} />
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={saveNotes}
                placeholder="Any thoughts about this one? (optional)"
                rows={2}
                className="w-full rounded-2xl border border-rose-soft bg-white px-3.5 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-hidden focus:ring-2 focus:ring-rose/40"
              />
            </div>

            <div className="flex flex-col items-stretch gap-2">
              <Button onClick={begin} variant="primary" size="sm">
                <Mic size={14} /> Another take
              </Button>
              <Link to={`/recordings/${lastTake.id}`} className="flex">
                <Button variant="soft" size="sm" className="flex-1">
                  Listen back
                </Button>
              </Link>
              <Button
                onClick={discardLastTake}
                variant="ghost"
                size="sm"
                className="text-ink-faint"
                disabled={deleteRecording.isPending}
              >
                <Trash2 size={13} /> Discard this take
              </Button>
            </div>
          </div>
        </Card>
      )}
    </>
  )
}
