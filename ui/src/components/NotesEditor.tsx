import { useEffect, useState } from 'react'
import { Textarea } from '@/components/ui/Field'

/**
 * Notes field that saves on blur and whispers confirmation.
 */
export function NotesEditor({
  value,
  onSave,
}: {
  value: string
  onSave: (notes: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => setDraft(value), [value])

  const save = () => {
    if (draft === value) return
    onSave(draft)
    setSavedAt(Date.now())
  }

  useEffect(() => {
    if (savedAt === null) return
    const t = setTimeout(() => setSavedAt(null), 2000)
    return () => clearTimeout(t)
  }, [savedAt])

  return (
    <div>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        placeholder="How did this take feel? Anything you noticed?"
        rows={3}
      />
      <p className="mt-1 h-4 text-right text-xs text-sage">{savedAt && 'saved 🌿'}</p>
    </div>
  )
}
