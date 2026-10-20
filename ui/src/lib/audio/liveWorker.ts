/**
 * Live-analysis worker: receives the mic's PCM straight from the
 * recorder worklet and runs a LiveAnalyzer on it, so pitch tracking,
 * peaks and WAV encoding never run on the page's main thread.
 */
import { LiveAnalyzer, PEAK_S } from './liveAnalyzer.ts'
import type { WorkerIn, WorkerOut } from './liveProtocol.ts'

// The project compiles against the DOM lib; a worker's postMessage
// takes a transfer list where window's takes a target origin.
const scope = self as unknown as { postMessage(msg: WorkerOut, transfer: Transferable[]): void }
const post = (msg: WorkerOut, transfer: Transferable[] = []) => scope.postMessage(msg, transfer)

let analyzer: LiveAnalyzer | null = null

function finish() {
  if (!analyzer) return
  const wav = analyzer.finish()
  analyzer = null
  post({ type: 'wav', wav }, [wav])
}

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const msg = e.data
  if (msg.type === 'start') {
    analyzer = new LiveAnalyzer(msg.sampleRate)
    post({ type: 'ready', frameLag: analyzer.tracker.frameLag, peakSeconds: PEAK_S })
    msg.port.onmessage = (ev: MessageEvent<{ type: 'pcm'; pcm: Float32Array } | { type: 'end' }>) => {
      if (ev.data.type === 'end') finish()
      else if (analyzer) post(analyzer.push(ev.data.pcm))
    }
  } else if (msg.type === 'finish') {
    // Fallback when the worklet's end marker never arrives.
    finish()
  }
}
