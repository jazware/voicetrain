import { useEffect, useRef } from 'react'

export interface LiveWaveformHandle {
  feed(chunk: Float32Array): void
}

const PEAK_WINDOW = 960 // ~20ms at 48kHz
const MAX_PEAKS = 420 // ~8.4s of history

/**
 * Rolling min/max peak strip drawn on canvas while recording.
 * Feed it PCM chunks via the handle ref.
 */
export function LiveWaveform({
  handleRef,
  heightClass = 'h-20',
}: {
  handleRef: React.MutableRefObject<LiveWaveformHandle | null>
  heightClass?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const peaksRef = useRef<Array<[number, number]>>([])
  const carryRef = useRef<number[]>([])

  useEffect(() => {
    handleRef.current = {
      feed(chunk: Float32Array) {
        const carry = carryRef.current
        for (let i = 0; i < chunk.length; i++) carry.push(chunk[i])
        const peaks = peaksRef.current
        while (carry.length >= PEAK_WINDOW) {
          const slice = carry.splice(0, PEAK_WINDOW)
          let min = 1,
            max = -1
          for (const v of slice) {
            if (v < min) min = v
            if (v > max) max = v
          }
          peaks.push([min, max])
          if (peaks.length > MAX_PEAKS) peaks.shift()
        }
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

      const peaks = peaksRef.current
      const mid = height / 2
      const barWidth = 2
      const gap = 1
      const visible = Math.min(peaks.length, Math.floor(width / (barWidth + gap)))
      const start = peaks.length - visible

      ctx.fillStyle = '#E2687A'
      for (let i = 0; i < visible; i++) {
        const [min, max] = peaks[start + i]
        const x = width - (visible - i) * (barWidth + gap)
        const y = mid + min * mid * 0.9
        const h = Math.max(2, (max - min) * mid * 0.9)
        ctx.globalAlpha = 0.35 + 0.65 * (i / visible)
        ctx.beginPath()
        ctx.roundRect(x, y, barWidth, h, 1)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return <canvas ref={canvasRef} className={`${heightClass} w-full`} aria-label="Live waveform" />
}
