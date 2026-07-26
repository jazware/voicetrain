import { useEffect, useRef } from 'react'
import { clsx } from 'clsx'
import type { PitchSample } from '@/lib/audio/pitchTracker'

const TRACE_SECONDS = 10
const Y_MIN_HZ = 75
const Y_MAX_HZ = 400

export interface PitchMeterHandle {
  push(sample: PitchSample): void
}

const logY = (hz: number, height: number) => {
  const t = (Math.log(hz) - Math.log(Y_MIN_HZ)) / (Math.log(Y_MAX_HZ) - Math.log(Y_MIN_HZ))
  return height - t * height
}

/**
 * Live pitch readout + a ~10s scrolling f0 trace on a log (semitone)
 * scale, with the target band drawn as a soft shaded stripe.
 */
export function PitchMeter({
  handleRef,
  currentHz,
  targetMinHz,
  targetMaxHz,
  heightClass = 'h-32',
}: {
  handleRef: React.MutableRefObject<PitchMeterHandle | null>
  currentHz: number | null
  targetMinHz: number
  targetMaxHz: number
  heightClass?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const samplesRef = useRef<PitchSample[]>([])

  useEffect(() => {
    handleRef.current = {
      push(sample: PitchSample) {
        const samples = samplesRef.current
        samples.push(sample)
        const cutoff = sample.time - TRACE_SECONDS
        while (samples.length && samples[0].time < cutoff) samples.shift()
      },
    }
    return () => {
      handleRef.current = null
    }
  }, [handleRef])

  useEffect(() => {
    let raf = 0
    const draw = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const dpr = window.devicePixelRatio || 1
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (canvas.width !== width * dpr) {
        canvas.width = width * dpr
        canvas.height = height * dpr
      }
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)

      // Target band stripe.
      const bandTop = logY(targetMaxHz, height)
      const bandBottom = logY(targetMinHz, height)
      ctx.fillStyle = 'rgba(127, 169, 127, 0.16)'
      ctx.fillRect(0, bandTop, width, bandBottom - bandTop)
      ctx.strokeStyle = 'rgba(127, 169, 127, 0.4)'
      ctx.setLineDash([4, 4])
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, bandTop)
      ctx.lineTo(width, bandTop)
      ctx.moveTo(0, bandBottom)
      ctx.lineTo(width, bandBottom)
      ctx.stroke()
      ctx.setLineDash([])

      // Reference gridlines at 100/150/200/300 Hz.
      ctx.fillStyle = 'rgba(82, 64, 79, 0.35)'
      ctx.font = '10px "Nunito Variable", sans-serif'
      for (const hz of [100, 150, 200, 300]) {
        const y = logY(hz, height)
        ctx.fillRect(0, y, width, 0.5)
        ctx.fillText(`${hz}`, 4, y - 3)
      }

      // The f0 trace: connected segments, gaps where unvoiced.
      const samples = samplesRef.current
      if (samples.length > 1) {
        const now = samples[samples.length - 1].time
        const xFor = (t: number) => width - ((now - t) / TRACE_SECONDS) * width

        ctx.strokeStyle = '#C94F62'
        ctx.fillStyle = '#C94F62'
        ctx.lineWidth = 2
        ctx.lineJoin = 'round'
        // Draw voiced runs as lines; a run of one sample gets a dot so
        // brief voicing doesn't vanish entirely.
        let run: Array<[number, number]> = []
        const flush = () => {
          if (run.length === 1) {
            ctx.beginPath()
            ctx.arc(run[0][0], run[0][1], 1.75, 0, Math.PI * 2)
            ctx.fill()
          } else if (run.length > 1) {
            ctx.beginPath()
            ctx.moveTo(run[0][0], run[0][1])
            for (let i = 1; i < run.length; i++) ctx.lineTo(run[i][0], run[i][1])
            ctx.stroke()
          }
          run = []
        }
        for (const s of samples) {
          if (s.hz === null) {
            flush()
            continue
          }
          run.push([xFor(s.time), logY(s.hz, height)])
        }
        flush()
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [targetMinHz, targetMaxHz])

  const inBand = currentHz !== null && currentHz >= targetMinHz && currentHz <= targetMaxHz
  const nearBand =
    currentHz !== null &&
    !inBand &&
    currentHz >= targetMinHz * 0.9 &&
    currentHz <= targetMaxHz * 1.1

  return (
    <div className="flex items-stretch gap-4">
      <div className="flex w-28 shrink-0 flex-col items-center justify-center rounded-2xl bg-cream px-2 py-3">
        <span
          className={clsx(
            'font-display text-3xl font-bold tabular-nums transition-colors duration-200',
            currentHz === null && 'text-ink-faint',
            inBand && 'text-sage',
            nearBand && 'text-honey',
            currentHz !== null && !inBand && !nearBand && 'text-rose-deep',
          )}
        >
          {currentHz === null ? '·' : Math.round(currentHz)}
        </span>
        <span className="text-xs font-semibold text-ink-faint">Hz</span>
        <span className="mt-1 text-center text-[10px] leading-tight text-ink-faint">
          {targetMinHz}–{targetMaxHz} is home
        </span>
      </div>
      <div className="relative min-w-0 flex-1">
        <canvas ref={canvasRef} className={`${heightClass} w-full`} aria-label="Pitch trace" />
      </div>
    </div>
  )
}
