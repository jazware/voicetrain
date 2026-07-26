import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { clsx } from 'clsx'

const inputStyles =
  'w-full rounded-2xl border border-rose-soft bg-white px-4 py-2.5 text-ink placeholder:text-ink-faint ' +
  'focus:outline-none focus:ring-2 focus:ring-rose/40 focus:border-rose transition-shadow'

export function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-semibold text-ink-soft">
      {children}
    </label>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={clsx(inputStyles, className)} {...props} />
  },
)

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={clsx(inputStyles, 'leading-relaxed', className)} {...props} />
  },
)
