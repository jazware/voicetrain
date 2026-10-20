import { Fragment, useMemo } from 'react'
import { clsx } from 'clsx'

/**
 * The passage, split into words so follow-along can mark reading
 * progress: read words soften, the next expected word glows gently.
 * highlightCount < 0 renders plain text (follow-along off).
 */
// A reading measure of ~65 characters, sized for reading aloud from
// arm's length.
const PASSAGE = 'max-w-[65ch] whitespace-pre-wrap font-body text-[1.15rem] leading-[1.9] sm:text-[1.25rem]'

export function PassageText({
  body,
  highlightCount = -1,
}: {
  body: string
  highlightCount?: number
}) {
  const segments = useMemo(() => body.split(/(\s+)/), [body])

  if (highlightCount < 0) {
    return <p className={clsx(PASSAGE, 'text-ink')}>{body}</p>
  }

  let wordIndex = 0
  return (
    <p className={PASSAGE}>
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
