import { prepareAnalysis } from '@/loop/prepareAnalysis'
import type { GameSongAnalysis, LoopSuggestion } from './analyze'
import type { AnalysisRequest, AnalysisResponse } from './analysisMessages'
import type { RatedJoin } from './ratings'

type Pending = { resolve: (msg: AnalysisResponse) => void; reject: (error: Error) => void }

let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, Pending>()
let cached: { key: string; analysis: GameSongAnalysis; suggestions: LoopSuggestion[]; priorsKey: string } | null = null

export function cancelStemAnalysis(): void {
  worker?.terminate()
  worker = null
  cached = null
  for (const p of pending.values()) p.reject(new DOMException('Stem analysis cancelled', 'AbortError'))
  pending.clear()
}

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
    w.terminate()
    if (worker === w) worker = null
    cached = null
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

export async function analyzeStems(base: AudioBuffer, top: AudioBuffer, priors: RatedJoin[], signal?: AbortSignal, key?: string):
  Promise<{ analysis: GameSongAnalysis; suggestions: LoopSuggestion[] }> {
  signal?.throwIfAborted()
  if (key && cached?.key === key && worker) {
    const analysis = cached.analysis
    const suggestions = cached.priorsKey === JSON.stringify(priors) ? cached.suggestions : await rerankSuggestions(priors)
    signal?.throwIfAborted()
    return { analysis, suggestions }
  }
  cached = null
  const b = await prepareAnalysis(base, 0, base.duration, signal)
  const t = await prepareAnalysis(top, 0, top.duration, signal)
  const msg = await send({ kind: 'analyze', id: ++nextId, base: b.samples, top: t.samples, sampleRate: b.sampleRate, priors },
    [b.samples.buffer, t.samples.buffer])
  if (msg.kind !== 'analyzed') throw new Error('Unexpected analysis reply')
  signal?.throwIfAborted()
  if (key) cached = { key, analysis: msg.analysis, suggestions: msg.suggestions, priorsKey: JSON.stringify(priors) }
  return { analysis: msg.analysis, suggestions: msg.suggestions }
}

export async function rerankSuggestions(priors: RatedJoin[]): Promise<LoopSuggestion[]> {
  const msg = await send({ kind: 'rank', id: ++nextId, priors })
  if (msg.kind !== 'ranked') throw new Error('Unexpected ranking reply')
  if (cached) cached = { ...cached, suggestions: msg.suggestions, priorsKey: JSON.stringify(priors) }
  return msg.suggestions
}

export async function scoreWrap(exitSec: number, entrySec: number, fadeSec: number): Promise<number> {
  const msg = await send({ kind: 'score', id: ++nextId, exitSec, entrySec, fadeSec })
  if (msg.kind !== 'scored') throw new Error('Unexpected score reply')
  return msg.pGood
}
