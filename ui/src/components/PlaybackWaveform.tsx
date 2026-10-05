import { useEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.js'
import { Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { formatDuration } from '@/lib/format'
import { kindMeta } from '@/lib/analysisMeta'
import type { Annotation } from '@/lib/api'

export interface PlaybackHandle {
  /** Jump to a moment and start playing from just before it. */
  seekTo(seconds: number): void
}

/**
 * Seekable waveform player for a stored take. Analysis annotations
 * render as soft colored spans (fry, monotone, long-phrase — colors
 * from analysisMeta); clicking a span plays that moment.
 */
export function PlaybackWaveform({
  audioUrl,
  annotations = [],
  handleRef,
}: {
  audioUrl: string
  annotations?: Annotation[]
  handleRef?: React.MutableRefObject<PlaybackHandle | null>
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wavesurferRef = useRef<WaveSurfer | null>(null)
  const [playing, setPlaying] = useState(false)
  const [ready, setReady] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)

  const seekTo = (seconds: number) => {
    const ws = wavesurferRef.current
    if (!ws) return
    // Land a touch early so the moment plays with a little run-up.
    ws.setTime(Math.max(0, seconds - 0.35))
    ws.play()
  }

  useEffect(() => {
    if (handleRef) handleRef.current = { seekTo }
    return () => {
      if (handleRef) handleRef.current = null
    }
  })

  useEffect(() => {
    if (!containerRef.current) return

    const regions = RegionsPlugin.create()
    const ws = WaveSurfer.create({
      container: containerRef.current,
      url: audioUrl,
      height: 96,
      waveColor: '#F3C1C9',
      progressColor: '#E2687A',
      cursorColor: '#A48FCB',
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      plugins: [regions],
    })
    wavesurferRef.current = ws

    ws.on('ready', () => {
      setReady(true)
      setDuration(ws.getDuration())
    })
    ws.on('play', () => setPlaying(true))
    ws.on('pause', () => setPlaying(false))
    ws.on('finish', () => setPlaying(false))
    ws.on('timeupdate', (t) => setPosition(t))

    regions.on('region-clicked', (region, e) => {
      e.stopPropagation()
      ws.setTime(Math.max(0, region.start - 0.35))
      ws.play()
    })

    return () => {
      wavesurferRef.current = null
      ws.destroy()
    }
  }, [audioUrl])

  // Render annotations as colored spans whenever they change.
  useEffect(() => {
    const ws = wavesurferRef.current
    if (!ws || !ready) return
    const regions = ws
      .getActivePlugins()
      .find((p): p is InstanceType<typeof RegionsPlugin> => p instanceof RegionsPlugin)
    if (!regions) return
    regions.clearRegions()
    for (const a of annotations) {
      regions.addRegion({
        start: a.start_ms / 1000,
        end: a.end_ms !== null ? a.end_ms / 1000 : undefined,
        color: kindMeta(a.kind).fill,
        drag: false,
        resize: false,
      })
    }
  }, [annotations, ready])

  return (
    <div className="space-y-3">
      <div ref={containerRef} className="overflow-hidden rounded-2xl bg-cream px-2 py-1" />
      <div className="flex items-center gap-4">
        <Button
          onClick={() => wavesurferRef.current?.playPause()}
          disabled={!ready}
          aria-label={playing ? 'Pause' : 'Play'}
          className="h-12! w-12! rounded-full! p-0!"
        >
          {playing ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
        </Button>
        <span className="text-sm tabular-nums text-ink-soft">
          {formatDuration(position * 1000)} / {formatDuration(duration * 1000)}
        </span>
      </div>
    </div>
  )
}
