/**
 * Follow-along: on-device speech recognition (Chrome's built-in Web
 * Speech model, processLocally) aligned against the passage text so
 * the UI can highlight reading progress.
 *
 * Audio never leaves the machine: the feature only runs when the
 * browser confirms local processing is available — there is no
 * cloud fallback by design.
 */

export type FollowAvailability = 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available'

const LANGS = ['en-US']

function speechRecognition(): SpeechRecognitionStatic | undefined {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition
}

/** Can this browser transcribe locally (or fetch the model to do so)? */
export async function followAvailability(): Promise<FollowAvailability> {
  const SR = speechRecognition()
  // Without the availability API we can't guarantee on-device
  // processing, so treat the whole feature as unsupported.
  if (!SR?.available) return 'unsupported'
  try {
    return await SR.available({ langs: LANGS, processLocally: true })
  } catch {
    return 'unsupported'
  }
}

/** Ask the browser to download its local model. Resolves when done. */
export async function installFollowAlong(): Promise<boolean> {
  const SR = speechRecognition()
  if (!SR?.install) return false
  try {
    return await SR.install({ langs: LANGS, processLocally: true })
  } catch {
    return false
  }
}

export interface FollowSession {
  stop(): void
}

/**
 * Start continuous local recognition. onWords receives the FULL list
 * of words heard so far (finals + current interim) on every update.
 */
export function startFollowAlong(onWords: (words: string[]) => void): FollowSession | null {
  const SR = speechRecognition()
  if (!SR) return null

  const recognition = new SR()
  recognition.lang = LANGS[0]
  recognition.continuous = true
  recognition.interimResults = true
  recognition.processLocally = true

  let stopped = false
  // Chrome re-delivers the WHOLE session's results (finalized ones
  // included) on every onresult event, so the session transcript must
  // be rebuilt from scratch each time — appending would duplicate
  // every finalized segment on every event. Words only move into
  // crossSessionFinals when a session ends (Chrome restarts on long
  // silences).
  const crossSessionFinals: string[] = []
  let sessionWords: string[] = []
  let sessionFinalWords: string[] = []

  recognition.onresult = (e) => {
    sessionWords = []
    sessionFinalWords = []
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i]
      const words = splitWords(r[0]?.transcript ?? '')
      sessionWords.push(...words)
      if (r.isFinal) sessionFinalWords.push(...words)
    }
    onWords([...crossSessionFinals, ...sessionWords])
  }

  recognition.onend = () => {
    // Keep only what the session finalized; interim leftovers were
    // never confirmed as speech.
    crossSessionFinals.push(...sessionFinalWords)
    sessionWords = []
    sessionFinalWords = []
    if (!stopped) {
      try {
        recognition.start()
      } catch {
        // Restart raced with teardown; nothing to do.
      }
    }
  }

  recognition.onerror = () => {
    // 'no-speech' and friends precede onend; the restart handles it.
  }

  recognition.start()
  return {
    stop() {
      stopped = true
      recognition.onresult = null
      recognition.onend = null
      recognition.abort()
    },
  }
}

function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean)
}

// ── passage alignment ────────────────────────────────────────────────

const normalize = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, '')

/** Tokenize a passage into normalized words for alignment. */
export function passageTokens(body: string): string[] {
  return body.split(/\s+/).map(normalize).filter(Boolean)
}

// Max words the pointer may skip is LOOKAHEAD - 1.
const LOOKAHEAD = 3

// Function words are everywhere in a passage; letting one trigger a
// skip is how the highlight runs away from the reader. They only
// count when they're exactly the next expected word.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'at', 'is', 'it',
  'as', 'be', 'by', 'was', 'are', 'for', 'with', 'his', 'her', 'its', 'that',
  'this', 'but', 'they', 'have', 'had', 'has', 'not', 'from', 'one', 'all',
  'when', 'which', 'there', 'their', 'them', 'then', 'than', 'these',
  'those', 'will', 'would', 'can', 'could', 'some', 'into', 'upon', 'so',
  'if', 'no', 'we', 'you', 'i', 'he', 'she',
])

function wordsMatch(spoken: string, expected: string): boolean {
  if (spoken === expected) return true
  if (spoken.length >= 4 && expected.length >= 4) {
    return spoken.startsWith(expected) || expected.startsWith(spoken)
  }
  return false
}

/**
 * Greedy monotonic alignment: how many passage tokens have been read,
 * given everything heard so far. Recomputed from scratch each update —
 * cheap at passage scale and self-correcting as interims firm up.
 *
 * Deliberately conservative: advancing to the very next token is
 * free, but skipping is rationed — never on a stopword, one word only
 * for a distinctive match or with confirmation from the following
 * word, two words only WITH confirmation. Better to trail the reader
 * slightly than to sprint ahead of her.
 */
const STALL_THRESHOLD = 3
// Wide enough to recover when the reader deliberately skips a
// sentence; repeated trigrams inside the window only anchor early
// (behind the reader), never ahead, since the first match wins.
const REANCHOR_WINDOW = 24

export function alignWords(spoken: string[], passage: string[]): number {
  const words = spoken.map(normalize).filter(Boolean)
  let position = 0
  let stall = 0
  for (let i = 0; i < words.length && position < passage.length; i++) {
    const word = words[i]
    const limit = Math.min(passage.length, position + LOOKAHEAD)
    let advanced = false
    for (let j = position; j < limit; j++) {
      if (!wordsMatch(word, passage[j])) continue
      if (j === position) {
        position = j + 1
        advanced = true
        break
      }
      if (STOPWORDS.has(word)) continue
      const nextConfirms =
        i + 1 < words.length &&
        j + 1 < passage.length &&
        wordsMatch(words[i + 1], passage[j + 1])
      const skip = j - position
      if ((skip === 1 && (nextConfirms || word.length >= 5)) || (skip === 2 && nextConfirms)) {
        position = j + 1
        advanced = true
        break
      }
      // Unconfirmed skip: leave the pointer alone and let later
      // words resolve it.
    }

    // A mangled phrase can outrun the tight lookahead and stall the
    // pointer for good. After a few fruitless words, accept a trigram
    // (three consecutive matches, not all stopwords) in a wider
    // window — strong enough evidence that false anchors are rare.
    if (!advanced && ++stall >= STALL_THRESHOLD && i + 2 < words.length) {
      const wideLimit = Math.min(passage.length - 2, position + REANCHOR_WINDOW)
      for (let j = position; j < wideLimit; j++) {
        if (
          wordsMatch(words[i], passage[j]) &&
          wordsMatch(words[i + 1], passage[j + 1]) &&
          wordsMatch(words[i + 2], passage[j + 2]) &&
          !(STOPWORDS.has(words[i]) && STOPWORDS.has(words[i + 1]) && STOPWORDS.has(words[i + 2]))
        ) {
          position = j + 3
          i += 2
          advanced = true
          break
        }
      }
    }
    if (advanced) stall = 0
  }
  return position
}
