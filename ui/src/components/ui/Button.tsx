import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { clsx } from 'clsx'

type Variant = 'primary' | 'soft' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  primary:
    'bg-rose text-white shadow-lifted hover:bg-rose-deep active:scale-[0.98] disabled:bg-ink-faint',
  soft: 'bg-rose-soft text-rose-deep hover:bg-rose-soft/70 active:scale-[0.98]',
  ghost: 'text-ink-soft hover:bg-rose-whisper hover:text-ink active:scale-[0.98]',
  danger: 'bg-transparent text-rose-deep border border-rose-soft hover:bg-rose-whisper',
}

const sizes: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-sm rounded-full',
  md: 'px-5 py-2.5 text-sm rounded-full',
  lg: 'px-7 py-3 text-base rounded-full',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={clsx(
        'inline-flex items-center justify-center gap-2 font-semibold transition-all duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose/50 focus-visible:ring-offset-2 focus-visible:ring-offset-cream',
        'disabled:cursor-not-allowed disabled:opacity-60',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  )
})
