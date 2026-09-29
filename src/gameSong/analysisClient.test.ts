import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { analyzeStems, cancelStemAnalysis } from './analysisClient'
import type { AnalysisRequest, AnalysisResponse } from './analysisMessages'
vi.mock('@/loop/prepareAnalysis', () => ({ prepareAnalysis: vi.fn(async () => ({ samples: new Float32Array(10), sampleRate: 24000 })) }))
class WorkerStub {
  static instance: WorkerStub
  onmessage: ((event: MessageEvent<AnalysisResponse>) => void) | null = null
  onerror: (() => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { WorkerStub.instance = this }
  emit(response: AnalysisResponse) { this.onmessage?.({ data: response } as MessageEvent<AnalysisResponse>) }
}
beforeEach(() => vi.stubGlobal('Worker', WorkerStub))
afterEach(() => { cancelStemAnalysis(); vi.unstubAllGlobals() })
const buffer = { duration: 1 } as AudioBuffer
it('reuses analysis and suggestions for the active version, and reranks changed ratings', async () => {
  const first = analyzeStems(buffer, buffer, [], undefined, 'song:v1')
  await vi.waitFor(() => expect(WorkerStub.instance?.postMessage).toHaveBeenCalled())
  const worker = WorkerStub.instance
  const request = worker.postMessage.mock.calls[0]![0] as AnalysisRequest
  const analysis = { durationSec: 1 } as never
  worker.emit({ kind: 'analyzed', id: request.id, analysis, suggestions: [] })
  await first
  expect(await analyzeStems(buffer, buffer, [], undefined, 'song:v1')).toEqual({ analysis, suggestions: [] })
  expect(worker.postMessage).toHaveBeenCalledOnce()
  const changed = analyzeStems(buffer, buffer, [{ exitSec: 0.9, entrySec: 0.1, rating: 'good' }] as never, undefined, 'song:v1')
  const rank = worker.postMessage.mock.calls[1]![0] as AnalysisRequest
  expect(rank.kind).toBe('rank')
  worker.emit({ kind: 'ranked', id: rank.id, suggestions: [] })
  await changed
  cancelStemAnalysis()
  expect(worker.terminate).toHaveBeenCalledOnce()
})
