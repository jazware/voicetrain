import { useEffect, useState } from 'react'
import { clsx } from 'clsx'
import { Card } from '@/components/ui/Card'
import { EXERCISES, type ExerciseKind, type ExerciseMeter } from '@/lib/exercises'
import { pitchY } from '@/lib/band'

export const SIREN_AXIS = { minHz: 70, maxHz: 800, grid: [100, 200, 400] }

// A comfortable first goal for a steady hold; the ring fills to it.
const HOLD_GOAL_S = 10

interface Snapshot {
  range: { low: number; high: number; st: number } | null
  holdS: number
  holdCents: number | null
  bestHoldS: number
  streakS: number
  bestStreakS: number
  inBandPct: number | null
}

function snapshot(m: ExerciseMeter, now: number): Snapshot {
  return {
    range: m.range(),
    holdS: m.currentHoldS(now),
    holdCents: m.currentHoldCents(),
    bestHoldS: m.bestHoldS,
    streakS: m.currentStreakS(now),
    bestStreakS: m.bestStreakS,
    inBandPct: m.inBandPct(),
  }
}

/**
 * The exercise's own picture, beside the live meter: the range a siren
 * has covered, a hold filling its ring, the time spent at home. It reads
 * the meter a few times a second while a take records and keeps the
 * last numbers after it ends.
 */
export function ExerciseCoach({
  kind,
  meter,
  clock,
  recording,
  bandMin,
  bandMax,
}: {
  kind: ExerciseKind
  meter: ExerciseMeter | null
  /** Seconds of audio "now", for the hold and streak in progress. */
  clock: () => number
  recording: boolean
  bandMin: number
  bandMax: number
}) {
  const [s, setS] = useState<Snapshot | null>(null)
  useEffect(() => {
    if (!meter) {
      setS(null)
      return
    }
    setS(snapshot(meter, clock()))
    if (!recording) return
    const id = setInterval(() => setS(snapshot(meter, clock())), 150)
    return () => clearInterval(id)
  }, [meter, recording, clock])

  const info = EXERCISES[kind]
  return (
    <Card className="overflow-hidden p-6 sm:p-8">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-lg font-semibold text-ink">{info.measure}</h2>
        <span className="text-xs text-ink-soft">{recording ? 'live' : s ? 'last take' : ''}</span>
      </div>
      {kind === 'siren' && <SirenView s={s} bandMin={bandMin} bandMax={bandMax} />}
      {kind === 'sustain' && <SustainView s={s} />}
      {kind === 'hold' && <HoldView s={s} />}
      <p className="mt-4 max-w-[60ch] text-sm leading-relaxed text-ink-soft">{info.goal}</p>
    </Card>
  )
}

function Big({ value, unit, muted }: { value: string; unit?: string; muted?: boolean }) {
  return (
    <p className={clsx('font-display text-5xl font-bold tabular-nums leading-none', muted ? 'text-ink-faint' : 'text-ink')}>
      {value}
      {unit && <span className="ml-1.5 font-body text-base font-semibold text-ink-soft">{unit}</span>}
    </p>
  )
}

/** The range covered, as a ribbon on the same log scale as the meter. */
function SirenView({ s, bandMin, bandMax }: { s: Snapshot | null; bandMin: number; bandMax: number }) {
  const r = s?.range ?? null
  const pct = (hz: number) => 100 - pitchY(hz, 100, SIREN_AXIS.minHz, SIREN_AXIS.maxHz)
  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Big value={r ? r.st.toFixed(1) : '–'} unit="semitones" muted={!r} />
        {r && (
          <span className="text-sm text-ink-soft">
            from {Math.round(r.low)} to {Math.round(r.high)} Hz
          </span>
        )}
      </div>
      <div className="relative pt-5 pb-6" role="img" aria-label={r ? `Range ${Math.round(r.low)} to ${Math.round(r.high)} Hz` : 'No range yet'}>
        <div className="relative h-4 rounded-full bg-rose-whisper">
          <div
            className="absolute inset-y-0 bg-sage/40"
            style={{ left: `${pct(bandMin)}%`, width: `${pct(bandMax) - pct(bandMin)}%` }}
          />
          {r && (
            <div
              className="absolute inset-y-0.5 rounded-full bg-linear-to-r from-peach to-rose-deep transition-all duration-300"
              style={{ left: `${pct(r.low)}%`, width: `${Math.max(1, pct(r.high) - pct(r.low))}%` }}
            />
          )}
        </div>
        <span
          className="absolute top-0 -translate-x-1/2 text-xs font-semibold text-sage-deep"
          style={{ left: `${(pct(bandMin) + pct(bandMax)) / 2}%` }}
        >
          home
        </span>
        {SIREN_AXIS.grid.map((hz) => (
          <span key={hz} className="absolute bottom-0 -translate-x-1/2 text-xs tabular-nums text-ink-soft" style={{ left: `${pct(hz)}%` }}>
            {hz}
          </span>
        ))}
      </div>
    </div>
  )
}

