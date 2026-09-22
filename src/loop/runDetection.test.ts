import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { analyzeBufferInWorker, rescoreBufferInWorker, terminateAnalysisWorker } from './runDetection'
import type { DetectWorkerResponse, RescoreWorkerResponse } from './types'

class WorkerStub {
  static instances: WorkerStub[] = []
  onmessage: ((e: MessageEvent<DetectWorkerResponse | RescoreWorkerResponse>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { WorkerStub.instances.push(this) }
  emit(data: DetectWorkerResponse | RescoreWorkerResponse) { this.onmessage?.({ data } as MessageEvent<typeof data>) }
}
const result = { bpm: 120, beatOffsetSec: 0, candidates: [] }
const buffer = { sampleRate: 48000, length: 480000, numberOfChannels: 1,
  getChannelData: () => new Float32Array(480000) } as unknown as AudioBuffer
beforeEach(() => { WorkerStub.instances = []; vi.stubGlobal('Worker', WorkerStub) })
afterEach(() => { terminateAnalysisWorker(); vi.unstubAllGlobals() })

it('keeps source-relative trim coordinates and routes each edit response to its caller', async () => {
  const detection = analyzeBufferInWorker(buffer, 1, 9, 1.5, 120)
  const worker = WorkerStub.instances[0]!
  const payload = worker.postMessage.mock.calls[0]![0]
  expect(payload.sampleRate).toBe(24000)
  expect(payload.samples).toHaveLength(192000)
  worker.emit({ requestId: payload.requestId, ok: true, result })
  await detection
  const pending = rescoreBufferInWorker(buffer, 1, 9, 2, 6, 120, 1.5)
  const request = worker.postMessage.mock.calls[1]![0]
  expect(request).toMatchObject({ kind: 'rescore', sourceRequestId: payload.requestId, startSec: 1, endSec: 5 })
  const scores = { qualityScore: 0.8, contextScore: 0.9, homogeneityScore: 0.95, seamScore: 0.85 }
  worker.emit({ kind: 'rescore', requestId: request.requestId, ok: true, scores })
  expect(await pending).toEqual(scores)
  await expect(rescoreBufferInWorker(buffer, 0, 9, 2, 6, 120, 1.5)).rejects.toThrow('Find loops again')
})

it('settles cancelled analysis and edits instead of leaving promises pending or accepting stale sources', async () => {
  const first = analyzeBufferInWorker(buffer, 0, 9)
  const firstCheck = expect(first).rejects.toMatchObject({ name: 'AbortError' })
  const oldWorker = WorkerStub.instances[0]!
  const oldRequest = oldWorker.postMessage.mock.calls[0]![0]
  const next = analyzeBufferInWorker(buffer, 1, 9)
  await firstCheck
  oldWorker.emit({ requestId: oldRequest.requestId, ok: true, result })
  await expect(rescoreBufferInWorker(buffer, 0, 9, 2, 6, 120, 1.5)).rejects.toThrow('Find loops again')
  const worker = WorkerStub.instances[1]!
  worker.emit({ requestId: worker.postMessage.mock.calls[0]![0].requestId, ok: true, result })
  await next
  const edit = rescoreBufferInWorker(buffer, 1, 9, 2, 6, 120, 1.5)
  const editCheck = expect(edit).rejects.toMatchObject({ name: 'AbortError' })
  terminateAnalysisWorker()
  await editCheck
  expect(oldWorker.terminate).toHaveBeenCalledOnce()
})
