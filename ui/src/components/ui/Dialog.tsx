import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  /** Max width utility class, defaults to a comfortable form width. */
  widthClass?: string
}

export function Dialog({ open, onClose, title, children, widthClass = 'max-w-xl' }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/25 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full ${widthClass} max-h-[88vh] overflow-y-auto rounded-cozy bg-card shadow-cozy-lg animate-fade-up`}
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-1">
          <h2 className="font-display text-xl font-semibold text-ink">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-2 text-ink-soft hover:bg-rose-whisper hover:text-ink transition-colors"
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-6 pb-6">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
