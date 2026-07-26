/**
 * Tidy pasted passage text: PDFs and web pages arrive with hard line
 * wraps, curly quotes, non-breaking spaces, and stray indentation.
 * Paragraph breaks (blank lines) are preserved; everything else is
 * flattened into clean, readable prose.
 */
export function cleanPassageText(text: string): string {
  const normalized = text
    .replace(/[‘’ʼ]/g, "'") // curly apostrophes
    .replace(/[“”]/g, '"') // curly quotes
    .replace(/[–—]/g, ' - ') // en/em dashes
    .replace(/…/g, '...') // ellipsis
    .replace(/[  -  ]/g, ' ') // exotic spaces
    .replace(/[​-‍﻿­]/g, '') // zero-width & soft hyphens
    .replace(/(\w)-\n(\w)/g, '$1$2') // re-join words hyphenated across lines

  return normalized
    .split(/\n\s*\n/) // keep paragraph breaks
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n')
}
