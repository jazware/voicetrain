/**
 * The coaching library for feminizing voice training. Scripts store a
 * list of ids; the copy here can evolve freely without touching the DB.
 */
export interface FocusPoint {
  id: string
  title: string
  emoji: string
  summary: string
  cues: string[]
}

export const FOCUS_POINTS: FocusPoint[] = [
  {
    id: 'pitch',
    title: 'Pitch',
    emoji: '🎵',
    summary:
      'A comfortable feminine speaking range usually sits around 165–220 Hz, but consistency and comfort matter far more than hitting a number.',
    cues: [
      'Find your target with a gentle hum, then slide into words without pushing.',
      'Aim for a pitch you can hold all day without strain — sustainable beats impressive.',
      'If your throat feels tight or achy, drop a little lower and rebuild from comfort.',
      'Gaps in the pitch trace during consonants are completely normal.',
    ],
  },
  {
    id: 'resonance',
    title: 'Resonance',
    emoji: '✨',
    summary:
      'Resonance is the real heart of feminine voice — a smaller, brighter sound made forward in the mouth rather than deep in the chest.',
    cues: [
      'Think "small mouth, big smile": raise the larynx gently, brighten the vowels.',
      'Feel the buzz behind your front teeth and lips, not in your chest.',
      'Try a tiny "mmm-hmm?" like agreeing enthusiastically — that placement is the goal.',
      'Yawning is the opposite of what you want; a gentle swallow resets a raised larynx.',
    ],
  },
  {
    id: 'intonation',
    title: 'Intonation & melody',
    emoji: '🌊',
    summary:
      'Feminine speech tends to use a wider, more musical melody — more movement up and down, livelier emphasis, softer endings.',
    cues: [
      'Let your pitch dance: emphasize words by gliding up rather than getting louder.',
      'Try ending statements with a gentle rise-fall rather than a flat drop.',
      'Read a sentence as if delighted by it, then keep that shape at normal enthusiasm.',
      'Record and listen for monotone stretches — melody fades when concentrating.',
    ],
  },
  {
    id: 'weight',
    title: 'Vocal weight',
    emoji: '🪶',
    summary:
      'Vocal weight is how "heavy" or "buzzy" the voice sounds. Lighter fold contact reads feminine — think gentle and clear, not whispery.',
    cues: [
      'Speak as if soothing a nervous kitten: soft onset, light touch.',
      'Avoid breathiness as a crutch — light and clear, not airy and faint.',
      'Start words with gentle airflow instead of a hard glottal hit.',
      'If the sound gets growly or creaky, add a touch more air and energy.',
    ],
  },
  {
    id: 'articulation',
    title: 'Articulation',
    emoji: '💬',
    summary:
      'Crisper, lighter consonants and slightly more precise vowels lift the whole impression of the voice.',
    cues: [
      'Let consonants land on the tip of the tongue — delicate, not forceful.',
      'Open vowels a touch more than feels natural; clarity reads as brightness.',
      'Slow down 10% — precision is easier and sounds more graceful at an easy pace.',
    ],
  },
  {
    id: 'breath',
    title: 'Breath & pacing',
    emoji: '🌬️',
    summary:
      'Steady, easy breath support keeps every other element stable — and gives you natural, unhurried phrasing.',
    cues: [
      'Breathe low into your belly; shoulders stay soft and still.',
      'Take smaller, more frequent breaths at natural phrase boundaries.',
      'If pitch sags at the ends of sentences, it is usually breath running out.',
      'A relaxed sigh before you start releases throat tension beautifully.',
    ],
  },
]

export const focusPointById = new Map(FOCUS_POINTS.map((fp) => [fp.id, fp]))
