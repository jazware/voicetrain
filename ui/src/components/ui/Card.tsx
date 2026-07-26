import { type HTMLAttributes } from 'react'
import { clsx } from 'clsx'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx('rounded-cozy bg-card shadow-cozy border border-rose-whisper', className)}
      {...props}
    />
  )
}
