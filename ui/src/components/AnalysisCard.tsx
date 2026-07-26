import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { clsx } from 'clsx'
import { RefreshCw } from 'lucide-react'
import { api, type Analysis, type Recording } from '@/lib/api'
import { breathNote, melodyNote, pitchNote, resonanceNote, weightNote } from '@/lib/analysisMeta'
import { Card } from '@/components/ui/Card'

/**
 * "What we heard" — the post-hoc acoustic analysis for one take:
 * a hero pitch readout, the full-take pitch contour (click to listen
 * from that moment), and one tile per coaching axis.
 */
export function AnalysisCard({
  take,
  onSeek,
}: {
  take: Recording
  onSeek: (seconds: number) => void
}) {
  const qc = useQueryClient()
  const [requestedAt, setRequestedAt] = useState<number | null>(null)

  const waiting =
    (!take.analyzed_at && take.file_path !== '') ||
    (requestedAt !== null && (take.analyzed_at ?? 0) < requestedAt)

  // While an analysis is due, poll the take; when a new one lands the
  // annotations (waveform regions) need refreshing too.
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(
      () => qc.invalidateQueries({ queryKey: ['recordings', 'detail', take.id] }),
      4000,
    )
    return () => clearInterval(timer)
  }, [waiting, qc, take.id])

  const analyzedAt = take.analyzed_at
  useEffect(() => {
    if (analyzedAt) qc.invalidateQueries({ queryKey: ['annotations', take.id] })
  }, [analyzedAt, qc, take.id])

  const reanalyze = async () => {
    setRequestedAt(Date.now())
    try {
      await api.analyzeRecording(take.id)
    } catch {
      setRequestedAt(null)
    }
  }

  if (!take.analysis || waiting) {
    return (
      <Card className="p-6">
        <Header onReanalyze={reanalyze} waiting={waiting} />
        <div className="mt-4 flex items-center gap-3 rounded-2xl bg-cream px-4 py-5">
          <span className="animate-gentle-pulse text-xl">🎧</span>
          <div>
            <p className="text-sm font-semibold text-ink-soft">
              Listening closely to this take…
            </p>
            <p className="mt-0.5 text-xs text-ink-faint">
              Analysis runs in the background and usually takes under a minute. If it never
              arrives, make sure Docker is running (<code>just analysis-build</code> once).
            </p>
          </div>
        </div>
      </Card>
    )
  }

  const a = take.analysis
  if (a.pitch.median_hz === null) {
    return (
      <Card className="p-6">
        <Header onReanalyze={reanalyze} waiting={false} />
        <p className="mt-4 rounded-2xl bg-cream px-4 py-5 text-sm text-ink-soft">
          We couldn’t hear a voice in this one — probably a false start. Nothing to measure 💛
        </p>
      </Card>
    )
  }

  return (
    <Card className="space-y-5 p-6">
      <Header onReanalyze={reanalyze} waiting={false} />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-stretch">
        <MedianTile a={a} />
        <div className="min-w-0 flex-1">
          <PitchContour analysis={a} onSeek={onSeek} />
        </div>
      </div>
      <p className="text-sm leading-relaxed text-ink-soft">{pitchNote(a)}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <AxisTile
          emoji="🎶"
          title="Melody"
          headline={a.melody.semitone_sd !== null ? `±${a.melody.semitone_sd} st` : '–'}
          headlineHint="swing"
          stats={[
            ['range', fmt(a.melody.range_st_5_95, ' st')],
            [
              'endings ↑/↓/→',
              `${a.melody.phrase_endings.rising}/${a.melody.phrase_endings.falling}/${a.melody.phrase_endings.flat}`,
            ],
          ]}
          note={melodyNote(a)}
        />
        <AxisTile
          emoji="🌬️"
          title="Breath & pacing"
          headline={a.breath.mean_phrase_s !== null ? `${a.breath.mean_phrase_s}s` : '–'}
          headlineHint="per phrase"
          stats={[
            ['pauses', String(a.breath.pause_count)],
            ['pace', fmt(a.breath.articulation_rate_sps, ' syll/s')],
            ['longest', fmt(a.breath.max_phrase_s, 's')],
          ]}
          note={breathNote(a)}
        />
        <AxisTile
          emoji="✨"
          title="Resonance"
          headline={fmt(a.resonance.estimated_vtl_cm, ' cm')}
          headlineHint="est. tract length"
          stats={[
            ['brightness', fmt(a.resonance.spectral_centroid_hz, ' Hz')],
            ['F1·F2·F3', formantSummary(a)],
          ]}
          note={resonanceNote()}
        />
        <AxisTile
          emoji="🪶"
          title="Weight"
          headline={fmt(a.weight.cpps_db, ' dB')}
          headlineHint="clarity (CPPS)"
          stats={[
            ['HNR', fmt(a.weight.hnr_db, ' dB')],
            ['jitter', fmt(a.weight.jitter_local_pct, '%')],
            ['shimmer', fmt(a.weight.shimmer_local_pct, '%')],
          ]}
          note={weightNote(a)}
        />
      </div>
    </Card>
  )
}

