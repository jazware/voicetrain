import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { clsx } from 'clsx'
import { focusPointById } from '@/lib/focusPoints'

/**
 * Collapsible coaching cards for the focus points attached to a script.
 */
export function FocusPointsPanel({ focusPointIds }: { focusPointIds: string[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const points = focusPointIds
    .map((id) => focusPointById.get(id))
    .filter((fp): fp is NonNullable<typeof fp> => fp !== undefined)

  if (points.length === 0) return null

  return (
    <div className="space-y-2">
      <h3 className="px-1 font-display text-sm font-semibold uppercase tracking-wider text-ink-soft">
        While you practice
      </h3>
      {points.map((fp) => {
        const open = openId === fp.id
        return (
          <div
            key={fp.id}
            className="overflow-hidden rounded-2xl border border-lavender-soft bg-card shadow-lifted"
          >
            <button
              onClick={() => setOpenId(open ? null : fp.id)}
              aria-expanded={open}
              className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-lavender-soft/30"
            >
              <span className="flex items-center gap-2 font-semibold text-ink">
                <span aria-hidden>{fp.emoji}</span> {fp.title}
              </span>
              <ChevronDown
                size={16}
                className={clsx('shrink-0 text-ink-faint transition-transform', open && 'rotate-180')}
              />
            </button>
            {open && (
              <div className="space-y-2 px-4 pb-4 animate-fade-up">
                <p className="text-sm leading-relaxed text-ink-soft">{fp.summary}</p>
                <ul className="space-y-1.5">
                  {fp.cues.map((cue, i) => (
                    <li key={i} className="flex gap-2 text-sm leading-relaxed text-ink">
                      <span className="mt-0.5 text-lavender" aria-hidden>
                        ✦
                      </span>
                      {cue}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
