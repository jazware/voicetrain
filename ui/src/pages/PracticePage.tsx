import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { clsx } from 'clsx'
import { Card } from '@/components/ui/Card'
import { Spinner } from '@/components/ui/Spinner'
import { Recorder } from '@/components/Recorder'
import { PassageText } from '@/components/PassageText'
import { FocusPointsPanel } from '@/components/FocusPointsPanel'
import { TakeList } from '@/components/TakeList'
import { useRecordings, useScript } from '@/hooks/queries'
import { localDay } from '@/lib/api'

export function PracticePage() {
  const params = useParams()
  const scriptId = Number(params.scriptId)
  const { data: script, isLoading } = useScript(scriptId)
  const today = localDay()
  const { data: todaysTakes } = useRecordings({ script_id: scriptId, day: today })

  const [followCount, setFollowCount] = useState(-1)
  const [recording, setRecording] = useState(false)

  if (isLoading) return <Spinner label="Fetching your passage…" />
  if (!script) {
    return <Card className="p-8 text-center text-ink-soft">That passage seems to have wandered off.</Card>
  }

  return (
    <div
      className={clsx(
        'grid gap-6 lg:grid-cols-[1fr_300px]',
        // Keep the passage clear of the docked recording bar.
        recording && 'pb-56',
      )}
    >
      {/* First in DOM so the recorder leads on mobile; right column on lg. */}
      <aside className="space-y-4 lg:order-2 lg:pt-14">
        <Recorder
          scriptId={scriptId}
          passage={script.body}
          onFollowProgress={setFollowCount}
          onRecordingChange={setRecording}
        />
        <FocusPointsPanel focusPointIds={script.focus_points} />
      </aside>

      <div className="space-y-6 lg:order-1">
        <div className="animate-fade-up">
          <h1 className="font-display text-3xl font-bold tracking-tight text-ink text-balance">
            {script.title}
          </h1>
          {script.attribution && <p className="mt-1 text-xs text-ink-faint">{script.attribution}</p>}
        </div>

        <Card className="p-7 animate-fade-up" style={{ animationDelay: '60ms' }}>
          <PassageText body={script.body} highlightCount={followCount} />
        </Card>

        {todaysTakes && todaysTakes.length > 0 && (
          <Card className="p-5">
            <h2 className="mb-2 px-3 font-display text-sm font-semibold uppercase tracking-wider text-ink-soft">
              Today's takes · {todaysTakes.length}
            </h2>
            <TakeList takes={todaysTakes} />
          </Card>
        )}
      </div>
    </div>
  )
}