function Header({ onReanalyze, waiting }: { onReanalyze: () => void; waiting: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="font-display text-lg font-bold text-ink">What we heard</h2>
      <button
        onClick={onReanalyze}
        disabled={waiting}
        title="Run the analysis again"
        className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold text-ink-faint transition-colors hover:bg-lavender-soft hover:text-ink disabled:opacity-40"
      >
        <RefreshCw size={12} className={clsx(waiting && 'animate-spin')} />
        {waiting ? 'listening…' : 're-listen'}
      </button>
    </div>
  )
}

function MedianTile({ a }: { a: Analysis }) {
  const median = a.pitch.median_hz!
  const inBand = median >= a.target_min_hz && median <= a.target_max_hz
  const nearBand = !inBand && median >= a.target_min_hz * 0.9 && median <= a.target_max_hz * 1.1
  return (
    <div className="flex w-full shrink-0 flex-col items-center justify-center rounded-2xl bg-cream px-4 py-4 sm:w-32">
      <span
        className={clsx(
          'font-display text-4xl font-bold tabular-nums',
          inBand && 'text-sage',
          nearBand && 'text-honey',
          !inBand && !nearBand && 'text-rose-deep',
        )}
      >
        {Math.round(median)}
      </span>
      <span className="text-xs font-semibold text-ink-faint">Hz median</span>
      <span className="mt-2 text-center text-[11px] leading-tight text-ink-soft">
        {a.pitch.pct_in_band !== null && (
          <>
            <strong className="text-ink">{Math.round(a.pitch.pct_in_band)}%</strong> in band
          </>
        )}
        {a.pitch.fry_pct !== null && (
          <>
            <br />
            {a.pitch.fry_pct}% fry
          </>
        )}
      </span>
    </div>
  )
}

// ── pitch contour ────────────────────────────────────────────────────

const Y_MIN_HZ = 75
const Y_MAX_HZ = 400
const CHART_H = 132

/**
 * Full-take f0 contour (250ms buckets) on the same log scale and
 * visual language as the live PitchMeter: sage band, rose trace.
 * Hover shows the value; clicking starts playback from that moment.
 */
