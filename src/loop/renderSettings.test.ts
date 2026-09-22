import { afterEach, expect, it } from 'vitest'
import { useLoopStore } from '@/store/useLoopStore'
import { loopRenderOptions } from './renderSettings'
import type { LoopCandidate } from './types'

const a: LoopCandidate = { id: 'a', startSec: 8, endSec: 16, bars: 4, bpm: 120,
  seamScore: 0.9, contextScore: 0.9, homogeneityScore: 0.95, qualityScore: 0.8 }
const b: LoopCandidate = { ...a, id: 'b', startSec: 24, endSec: 40, bars: 8 }
const session = { sourceClipId: 'clip', bufferId: 'buffer', sourceName: 'song.wav', trimStart: 0, trimEnd: 60 }
afterEach(() => { useLoopStore.getState().clear(); useLoopStore.getState().replaceRatings([]) })

it('retains each cut’s blend through selection, multi-selection and new candidate IDs', () => {
  const store = useLoopStore.getState()
  store.startSession(session)
  store.setResults({ bpm: 120, beatOffsetSec: 0, candidates: [a, b] })
  store.setWrapCrossfadeSec(0.5)
  store.setNormalizeExport(true)
  store.toggleSelected('b')
  expect(useLoopStore.getState().wrapCrossfadeSec).toBe(0.035)
  expect(useLoopStore.getState().normalizeExport).toBe(false)
  store.setWrapCrossfadeSec(0)
  const state = useLoopStore.getState()
  expect(loopRenderOptions(state, a)).toEqual({ wrapCrossfadeSec: 0.5, normalize: true })
  expect(loopRenderOptions(state, b)).toEqual({ wrapCrossfadeSec: 0, normalize: false })
  store.setResults({ bpm: 120, beatOffsetSec: 0, candidates: [{ ...a, id: 'new-a' }, b] })
  expect(useLoopStore.getState().wrapCrossfadeSec).toBe(0.5)
  store.patchCandidate('new-a', { startSec: 8.5, endSec: 16.5 })
  const edited = useLoopStore.getState().candidates[0]!
  expect(loopRenderOptions(useLoopStore.getState(), edited).wrapCrossfadeSec).toBe(0.5)
})

it('preserves a saved cut’s rendering until explicitly changed, independently of the selected cut', () => {
  const store = useLoopStore.getState()
  store.startSession(session)
  store.replaceRatings([{ ...a, at: '2026-09-22T00:00:00Z', sourceName: session.sourceName,
    vibeWindowSec: 1.5, rating: 'good', wrapCrossfadeSec: 0.2, normalize: true }])
  store.setResults({ bpm: 120, beatOffsetSec: 0, candidates: [b] })
  const saved = useLoopStore.getState().candidates.find(c => c.origin === 'saved')!
  expect(loopRenderOptions(useLoopStore.getState(), saved)).toEqual({ wrapCrossfadeSec: 0.2, normalize: true })
  store.setPreviewId(saved.id)
  store.setWrapCrossfadeSec(0.5)
  store.setPreviewId(b.id)
  expect(useLoopStore.getState().wrapCrossfadeSec).toBe(0.035)
  expect(loopRenderOptions(useLoopStore.getState(), saved).wrapCrossfadeSec).toBe(0.5)
  store.startSession({ ...session, sourceName: 'another.wav' })
  expect(useLoopStore.getState().renderOverrides).toEqual({})
})
