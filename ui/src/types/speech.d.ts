/**
 * Minimal Web Speech API declarations, including the on-device
 * recognition surface added in Chrome 139 (available/install +
 * processLocally). lib.dom doesn't ship these yet.
 */
interface SpeechRecognitionAlternative {
  transcript: string
  confidence: number
}

interface SpeechRecognitionResult {
  readonly length: number
  isFinal: boolean
  [index: number]: SpeechRecognitionAlternative
}

interface SpeechRecognitionResultList {
  readonly length: number
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number
  results: SpeechRecognitionResultList
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string
  message: string
}

interface SpeechRecognition extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  processLocally?: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEvent) => void) | null
  onend: ((e: Event) => void) | null
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null
}

interface SpeechRecognitionOptions {
  langs: string[]
  processLocally?: boolean
}

interface SpeechRecognitionStatic {
  new (): SpeechRecognition
  available?(options: SpeechRecognitionOptions): Promise<
    'unavailable' | 'downloadable' | 'downloading' | 'available'
  >
  install?(options: SpeechRecognitionOptions): Promise<boolean>
}

interface Window {
  SpeechRecognition?: SpeechRecognitionStatic
  webkitSpeechRecognition?: SpeechRecognitionStatic
}
