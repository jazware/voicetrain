import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Mic, Pencil, Plus, Sparkles } from 'lucide-react'
import { useHeatmap, useScripts } from '@/hooks/queries'
import { Heatmap } from '@/components/Heatmap'
import { greeting, formatDay } from '@/lib/format'
import { focusPointById } from '@/lib/focusPoints'
import type { Script } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { ScriptFormDialog } from '@/components/ScriptFormDialog'

function ScriptCard({ script, onEdit, index }: { script: Script; onEdit: () => void; index: number }) {
  return (
    <Card
      className="group relative flex flex-col p-6 transition-all duration-300 hover:shadow-cozy-lg hover:-translate-y-0.5 animate-fade-up"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="font-display text-lg font-semibold leading-snug text-ink text-balance">
          {script.title}
        </h3>
        <button
          onClick={onEdit}
          aria-label={`Edit ${script.title}`}
          className="rounded-full p-2 text-ink-faint opacity-0 transition-all hover:bg-rose-whisper hover:text-ink group-hover:opacity-100"
        >
          <Pencil size={15} />
        </button>
      </div>

      <p className="mb-4 line-clamp-2 text-sm leading-relaxed text-ink-soft">{script.body}</p>

      <div className="mb-5 flex flex-wrap gap-1.5">
        {script.focus_points.map((id) => {
          const fp = focusPointById.get(id)
          if (!fp) return null
          return (
            <span
              key={id}
              className="rounded-full bg-lavender-soft px-2.5 py-0.5 text-xs font-semibold text-ink-soft"
            >
              {fp.emoji} {fp.title}
            </span>
          )
        })}
      </div>

      <div className="mt-auto flex items-center justify-between">
        <div className="text-xs text-ink-faint">
          {script.take_count > 0 ? (
            <>
              {script.take_count} {script.take_count === 1 ? 'take' : 'takes'}
              {script.last_practiced_day && <> · last {formatDay(script.last_practiced_day)}</>}
            </>
          ) : (
            <span className="inline-flex items-center gap-1">
              <Sparkles size={12} /> waiting for its first take
            </span>
          )}
        </div>
        <Link to={`/practice/${script.id}`}>
          <Button size="sm">
            <Mic size={14} /> Practice
          </Button>
        </Link>
      </div>
    </Card>
  )
}

export function ScriptsPage() {
  const { data: scripts, isLoading, error } = useScripts()
  const { data: recentDays } = useHeatmap()
  const [editing, setEditing] = useState<Script | null>(null)
  const [creating, setCreating] = useState(false)

  return (
    <div>
      <div className="mb-6 mt-2 flex flex-wrap items-end justify-between gap-4 animate-fade-up">
        <div>
          <h1 className="font-display text-4xl font-bold tracking-tight text-ink">{greeting()} 🌸</h1>
          <p className="mt-2 text-ink-soft">
            Pick a passage and give your voice a little love today.
          </p>
        </div>
        {recentDays && recentDays.some((d) => d.count > 0) && (
          <Link
            to="/history"
            className="rounded-2xl p-2 transition-colors hover:bg-rose-whisper"
            aria-label="See your practice history"
          >
            <Heatmap days={recentDays} weeks={16} />
          </Link>
        )}
      </div>

      {isLoading && <Spinner label="Gathering your passages…" />}
      {error && (
        <Card className="p-6 text-center text-ink-soft">
          Couldn't reach the backend — is <code className="text-rose-deep">just dev</code> running?
        </Card>
      )}

      {scripts && (
        <div className="grid gap-5 sm:grid-cols-2">
          {scripts.map((script, i) => (
            <ScriptCard key={script.id} script={script} index={i} onEdit={() => setEditing(script)} />
          ))}

          <button
            onClick={() => setCreating(true)}
            className="flex min-h-[180px] flex-col items-center justify-center gap-3 rounded-cozy border-2 border-dashed border-rose-soft text-ink-soft transition-all hover:border-rose hover:bg-rose-whisper hover:text-rose-deep animate-fade-up"
            style={{ animationDelay: `${scripts.length * 60}ms` }}
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-rose-soft text-rose-deep">
              <Plus size={20} />
            </span>
            <span className="text-sm font-semibold">Add your own passage</span>
          </button>
        </div>
      )}

      <ScriptFormDialog
        open={creating}
        onClose={() => setCreating(false)}
        script={null}
      />
      <ScriptFormDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        script={editing}
      />
    </div>
  )
}