/** The hold in progress filling a ring, with how steady it is. */
function SustainView({ s }: { s: Snapshot | null }) {
  const hold = s?.holdS ?? 0
  const shown = hold > 0 ? hold : (s?.bestHoldS ?? 0)
  const frac = Math.min(1, shown / HOLD_GOAL_S)
  const C = 2 * Math.PI * 52
  const cents = s?.holdCents ?? null
  const steadiness =
    cents === null ? null : cents < 15 ? 'Very steady' : cents < 30 ? 'Steady' : 'Wavering a little'
  return (
    <div className="mt-4 flex flex-wrap items-center gap-6">
      <svg viewBox="0 0 120 120" className="h-32 w-32 shrink-0" role="img" aria-label={`Holding ${shown.toFixed(1)} seconds`}>
        <circle cx={60} cy={60} r={52} fill="none" stroke="#fdf0f2" strokeWidth={10} />
        <circle
          cx={60}
          cy={60}
          r={52}
          fill="none"
          stroke={frac >= 1 ? '#4f7f52' : '#e2687a'}
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={`${frac * C} ${C}`}
          transform="rotate(-90 60 60)"
          className="transition-[stroke-dasharray] duration-150"
        />
        <text x={60} y={66} textAnchor="middle" fontSize={26} fontWeight={700} fill="#4a3846" className="font-display">
          {shown.toFixed(1)}
        </text>
        <text x={60} y={84} textAnchor="middle" fontSize={11} fill="#76606f" className="font-body">
          seconds
        </text>
      </svg>
      <div className="space-y-1.5">
        <p className="text-base font-semibold text-ink">
          {hold > 0 ? 'Holding…' : s && s.bestHoldS > 0 ? 'Longest hold this take' : 'Find a note, then hold it'}
        </p>
        {steadiness && cents !== null && (
          <p className={clsx('text-sm', cents < 30 ? 'text-sage-deep' : 'text-honey-deep')}>
            {steadiness}: within ±{Math.round(cents)} cents
          </p>
        )}
        {s && s.bestHoldS > 0 && hold > 0 && <p className="text-sm text-ink-soft">best so far {s.bestHoldS.toFixed(1)} s</p>}
      </div>
    </div>
  )
}

/** Time at home, and the current stretch against the longest. */
function HoldView({ s }: { s: Snapshot | null }) {
  const pct = s?.inBandPct ?? null
  const best = Math.max(s?.bestStreakS ?? 0, 0.001)
  const cur = s?.streakS ?? 0
  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Big value={pct === null ? '–' : String(Math.round(pct))} unit="% at home" muted={pct === null} />
      </div>
      <div className="space-y-1.5">
        <div className="flex justify-between text-sm text-ink-soft">
          <span>{cur > 0 ? `This stretch: ${Math.round(cur)} s` : 'Not at home right now'}</span>
          <span>longest {Math.round(s?.bestStreakS ?? 0)} s</span>
        </div>
        <div className="h-3 overflow-hidden rounded-full bg-rose-whisper">
          <div
            className="h-full rounded-full bg-sage transition-[width] duration-150"
            style={{ width: `${Math.min(100, (cur / best) * 100)}%` }}
          />
        </div>
      </div>
    </div>
  )
}
