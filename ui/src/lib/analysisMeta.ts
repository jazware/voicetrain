import type { Analysis } from '@/lib/api'

/**
 * Shared meaning for the analysis events: colors (validated for CVD
 * separation and contrast on the card surface), labels, and the short
 * human phrasing used by chips and waveform regions. Identity is never
 * color-alone — every chip carries its label text.
 */
export interface EventKindMeta {
  label: string
  emoji: string
  /** Deep solid: chip dots, region borders. */
  color: string
  /** Translucent fill for waveform regions. */
  fill: string
  describe(payload: Record<string, number | null>): string
}

export const EVENT_KINDS: Record<string, EventKindMeta> = {
  fry: {
    label: 'Creaky dip',
    emoji: '🐸',
    color: '#7857BC',
    fill: 'rgba(120, 87, 188, 0.16)',
    describe: (p) => (p.median_hz ? `slipped down to ~${Math.round(p.median_hz)} Hz` : 'slipped into fry'),
  },
  monotone: {
    label: 'Flat stretch',
    emoji: '➖',
    color: '#BC7412',
    fill: 'rgba(188, 116, 18, 0.14)',
    describe: (p) =>
      p.range_st ? `melody stayed within ${p.range_st} semitones` : 'melody went flat here',
  },
  long_phrase: {
    label: 'Long breath',
    emoji: '🌬️',
    color: '#3F8A3F',
    fill: 'rgba(63, 138, 63, 0.14)',
    describe: (p) =>
      p.duration_s ? `${p.duration_s}s on a single breath` : 'a long stretch without a breath',
  },
}

export const FALLBACK_KIND: EventKindMeta = {
  label: 'Moment',
  emoji: '✨',
  color: '#A48FCB',
  fill: 'rgba(164, 143, 203, 0.18)',
  describe: () => 'something worth a listen',
}

export const kindMeta = (kind: string): EventKindMeta => EVENT_KINDS[kind] ?? FALLBACK_KIND

// ── coaching copy ────────────────────────────────────────────────────
// Warm but honest: interpretations state what the numbers suggest and
// which way to nudge, never scores or grades.

export function pitchNote(a: Analysis): string {
  const { median_hz, pct_in_band, fry_pct } = a.pitch
  if (median_hz === null) return 'We couldn’t hear a voice in this one.'
  const parts: string[] = []
  if (median_hz >= a.target_min_hz && median_hz <= a.target_max_hz) {
    parts.push('Your median sat right inside the target band 🌸')
  } else if (median_hz < a.target_min_hz) {
    parts.push(`Median ${Math.round(a.target_min_hz - median_hz)} Hz below the band — climbing with practice`)
  } else {
    parts.push('Median floated above the band — plenty of headroom')
  }
  if (fry_pct !== null && fry_pct >= 8) {
    parts.push('quite a bit of creak crept in; the marked dips are worth a listen')
  } else if (fry_pct !== null && fry_pct >= 2) {
    parts.push('a little fry here and there, mostly at phrase ends')
  }
  if (pct_in_band !== null && pct_in_band >= 50) parts.push('over half the take in band — lovely!')
  return parts.join('. ') + '.'
}

export function melodyNote(a: Analysis): string {
  const { semitone_sd, phrase_endings: e } = a.melody
  if (semitone_sd === null) return 'Not enough voiced speech to read the melody.'
  let movement: string
  if (semitone_sd < 1.5) movement = 'The melody stayed quite flat — try letting phrases swing more'
  else if (semitone_sd < 3) movement = 'Gentle melodic movement'
  else if (semitone_sd < 5) movement = 'A lovely musical swing to this one'
  else movement = 'Very expressive, big melodic sweeps'
  const total = e.rising + e.falling + e.flat
  if (total >= 4 && e.falling > 2 * (e.rising + 1)) {
    return `${movement}. Most phrase endings land downward — floating a few upward adds sparkle.`
  }
  if (total >= 4 && e.rising >= e.falling) {
    return `${movement}, with a nice share of rising endings.`
  }
  return `${movement}.`
}

export function breathNote(a: Analysis): string {
  const { mean_phrase_s, articulation_rate_sps } = a.breath
  if (mean_phrase_s === null) return 'No phrases detected.'
  let pacing: string
  if (mean_phrase_s < 2) pacing = 'Short, comfy breath groups'
  else if (mean_phrase_s < 4.5) pacing = 'Comfortable phrase lengths'
  else pacing = 'Long stretches between breaths — sneaking in more small breaths keeps the ends supported'
  if (articulation_rate_sps !== null && articulation_rate_sps > 5.5) {
    return `${pacing}, though the pace ran quick — slowing down leaves room for melody.`
  }
  return `${pacing}.`
}

export function weightNote(a: Analysis): string {
  const { cpps_db } = a.weight
  if (cpps_db === null) return 'Not enough signal to judge this one.'
  return 'Clarity and smoothness measures — most meaningful as a trend across takes, not one number.'
}

export function resonanceNote(): string {
  return 'Shorter estimated tract length ≈ brighter, more forward placement. Noisy per-take; trust the trend.'
}
