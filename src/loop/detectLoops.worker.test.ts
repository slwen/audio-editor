import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DetectWorkerRequest, RescoreWorkerRequest } from './types'

const detect = vi.hoisted(() => vi.fn(() => ({ bpm: 137, beatOffsetSec: 0, candidates: [] })))
const features = vi.hoisted(() => vi.fn(() => ({ frames: [], hopSec: 256 / 24000, flux: new Float32Array() })))
const score = vi.hoisted(() => vi.fn(() => ({ qualityScore: 0.8 })))
vi.mock('@/loop/detectLoops', () => ({ detectLoopCandidates: detect, extractHopFeatures: features, scoreLoopWindow: score }))
beforeEach(() => { vi.resetModules(); vi.clearAllMocks() })
afterEach(() => vi.unstubAllGlobals())

it('honors a user tempo correction when crossing the worker boundary', async () => {
  const scope = { onmessage: null as ((event: MessageEvent<DetectWorkerRequest>) => void) | null,
    postMessage: vi.fn() }
  vi.stubGlobal('self', scope)
  await import('./detectLoops.worker')
  const request: DetectWorkerRequest = {
    requestId: 7, samples: new Float32Array(100), sampleRate: 24000,
    vibeWindowSec: 2, bpmOverride: 137,
  }
  scope.onmessage!(new MessageEvent('message', { data: request }))
  expect(detect).toHaveBeenCalledWith({ samples: request.samples, sampleRate: 24000,
    vibeWindowSec: 2, bpmOverride: 137 })
  expect(scope.postMessage).toHaveBeenCalledWith({ requestId: 7, ok: true,
    result: { bpm: 137, beatOffsetSec: 0, candidates: [] } })
})

it('rescores edits on the complete original analysis source and reuses its feature grid', async () => {
  const scope = { onmessage: null as ((event: MessageEvent<DetectWorkerRequest | RescoreWorkerRequest>) => void) | null,
    postMessage: vi.fn() }
  vi.stubGlobal('self', scope)
  await import('./detectLoops.worker')
  const source: DetectWorkerRequest = { requestId: 8, samples: new Float32Array(240000), sampleRate: 24000 }
  scope.onmessage!(new MessageEvent('message', { data: source }))
  for (const requestId of [9, 10]) scope.onmessage!(new MessageEvent('message', {
    data: { kind: 'rescore', requestId, sourceRequestId: 8, startSec: 2, endSec: 8, bpm: 120, vibeWindowSec: 1.5 },
  }))
  expect(features).toHaveBeenCalledTimes(1)
  expect(features).toHaveBeenCalledWith(source.samples, 24000)
  expect(score).toHaveBeenLastCalledWith(source.samples, 24000, 2, 8, 120, [], 256 / 24000, 1.5)
  scope.onmessage!(new MessageEvent('message', {
    data: { kind: 'rescore', requestId: 11, sourceRequestId: 7, startSec: 2, endSec: 8, bpm: 120, vibeWindowSec: 1.5 },
  }))
  expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 11, ok: false }))
  expect(score).toHaveBeenCalledTimes(2)
})
