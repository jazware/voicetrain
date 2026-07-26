import { useEffect, useState } from 'react'
import { clsx } from 'clsx'
import { Trash2, Wand2 } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input, Label, Textarea } from '@/components/ui/Field'
import { cleanPassageText } from '@/lib/cleanText'
import { FOCUS_POINTS } from '@/lib/focusPoints'
import { useCreateScript, useDeleteScript, useUpdateScript } from '@/hooks/queries'
import type { Script } from '@/lib/api'

export interface ScriptFormDialogProps {
  open: boolean
  onClose: () => void
  /** null = create a new script */
  script: Script | null
}

export function ScriptFormDialog({ open, onClose, script }: ScriptFormDialogProps) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [focusPoints, setFocusPoints] = useState<string[]>([])
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const createScript = useCreateScript()
  const updateScript = useUpdateScript()
  const deleteScript = useDeleteScript()
  const busy = createScript.isPending || updateScript.isPending || deleteScript.isPending

  useEffect(() => {
    if (!open) return
    setTitle(script?.title ?? '')
    setBody(script?.body ?? '')
    // New scripts start with every focus point — gentle nudge to explore.
    setFocusPoints(script?.focus_points ?? FOCUS_POINTS.map((fp) => fp.id))
    setConfirmingDelete(false)
  }, [open, script])

  const toggleFocusPoint = (id: string) =>
    setFocusPoints((current) =>
      current.includes(id) ? current.filter((v) => v !== id) : [...current, id],
    )

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const params = { title: title.trim(), body: body.trim(), focus_points: focusPoints }
    if (script) {
      await updateScript.mutateAsync({ id: script.id, params })
    } else {
      await createScript.mutateAsync(params)
    }
    onClose()
  }

  const removeScript = async () => {
    if (!script) return
    await deleteScript.mutateAsync(script.id)
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={script ? 'Edit passage' : 'A new passage to practice'}
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="script-title">Title</Label>
          <Input
            id="script-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. My favorite poem"
            required
            maxLength={200}
          />
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label htmlFor="script-body" className="text-sm font-semibold text-ink-soft">
              Passage text
            </label>
            <button
              type="button"
              onClick={() => setBody(cleanPassageText(body))}
              disabled={!body.trim()}
              title="Unwrap pasted line breaks, straighten quotes, and collapse extra spaces (paragraph breaks are kept)"
              className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold text-ink-faint transition-colors hover:bg-lavender-soft hover:text-ink disabled:opacity-40"
            >
              <Wand2 size={12} /> Tidy formatting
            </button>
          </div>
          <Textarea
            id="script-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Paste or write the text you'd like to read aloud…"
            required
            rows={8}
          />
        </div>

        <div>
          <Label>Focus areas to show while practicing</Label>
          <div className="flex flex-wrap gap-2">
            {FOCUS_POINTS.map((fp) => {
              const active = focusPoints.includes(fp.id)
              return (
                <button
                  key={fp.id}
                  type="button"
                  onClick={() => toggleFocusPoint(fp.id)}
                  aria-pressed={active}
                  className={clsx(
                    'rounded-full px-3 py-1.5 text-sm font-semibold transition-all',
                    active
                      ? 'bg-lavender-soft text-ink shadow-lifted'
                      : 'bg-transparent text-ink-faint border border-rose-soft hover:text-ink-soft',
                  )}
                >
                  {fp.emoji} {fp.title}
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex items-center justify-between pt-2">
          {script && !script.is_seeded ? (
            confirmingDelete ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-ink-soft">Really remove it?</span>
                <Button type="button" variant="danger" size="sm" onClick={removeScript} disabled={busy}>
                  Yes, remove
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>
                  Keep it
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmingDelete(true)}
                className="text-ink-faint"
              >
                <Trash2 size={14} /> Remove
              </Button>
            )
          ) : script?.is_seeded ? (
            <span className="text-xs text-ink-faint">A classic — edits are welcome ✨</span>
          ) : (
            <span />
          )}

          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !title.trim() || !body.trim()}>
              {script ? 'Save changes' : 'Add passage'}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}
