import { Fragment, useMemo } from 'react'
import { clsx } from 'clsx'

/**
 * The passage, split into words so follow-along can mark reading
 * progress: read words soften, the next expected word glows gently.
 * highlightCount < 0 renders plain text (follow-along off).
 */
export function PassageText({
  body,
  highlightCount = -1,
}: {
  body: string
  highlightCount?: number
}) {
  const segments = useMemo(() => body.split(/(\s+)/), [body])

  if (highlightCount < 0) {
    return <p className="whitespace-pre-wrap font-body text-lg leading-loose text-ink">{body}</p>
  }

  let wordIndex = 0
  return (
    <p className="whitespace-pre-wrap font-body text-lg leading-loose">
      {segments.map((segment, i) => {
        if (/^\s*$/.test(segment)) return <Fragment key={i}>{segment}</Fragment>
        const idx = wordIndex++
        const read = idx < highlightCount
        const current = idx === highlightCount
        return (
          <span
            key={i}
            className={clsx(
              'transition-colors duration-200',
              read && 'text-ink-faint',
              current && 'rounded-md bg-lavender-soft px-0.5 -mx-0.5 text-ink',
              !read && !current && 'text-ink',
            )}
          >
            {segment}
          </span>
        )
      })}
    </p>
  )
}
