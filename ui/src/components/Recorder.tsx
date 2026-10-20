import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BookOpenText, Download, Mic, RotateCcw, Square, Trash2, X } from 'lucide-react'
import { clsx } from 'clsx'
import { Button } from '@/components/ui/Button'
import { LiveMeter } from '@/components/LiveMeter'
import { RatingHearts } from '@/components/RatingHearts'
import { startRecording, type RecorderSession } from '@/lib/audio/recorder'
import { LiveStore } from '@/lib/audio/liveStore'
import {
  alignWords,
  followAvailability,
  installFollowAlong,
  passageTokens,
  startFollowAlong,
  type FollowAvailability,
  type FollowSession,
} from '@/lib/audio/followAlong'
import { localDay, type PitchStats, type Recording } from '@/lib/api'
import {
  useDeleteRecording,
  useSettings,
  useUpdateRecording,
  useUploadRecording,
} from '@/hooks/queries'
import { formatDuration } from '@/lib/format'

type Phase = 'idle' | 'recording' | 'saving' | 'saved' | 'unsaved'

const FOLLOW_PREF_KEY = 'voicetrain.followAlong'

/** A finished take the server hasn't accepted yet. */
interface PendingTake {
  blob: Blob
  recordedAt: number
  pitchStats?: PitchStats
}

/** mm:ss since `startedAt`, written straight to the DOM once a second. */
function Elapsed({ startedAt }: { startedAt: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let shown = ''
    const id = setInterval(() => {
      const text = formatDuration(Date.now() - startedAt)
      if (text !== shown && ref.current) ref.current.textContent = shown = text
    }, 200)
    return () => clearInterval(id)
  }, [startedAt])
  return (
    <span ref={ref} className="tabular-nums">
      0:00
    </span>
  )
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const update = () => setMatches(mq.matches)
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [query])
  return matches
}

/** Publishes the docked studio's height so the page can keep text clear of it. */
function useDockHeight(ref: React.RefObject<HTMLDivElement | null>, docked: boolean) {
  useEffect(() => {
    const el = ref.current
    const root = document.documentElement
    if (!el || !docked) {
      root.style.removeProperty('--dock-h')
      return
    }
    const ro = new ResizeObserver(() => root.style.setProperty('--dock-h', `${el.offsetHeight}px`))
    ro.observe(el)
    return () => {
      ro.disconnect()
      root.style.removeProperty('--dock-h')
    }
  }, [ref, docked])
}

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName))

