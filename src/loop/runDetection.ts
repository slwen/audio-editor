import { extractMonoForAnalysis } from '@/loop/detectLoops'
import type { DetectLoopsResult, DetectWorkerRequest, DetectWorkerResponse, LoopScores, RescoreWorkerRequest, RescoreWorkerResponse } from '@/loop/types'

let worker: Worker | null = null
let requestId = 0
let source: { buffer: AudioBuffer; trimStart: number; trimEnd: number; requestId: number } | null = null
let rejectDetection: ((error: Error) => void) | null = null
const pendingScores = new Map<number, { resolve: (scores: LoopScores) => void; reject: (error: Error) => void }>()

function rejectPending(error: Error): void {
  rejectDetection?.(error)
  rejectDetection = null
  for (const pending of pendingScores.values()) pending.reject(error)
  pendingScores.clear()
}

export function terminateAnalysisWorker(): void {
  worker?.terminate()
  worker = null
  source = null
  rejectPending(new DOMException('Loop analysis cancelled', 'AbortError'))
}

function sliceTrimChannels(buffer: AudioBuffer, trimStart: number, trimEnd: number): Float32Array[] {
  const sr = buffer.sampleRate
  const a = Math.max(0, Math.floor(trimStart * sr))
  const b = Math.min(buffer.length, Math.max(a + 1, Math.floor(trimEnd * sr)))
  const out: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.push(buffer.getChannelData(c).slice(a, b))
  }
  return out
}

export function analyzeBufferInWorker(
  buffer: AudioBuffer,
  trimStart: number,
  trimEnd: number,
  vibeWindowSec?: number,
  bpmOverride?: number
): Promise<DetectLoopsResult> {
  terminateAnalysisWorker()
  const channels = sliceTrimChannels(buffer, trimStart, trimEnd)
  const prepared = extractMonoForAnalysis(channels, buffer.sampleRate)
  const id = ++requestId
  const w = new Worker(new URL('./detectLoops.worker.ts', import.meta.url), { type: 'module' })
  worker = w

  return new Promise((resolve, reject) => {
    rejectDetection = reject
    w.onmessage = (e: MessageEvent<DetectWorkerResponse | RescoreWorkerResponse>) => {
      if (worker !== w) return
      const msg = e.data
      if ('kind' in msg) {
        const pending = pendingScores.get(msg.requestId)
        pendingScores.delete(msg.requestId)
        if (msg.ok) pending?.resolve(msg.scores)
        else pending?.reject(new Error(msg.error))
        return
      }
      if (msg.requestId !== id) return
      rejectDetection = null
      if (msg.ok) {
        source = { buffer, trimStart, trimEnd, requestId: id }
        resolve(msg.result)
      }
      else reject(new Error(msg.error))
    }
    w.onerror = (ev) => {
      if (worker !== w) return
      source = null
      rejectPending(ev.error instanceof Error ? ev.error : new Error('Loop analysis worker failed'))
    }
    const payload: DetectWorkerRequest = {
      requestId: id,
      samples: prepared.samples,
      sampleRate: prepared.sampleRate,
      vibeWindowSec,
      bpmOverride,
    }
    w.postMessage(payload, [prepared.samples.buffer])
  })
}

/** Reuse the detector's complete source, sample rate and feature-grid origin. */
export function rescoreBufferInWorker(
  buffer: AudioBuffer, trimStart: number, trimEnd: number,
  startSec: number, endSec: number, bpm: number, vibeWindowSec: number
): Promise<LoopScores> {
  if (!worker || source?.buffer !== buffer || source.trimStart !== trimStart || source.trimEnd !== trimEnd) {
    return Promise.reject(new Error('Find loops again before adjusting this region.'))
  }
  const id = ++requestId
  const payload: RescoreWorkerRequest = { kind: 'rescore', requestId: id, sourceRequestId: source.requestId,
    startSec: startSec - trimStart, endSec: endSec - trimStart, bpm, vibeWindowSec }
  return new Promise((resolve, reject) => {
    pendingScores.set(id, { resolve, reject })
    worker!.postMessage(payload)
  })
}
