import type { PitchFrame } from './yin.ts'

/** Messages from the page to the live-analysis worker. */
export type WorkerIn =
  | { type: 'start'; sampleRate: number; port: MessagePort }
  | { type: 'finish' }

/** Messages from the live-analysis worker to the page. */
export type WorkerOut =
  | { type: 'ready'; frameLag: number; peakSeconds: number }
  | {
      type: 'update'
      /** Seconds of audio received so far. */
      time: number
      frames: PitchFrame[]
      /** Interleaved [min, max] pairs, one per peakSeconds of audio. */
      peaks: number[]
    }
  | { type: 'wav'; wav: ArrayBuffer }