export function Recorder({
  scriptId,
  passage,
  onFollowProgress,
  onRecordingChange,
  onLive,
  extraStats,
  savedLine,
  axis,
  followAlong = true,
  idleTitle = 'Record a take',
  idleHint = 'Read the passage at your own pace.',
}: {
  scriptId: number
  passage: string
  /** Words of the passage read so far; -1 when follow-along is inactive. */
  onFollowProgress?: (count: number) => void
  onRecordingChange?: (recording: boolean) => void
  /** The live store while a take records (null otherwise), for an exercise's coach. */
  onLive?: (store: LiveStore | null) => void
  /** More measures to save with the take (an exercise's). */
  extraStats?: () => Partial<PitchStats> | undefined
  /** The saved card's summary line, when the default (median, % at home) doesn't fit. */
  savedLine?: (take: Recording) => string | null
  axis?: { minHz: number; maxHz: number; grid: number[] }
  /** Offer follow-along (passages only: exercises have no text to follow). */
  followAlong?: boolean
  idleTitle?: string
  idleHint?: string
}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [store, setStore] = useState<LiveStore | null>(null)
  const [startedAt, setStartedAt] = useState(0)
  const [lastTake, setLastTake] = useState<Recording | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState('')

  const [micQuiet, setMicQuiet] = useState(false)
  const [followState, setFollowState] = useState<FollowAvailability>('unsupported')
  const [followEnabled, setFollowEnabled] = useState(() => {
    try {
      return localStorage.getItem(FOLLOW_PREF_KEY) !== '0'
    } catch {
      return true
    }
  })

  // The callbacks a take calls back into, read when they're needed: a
  // take begun before the parent's props settle (settings arriving after
  // the script) must still reach the parent's current handlers.
  const onLiveRef = useRef(onLive)
  onLiveRef.current = onLive
  const extraStatsRef = useRef(extraStats)
  extraStatsRef.current = extraStats

  const compact = useMediaQuery('(max-width: 1023px)')
  const dockRef = useRef<HTMLDivElement>(null)
  useDockHeight(dockRef, compact)

  const sessionRef = useRef<RecorderSession | null>(null)
  const followRef = useRef<FollowSession | null>(null)
  const pendingRef = useRef<PendingTake | null>(null)
  const startingRef = useRef(false)

  const tokens = useMemo(() => passageTokens(passage), [passage])

  const { data: settings } = useSettings()
  const uploadRecording = useUploadRecording()
  const updateRecording = useUpdateRecording()
  const deleteRecording = useDeleteRecording()

  const targetMin = settings?.target_min_hz ?? 165
  const targetMax = settings?.target_max_hz ?? 220

  const rememberFollow = (on: boolean) => {
    try {
      localStorage.setItem(FOLLOW_PREF_KEY, on ? '1' : '0')
    } catch {
      // Private mode: the preference just won't stick.
    }
  }

  useEffect(() => {
    if (followAlong) followAvailability().then(setFollowState)
  }, [followAlong])

  useEffect(() => {
    onRecordingChange?.(phase === 'recording')
  }, [phase, onRecordingChange])

  // A persistently tiny level a few seconds in means the input device
  // itself is too quiet. Checked once a second, not per frame.
  useEffect(() => {
    if (phase !== 'recording' || !store) return
    const id = setInterval(() => {
      if (Date.now() - startedAt > 3000) setMicQuiet(store.readout.peakRms < 0.008)
    }, 1000)
    return () => clearInterval(id)
  }, [phase, store, startedAt])

  // Leaving mid-take or with an unsaved take loses audio: ask first.
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'saving' && phase !== 'unsaved') return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
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
        rememberFollow(true)
      }
      return
    }
    const next = !followEnabled
    setFollowEnabled(next)
    rememberFollow(next)
    if (!next && followRef.current) stopFollow()
    if (next && phase === 'recording' && followState === 'available' && !followRef.current) {
      onFollowProgress?.(0)
      followRef.current = startFollowAlong((words) => {
        onFollowProgress?.(alignWords(words, tokens))
      })
    }
  }

  const begin = useCallback(async () => {
    if (startingRef.current || sessionRef.current) return
    startingRef.current = true
    setError(null)
    setLastTake(null)
    setNotes('')
    try {
      const session = await startRecording()
      const live = new LiveStore(session.frameLag, session.peakSeconds)
      session.onUpdate = (u) => live.apply(u)
      sessionRef.current = session
      setStore(live)
      onLiveRef.current?.(live)
      setStartedAt(Date.now())
      setMicQuiet(false)
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
    } finally {
      startingRef.current = false
    }
  }, [followEnabled, followState, onFollowProgress, tokens])

  /** False start? Toss everything, keep nothing. */
  const scrap = useCallback(() => {
    sessionRef.current?.cancel()
    sessionRef.current = null
    stopFollow()
    setStore(null)
    onLiveRef.current?.(null)
    setMicQuiet(false)
    setPhase('idle')
  }, [stopFollow])

  const upload = useCallback(
    async (take: PendingTake) => {
      setPhase('saving')
      setError(null)
      try {
        const recording = await uploadRecording.mutateAsync({
          file: take.blob,
          script_id: scriptId,
          recorded_at: take.recordedAt,
          local_day: localDay(new Date(take.recordedAt)),
          pitch_stats: take.pitchStats,
        })
        pendingRef.current = null
        setLastTake(recording)
        setPhase('saved')
      } catch (err) {
        // Keep the audio: the take only exists in this tab until the
        // server has it.
        pendingRef.current = take
        setError(`Saving the take failed: ${err instanceof Error ? err.message : String(err)}`)
        setPhase('unsaved')
      }
    },
    [scriptId, uploadRecording],
  )

  const finish = useCallback(async () => {
    const session = sessionRef.current
    if (!session) return
    sessionRef.current = null
    stopFollow()
    setPhase('saving')
    const base = store?.readout.stats(targetMin, targetMax)
    const pitchStats = base && { ...base, ...extraStatsRef.current?.() }
    let blob: Blob
    try {
      blob = await session.stop()
    } catch (err) {
      setError(`Couldn't finish the recording: ${err instanceof Error ? err.message : String(err)}`)
      setPhase('idle')
      return
    }
    setStore(null)
    onLiveRef.current?.(null)
    await upload({ blob, recordedAt: startedAt, pitchStats })
  }, [stopFollow, store, targetMin, targetMax, upload, startedAt])

  const downloadPending = () => {
    const take = pendingRef.current
    if (!take) return
    const url = URL.createObjectURL(take.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `voicetrain-${localDay(new Date(take.recordedAt))}-${take.recordedAt}.wav`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const discardPending = () => {
    pendingRef.current = null
    setError(null)
    setPhase('idle')
  }

  // Space starts and stops a take (outside text fields and buttons).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return
      if (phase === 'idle' || phase === 'saved') {
        e.preventDefault()
        void begin()
      } else if (phase === 'recording') {
        e.preventDefault()
        void finish()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, begin, finish])

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

  const followLabel =
    followState === 'downloading'
      ? 'Fetching model…'
      : followState === 'downloadable'
        ? 'Enable follow-along'
        : 'Follow along'
  // The phone dock has room for an icon only; the label stays for screen
  // readers and as the tooltip.
  const followToggle = (iconOnly: boolean) =>
    followState !== 'unsupported' &&
    followState !== 'unavailable' && (
      <button
        onClick={toggleFollow}
        disabled={followState === 'downloading'}
        aria-pressed={followEnabled && followState === 'available'}
        aria-label={iconOnly ? followLabel : undefined}
        title={
          followState === 'downloadable'
            ? 'Download the on-device speech model to highlight the passage as you read'
            : 'Highlight the passage as you read (on-device, nothing leaves your computer)'
        }
        className={clsx(
          'flex shrink-0 items-center gap-1.5 rounded-full text-xs font-semibold transition-colors',
          iconOnly ? 'h-9 w-9 justify-center' : 'px-3 py-1.5',
          followEnabled && followState === 'available'
            ? 'bg-lavender-soft text-ink'
            : 'border border-rose-soft text-ink-soft hover:text-ink',
        )}
      >
        <BookOpenText size={iconOnly ? 16 : 13} />
        {!iconOnly && followLabel}
      </button>
    )

  return (
    <div ref={dockRef} className="max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-40">
      <div
        className={clsx(
          'border-rose-whisper bg-card',
          'max-lg:rounded-t-cozy max-lg:border-t max-lg:bg-card/95 max-lg:px-4 max-lg:pt-3 max-lg:pb-[max(env(safe-area-inset-bottom),0.75rem)] max-lg:shadow-cozy-lg max-lg:backdrop-blur-md',
          'lg:rounded-cozy lg:border lg:p-5 lg:shadow-cozy',
        )}
      >
        {phase === 'idle' && (
          <div className="flex items-center gap-4 lg:flex-col lg:gap-3 lg:py-3">
            <button
              onClick={begin}
              aria-label="Start recording"
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-rose text-white shadow-cozy-lg transition-[transform,background-color] hover:scale-105 hover:bg-rose-deep active:scale-95 lg:h-20 lg:w-20 motion-safe:animate-breathe"
            >
              <Mic className="size-6 lg:size-8" />
            </button>
            <div className="min-w-0 flex-1 lg:text-center">
              <p className="font-display text-lg font-semibold text-ink">{idleTitle}</p>
              <p className="text-sm text-ink-soft">
                <span className="max-lg:hidden">{idleHint} </span>
                Press <kbd className="rounded-md border border-rose-soft bg-cream px-1.5 text-xs">space</kbd> to start
                and stop.
              </p>
            </div>
            <div className="max-lg:hidden">{followToggle(false)}</div>
            <div className="lg:hidden">{followToggle(true)}</div>
          </div>
        )}
        {phase === 'idle' && error && (
          <p className="mt-2 text-center text-sm leading-relaxed text-rose-deep">{error}</p>
        )}

        {phase === 'recording' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                <span className="h-2.5 w-2.5 rounded-full bg-rose motion-safe:animate-gentle-pulse" />
                <span className="sr-only">Recording, </span>
                <Elapsed startedAt={startedAt} />
              </span>
              <div className="flex items-center gap-1.5">
                <span className="lg:hidden">{followToggle(true)}</span>
                <Button onClick={scrap} variant="ghost" size="sm" className="text-ink-soft">
                  <X size={13} /> Scrap
                </Button>
                <Button onClick={finish} variant="primary" size="sm">
                  <Square size={11} className="fill-current" /> Done
                </Button>
              </div>
            </div>
            <LiveMeter store={store} targetMinHz={targetMin} targetMaxHz={targetMax} compact={compact} axis={axis} />
            <div className="flex justify-center max-lg:hidden">{followToggle(false)}</div>
            {micQuiet && (
              <p className="text-center text-xs leading-relaxed text-honey-deep">
                Your mic is very quiet. Raise the input volume in System Settings so pitch
                tracking can hear you.
              </p>
            )}
          </div>
        )}

        {phase === 'saving' && (
          <div className="flex items-center justify-center gap-3 py-3 text-ink-soft lg:flex-col lg:py-6">
            <div className="h-6 w-6 animate-spin rounded-full border-[3px] border-rose-soft border-t-rose" />
            <p className="text-sm">Saving your take…</p>
          </div>
        )}

        {phase === 'unsaved' && (
          <div className="space-y-3 text-center">
            <h3 className="font-display text-lg font-semibold text-ink">This take isn't saved yet</h3>
            <p className="text-sm leading-relaxed text-ink-soft">
              {error} The audio is still in this tab: try again, or download a copy.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => pendingRef.current && upload(pendingRef.current)} size="sm">
                <RotateCcw size={14} /> Try saving again
              </Button>
              <Button onClick={downloadPending} variant="soft" size="sm">
                <Download size={14} /> Download the WAV
              </Button>
              <Button onClick={discardPending} variant="ghost" size="sm" className="text-ink-soft">
                Discard it
              </Button>
            </div>
          </div>
        )}

        {phase === 'saved' && lastTake && (
          <div className="space-y-3 motion-safe:animate-fade-up">
            <div className="flex items-start justify-between gap-3 lg:flex-col lg:items-center lg:text-center">
              <div>
                <h3 className="font-display text-lg font-semibold text-ink">Saved. Nice work 🌸</h3>
                <p className="mt-0.5 text-sm text-ink-soft">
                  {formatDuration(lastTake.duration_ms)}
                  {savedLine ? (
                    savedLine(lastTake) && <>, {savedLine(lastTake)}</>
                  ) : lastTake.pitch_stats && (
                    <>
                      , median {Math.round(lastTake.pitch_stats.median_hz)} Hz,{' '}
                      {Math.round(lastTake.pitch_stats.pct_in_band * 100)}% at home
                    </>
                  )}
                </p>
              </div>
              <RatingHearts value={lastTake.rating} onChange={rateLastTake} size={22} />
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={saveNotes}
              placeholder="A note for future you (optional)"
              rows={compact ? 1 : 2}
              aria-label="Note about this take"
              className="w-full resize-none rounded-2xl border border-rose-soft bg-white px-3.5 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-hidden focus:ring-2 focus:ring-rose/40"
            />
            <div className="grid grid-cols-[1fr_auto_auto] gap-2 lg:grid-cols-1">
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
                className="text-ink-soft"
                disabled={deleteRecording.isPending}
                aria-label="Delete this take"
              >
                <Trash2 size={13} /> <span className="max-lg:sr-only">Delete this take</span>
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
