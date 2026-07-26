import { Heart } from 'lucide-react'
import { clsx } from 'clsx'

/**
 * 1–5 hearts. Clicking the current rating clears it — feelings change.
 */
export function RatingHearts({
  value,
  onChange,
  size = 22,
}: {
  value: number | null
  onChange: (rating: number | null) => void
  size?: number
}) {
  return (
    <div className="flex items-center gap-0.5" role="radiogroup" aria-label="How did it feel?">
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = value !== null && n <= value
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} of 5 hearts`}
            onClick={() => onChange(value === n ? null : n)}
            className="group rounded-full p-1 transition-transform hover:scale-110 active:scale-95"
          >
            <Heart
              size={size}
              className={clsx(
                'transition-colors',
                filled
                  ? 'fill-rose text-rose'
                  : 'fill-transparent text-ink-faint group-hover:text-rose',
              )}
            />
          </button>
        )
      })}
    </div>
  )
}
