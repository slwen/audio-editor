import { extractMonoForAnalysis } from '@/loop/detectLoops'
import type { GameSongAnalysis, LoopSuggestion } from './analyze'
import type { AnalysisRequest, AnalysisResponse } from './analysisMessages'
import type { RatedJoin } from './ratings'

type Pending = { resolve: (msg: AnalysisResponse) => void; reject: (error: Error) => void }

let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, Pending>()

function ensureWorker(): Worker {
  if (worker) return worker
  const w = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<AnalysisResponse>) => {
    const p = pending.get(e.data.id)
    pending.delete(e.data.id)
    if (!p) return
    if (e.data.kind === 'error') p.reject(new Error(e.data.error))
    else p.resolve(e.data)
  }
  w.onerror = ev => {
    for (const p of pending.values()) p.reject(ev.error instanceof Error ? ev.error : new Error('Analysis worker failed'))
    pending.clear()
  }
  worker = w
  return w
}

function send(request: AnalysisRequest, transfer: Transferable[] = []): Promise<AnalysisResponse> {
  const w = ensureWorker()
  return new Promise((resolve, reject) => {
    pending.set(request.id, { resolve, reject })
    w.postMessage(request, transfer)
  })
}

function channelsOf(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
}

export async function analyzeStems(base: AudioBuffer, top: AudioBuffer, priors: RatedJoin[]):
  Promise<{ analysis: GameSongAnalysis; suggestions: LoopSuggestion[] }> {
  const b = extractMonoForAnalysis(channelsOf(base), base.sampleRate)
  const t = extractMonoForAnalysis(channelsOf(top), top.sampleRate)
  const msg = await send({ kind: 'analyze', id: ++nextId, base: b.samples, top: t.samples, sampleRate: b.sampleRate, priors },
    [b.samples.buffer, t.samples.buffer])
  if (msg.kind !== 'analyzed') throw new Error('Unexpected analysis reply')
  return { analysis: msg.analysis, suggestions: msg.suggestions }
}

export async function rerankSuggestions(priors: RatedJoin[]): Promise<LoopSuggestion[]> {
  const msg = await send({ kind: 'rank', id: ++nextId, priors })
  if (msg.kind !== 'ranked') throw new Error('Unexpected ranking reply')
  return msg.suggestions
}

export async function scoreWrap(exitSec: number, entrySec: number, fadeSec: number): Promise<number> {
  const msg = await send({ kind: 'score', id: ++nextId, exitSec, entrySec, fadeSec })
  if (msg.kind !== 'scored') throw new Error('Unexpected score reply')
  return msg.pGood
}
