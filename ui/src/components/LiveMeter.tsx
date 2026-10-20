import { useEffect, useRef } from 'react'
import { clsx } from 'clsx'
import type { LiveStore } from '@/lib/audio/liveStore'
import { BAND_COLORS, PITCH_AXIS, bandState, pitchY, type BandState } from '@/lib/band'

const TRACE_SECONDS = 8
const FADE_FRACTION = 0.35

/**
 * The live picture while recording: a round readout that warms to sage
 * when the voice is home, beside a scrolling pitch trace over the
 * target band, with the loudness envelope as a soft ground line.
 *
 * Everything is drawn on requestAnimationFrame from the LiveStore and
 * written to the DOM directly, so recording never re-renders React.
 */
export function LiveMeter({
  store,
  targetMinHz,
  targetMaxHz,
  compact = false,
  axis = PITCH_AXIS,
}: {
  store: LiveStore | null
  targetMinHz: number
  targetMaxHz: number
  compact?: boolean
  /** The frequency span drawn; sirens need more headroom than speech. */
  axis?: { minHz: number; maxHz: number; grid: number[] }
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const discRef = useRef<HTMLDivElement>(null)
  const numberRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let raf = 0
    let shown = ''
    const yAt = (hz: number, height: number) => pitchY(hz, height, axis.minHz, axis.maxHz)
    const draw = (perfNow: number) => {
      raf = requestAnimationFrame(draw)
      const canvas = canvasRef.current
      if (!canvas) return

      const hz = store?.readout.displayHz() ?? null
      const text = hz === null ? '·' : String(Math.round(hz))
      if (text !== shown && numberRef.current && discRef.current) {
        shown = text
        numberRef.current.textContent = text
        discRef.current.dataset.band = bandState(hz, targetMinHz, targetMaxHz)
      }

      const dpr = window.devicePixelRatio || 1
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
      }
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.globalCompositeOperation = 'source-over'

      if (store) {
        const now = store.clock(perfNow)
        const edge = now - store.frameLag
        const xFor = (t: number) => width - ((edge - t) / TRACE_SECONDS) * width

        // Loudness envelope along the bottom: peach, mirrored.
        const groundH = height * 0.2
        const groundY = height - groundH / 2 - 2
        ctx.fillStyle = 'rgba(245, 169, 127, 0.38)'
        ctx.beginPath()
        const peaks = store.peaks
        let started = false
        const upper: Array<[number, number]> = []
        for (const [t, , max] of peaks) {
          const x = width - ((now - t) / TRACE_SECONDS) * width
          if (x < -4) continue
          const a = Math.min(1, Math.max(Math.abs(max), 0) * 2.2)
          upper.push([x, groundY - (a * groundH) / 2 - 0.5])
        }
        for (const [x, y] of upper) {
          if (!started) {
            ctx.moveTo(x, groundY)
            started = true
          }
          ctx.lineTo(x, y)
        }
        for (let i = upper.length - 1; i >= 0; i--) ctx.lineTo(upper[i][0], 2 * groundY - upper[i][1])
        if (started) ctx.fill()

        // The trace, coloured by where each stretch sits.
        const ts = store.traceT
        const hzs = store.traceHz
        ctx.lineWidth = compact ? 2.5 : 3
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        let pathState: BandState | null = null
        let count = 0
        let startX = 0
        let startY = 0
        let prevT = -Infinity
        const flush = () => {
          if (pathState === null) return
          if (count === 1) {
            ctx.fillStyle = BAND_COLORS[pathState]
            ctx.beginPath()
            ctx.arc(startX, startY, ctx.lineWidth / 2, 0, Math.PI * 2)
            ctx.fill()
          } else {
            ctx.stroke()
          }
          pathState = null
        }
        const begin = (x: number, y: number, state: BandState) => {
          pathState = state
          count = 1
          startX = x
          startY = y
          ctx.strokeStyle = BAND_COLORS[state]
          ctx.beginPath()
          ctx.moveTo(x, y)
        }
        const first = Math.max(0, ts.findIndex((t) => t >= edge - TRACE_SECONDS - 0.05))
        for (let i = first; i < ts.length; i++) {
          if (Number.isNaN(hzs[i])) {
            flush()
            continue
          }
          const x = xFor(ts[i])
          const y = yAt(hzs[i], height)
          const state = bandState(hzs[i], targetMinHz, targetMaxHz)
          // A gap of more than two frames breaks the line.
          if (pathState === null || ts[i] - prevT > 0.025) {
            flush()
            begin(x, y, state)
          } else {
            ctx.lineTo(x, y)
            count++
            if (state !== pathState) {
              flush()
              begin(x, y, state)
            }
          }
          prevT = ts[i]
        }
        flush()

        // Older audio fades out to the left.
        ctx.globalCompositeOperation = 'destination-out'
        const fade = ctx.createLinearGradient(0, 0, width * FADE_FRACTION, 0)
        fade.addColorStop(0, 'rgba(0,0,0,0.85)')
        fade.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = fade
        ctx.fillRect(0, 0, width * FADE_FRACTION, height)
        ctx.globalCompositeOperation = 'source-over'

        // Where the voice is right now.
        const last = ts.length - 1
        if (last >= 0 && !Number.isNaN(hzs[last]) && edge - ts[last] < 0.06) {
          const color = BAND_COLORS[bandState(hzs[last], targetMinHz, targetMaxHz)]
          const x = xFor(ts[last])
          const y = yAt(hzs[last], height)
          ctx.fillStyle = color
          ctx.globalAlpha = 0.22
          ctx.beginPath()
          ctx.arc(x, y, 10, 0, Math.PI * 2)
          ctx.fill()
          ctx.globalAlpha = 1
          ctx.beginPath()
          ctx.arc(x, y, 4.5, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // Band and grid go underneath everything drawn above.
      ctx.globalCompositeOperation = 'destination-over'
      ctx.fillStyle = 'rgba(82, 64, 79, 0.45)'
      ctx.font = '600 10px "Nunito Variable", sans-serif'
      ctx.textBaseline = 'bottom'
      for (const g of axis.grid) {
        const y = yAt(g, height)
        ctx.fillText(String(g), 6, y - 2)
      }
      ctx.fillStyle = 'rgba(82, 64, 79, 0.08)'
      for (const g of axis.grid) ctx.fillRect(0, Math.round(yAt(g, height)), width, 1)
      const top = yAt(targetMaxHz, height)
      const bottom = yAt(targetMinHz, height)
      ctx.fillStyle = 'rgba(79, 127, 82, 0.35)'
      ctx.fillRect(0, Math.round(top), width, 1)
      ctx.fillRect(0, Math.round(bottom), width, 1)
      ctx.fillStyle = 'rgba(127, 169, 127, 0.16)'
      ctx.fillRect(0, top, width, bottom - top)
      ctx.globalCompositeOperation = 'source-over'
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [store, targetMinHz, targetMaxHz, compact, axis])

  return (
    <div className="flex items-stretch gap-3 sm:gap-4">
      <div className="flex shrink-0 flex-col items-center justify-center gap-1.5">
        <div
          ref={discRef}
          data-band="none"
          className={clsx(
            'flex flex-col items-center justify-center rounded-full transition-[background-color,box-shadow,color] duration-300',
            'bg-cream text-ink-faint',
            'data-[band=in]:bg-sage-soft data-[band=in]:text-sage-deep data-[band=in]:shadow-[0_0_0_6px_rgba(127,169,127,0.18)]',
            'data-[band=near]:bg-honey-soft data-[band=near]:text-honey-deep',
            'data-[band=out]:bg-rose-whisper data-[band=out]:text-rose-deep',
            compact ? 'h-16 w-16' : 'h-24 w-24',
          )}
        >
          <span
            ref={numberRef}
            data-pitch-readout
            className={clsx('font-display font-bold leading-none tabular-nums', compact ? 'text-2xl' : 'text-[2.1rem]')}
          >
            ·
          </span>
          <span className="text-[10px] font-bold opacity-70">Hz</span>
        </div>
        {!compact && (
          <span className="text-[11px] font-semibold text-ink-soft">
            home {targetMinHz}–{targetMaxHz}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1 rounded-2xl bg-cream/70">
        <canvas
          ref={canvasRef}
          className={clsx('block w-full', compact ? 'h-20' : 'h-40')}
          role="img"
          aria-label={`Live pitch trace; your home band is ${targetMinHz} to ${targetMaxHz} Hz`}
        />
      </div>
    </div>
  )
}