function PitchContour({
  analysis,
  onSeek,
}: {
  analysis: Analysis
  onSeek: (seconds: number) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<{ t: number; hz: number; x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => setWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const contour = analysis.contour
  const duration = analysis.duration_s ?? (contour.length ? contour[contour.length - 1].t : 0)

  const clampHz = (hz: number) => Math.min(Y_MAX_HZ, Math.max(Y_MIN_HZ, hz))
  const yFor = (hz: number) =>
    CHART_H -
    ((Math.log(clampHz(hz)) - Math.log(Y_MIN_HZ)) / (Math.log(Y_MAX_HZ) - Math.log(Y_MIN_HZ))) *
      CHART_H
  const xFor = (t: number) => (duration > 0 ? (t / duration) * width : 0)

  // Voiced runs → polyline segments; single buckets → dots.
  const segments: string[] = []
  const dots: Array<[number, number]> = []
  let run: Array<[number, number]> = []
  const flush = () => {
    if (run.length === 1) dots.push(run[0])
    else if (run.length > 1) segments.push(run.map(([x, y]) => `${x},${y}`).join(' '))
    run = []
  }
  for (const p of contour) {
    if (p.hz === null) {
      flush()
      continue
    }
    run.push([xFor(p.t), yFor(p.hz)])
  }
  flush()

  const bandTop = yFor(analysis.target_max_hz)
  const bandBottom = yFor(analysis.target_min_hz)

  const locate = (clientX: number): { t: number; hz: number; x: number; y: number } | null => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect || width === 0 || duration === 0) return null
    const x = Math.min(Math.max(clientX - rect.left, 0), width)
    const t = (x / width) * duration
    const idx = Math.round(t / 0.25)
    // Nearest voiced bucket within ~1s of the pointer.
    let best: { t: number; hz: number } | null = null
    for (let d = 0; d <= 4; d++) {
      for (const i of d === 0 ? [idx] : [idx - d, idx + d]) {
        const p = contour[i]
        if (p && p.hz !== null) {
          best = { t: p.t, hz: p.hz }
          break
        }
      }
      if (best) break
    }
    if (!best) return null
    return { ...best, x: xFor(best.t), y: yFor(best.hz) }
  }

  return (
    <div
      ref={wrapRef}
      className="relative cursor-pointer rounded-2xl bg-cream"
      onMouseMove={(e) => setHover(locate(e.clientX))}
      onMouseLeave={() => setHover(null)}
      onClick={(e) => {
        const p = locate(e.clientX)
        if (p) onSeek(p.t)
      }}
      title="Click to listen from here"
    >
      <svg width={width || '100%'} height={CHART_H} className="block">
        <rect x={0} y={bandTop} width={width} height={bandBottom - bandTop} fill="rgba(127,169,127,0.16)" />
        <line x1={0} x2={width} y1={bandTop} y2={bandTop} stroke="rgba(127,169,127,0.4)" strokeDasharray="4 4" />
        <line x1={0} x2={width} y1={bandBottom} y2={bandBottom} stroke="rgba(127,169,127,0.4)" strokeDasharray="4 4" />
        {[100, 150, 200, 300].map((hz) => (
          <g key={hz}>
            <line x1={0} x2={width} y1={yFor(hz)} y2={yFor(hz)} stroke="rgba(82,64,79,0.12)" />
            <text x={4} y={yFor(hz) - 3} fontSize={10} fill="rgba(82,64,79,0.4)" className="font-body">
              {hz}
            </text>
          </g>
        ))}
        {segments.map((points, i) => (
          <polyline
            key={i}
            points={points}
            fill="none"
            stroke="#C94F62"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {dots.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={1.75} fill="#C94F62" />
        ))}
        {hover && (
          <>
            <line x1={hover.x} x2={hover.x} y1={0} y2={CHART_H} stroke="rgba(164,143,203,0.5)" />
            <circle cx={hover.x} cy={hover.y} r={4} fill="#C94F62" stroke="#FFFDFA" strokeWidth={2} />
          </>
        )}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 -translate-y-full rounded-lg bg-ink px-2 py-1 text-[11px] font-semibold text-cream shadow-lifted"
          style={{ left: Math.min(Math.max(hover.x, 32), Math.max(width - 32, 32)) }}
        >
          {Math.round(hover.hz)} Hz · {formatClock(hover.t)}
        </div>
      )}
    </div>
  )
}

function AxisTile({
  emoji,
  title,
  headline,
  headlineHint,
  stats,
  note,
}: {
  emoji: string
  title: string
  headline: string
  headlineHint: string
  stats: Array<[string, string]>
  note: string
}) {
  return (
    <div className="rounded-2xl bg-cream p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-bold uppercase tracking-wide text-ink-faint">
          {emoji} {title}
        </span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="font-display text-2xl font-bold tabular-nums text-ink">{headline}</span>
        <span className="text-xs text-ink-faint">{headlineHint}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-ink-soft">
        {stats.map(([k, v]) => (
          <span key={k}>
            <span className="text-ink-faint">{k}</span> <span className="tabular-nums">{v}</span>
          </span>
        ))}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-soft">{note}</p>
    </div>
  )
}

const fmt = (n: number | null, unit = ''): string => (n === null ? '–' : `${n}${unit}`)

function formantSummary(a: Analysis): string {
  const f = [a.resonance.f1_median_hz, a.resonance.f2_median_hz, a.resonance.f3_median_hz]
  if (f.every((v) => v === null)) return '–'
  return f.map((v) => (v === null ? '–' : Math.round(v))).join('·')
}

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
