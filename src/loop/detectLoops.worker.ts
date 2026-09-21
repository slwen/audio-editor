import { detectLoopCandidates } from '@/loop/detectLoops'
import type { DetectWorkerRequest, DetectWorkerResponse } from '@/loop/types'

self.onmessage = (e: MessageEvent<DetectWorkerRequest>) => {
  const { requestId, samples, sampleRate, vibeWindowSec } = e.data
  try {
    const result = detectLoopCandidates({ samples, sampleRate, vibeWindowSec })
    const msg: DetectWorkerResponse = { requestId, ok: true, result }
    self.postMessage(msg)
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Loop analysis failed'
    const msg: DetectWorkerResponse = { requestId, ok: false, error }
    self.postMessage(msg)
  }
}
