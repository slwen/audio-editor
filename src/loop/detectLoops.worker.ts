import { detectLoopCandidates, extractHopFeatures, scoreLoopWindow } from '@/loop/detectLoops'
import type { DetectWorkerRequest, DetectWorkerResponse, RescoreWorkerRequest, RescoreWorkerResponse } from '@/loop/types'

let source: DetectWorkerRequest | null = null
let features: ReturnType<typeof extractHopFeatures> | null = null

self.onmessage = (e: MessageEvent<DetectWorkerRequest | RescoreWorkerRequest>) => {
  if ('kind' in e.data) {
    const request = e.data
    try {
      if (!source || source.requestId !== request.sourceRequestId) throw new Error('Analysis source changed. Find loops again before editing.')
      features ??= extractHopFeatures(source.samples, source.sampleRate)
      const scores = scoreLoopWindow(source.samples, source.sampleRate, request.startSec, request.endSec,
        request.bpm, features.frames, features.hopSec, request.vibeWindowSec)
      const msg: RescoreWorkerResponse = { kind: 'rescore', requestId: request.requestId, ok: true, scores }
      self.postMessage(msg)
    } catch (err) {
      const msg: RescoreWorkerResponse = { kind: 'rescore', requestId: request.requestId, ok: false,
        error: err instanceof Error ? err.message : 'Could not score this region' }
      self.postMessage(msg)
    }
    return
  }
  const { requestId, samples, sampleRate, vibeWindowSec, bpmOverride } = e.data
  try {
    source = null
    features = null
    const result = detectLoopCandidates({ samples, sampleRate, vibeWindowSec, bpmOverride })
    source = e.data
    const msg: DetectWorkerResponse = { requestId, ok: true, result }
    self.postMessage(msg)
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Loop analysis failed'
    const msg: DetectWorkerResponse = { requestId, ok: false, error }
    self.postMessage(msg)
  }
}
