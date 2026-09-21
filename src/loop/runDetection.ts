import { extractMonoForAnalysis } from '@/loop/detectLoops'
import type { DetectLoopsResult, DetectWorkerRequest, DetectWorkerResponse } from '@/loop/types'

let worker: Worker | null = null
let requestId = 0

export function terminateAnalysisWorker(): void {
  worker?.terminate()
  worker = null
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
  vibeWindowSec?: number
): Promise<DetectLoopsResult> {
  terminateAnalysisWorker()
  const channels = sliceTrimChannels(buffer, trimStart, trimEnd)
  const prepared = extractMonoForAnalysis(channels, buffer.sampleRate)
  const id = ++requestId
  const w = new Worker(new URL('./detectLoops.worker.ts', import.meta.url), { type: 'module' })
  worker = w

  return new Promise((resolve, reject) => {
    w.onmessage = (e: MessageEvent<DetectWorkerResponse>) => {
      const msg = e.data
      if (msg.requestId !== id) return
      if (msg.ok) resolve(msg.result)
      else reject(new Error(msg.error))
    }
    w.onerror = (ev) => {
      reject(ev.error instanceof Error ? ev.error : new Error('Loop analysis worker failed'))
    }
    const payload: DetectWorkerRequest = {
      requestId: id,
      samples: prepared.samples,
      sampleRate: prepared.sampleRate,
      vibeWindowSec,
    }
    w.postMessage(payload, [prepared.samples.buffer])
  })
}
