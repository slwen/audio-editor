import { beforeEach, expect, it, vi } from 'vitest'
import { setPassageFeel } from './actions'
import { useAdaptiveStore } from './store'
import { useLoopStore } from '@/store/useLoopStore'
import { logLoopRating } from '@/loop/loopRatings'
import { STOPPED_MUSIC } from './AdaptivePlayer'
import type { MusicSlot } from './model'

vi.mock('@/audio/AudioEngine', () => ({ audioEngine: { onStop: vi.fn(), stop: vi.fn() } }))
vi.mock('@/loop/loopRatings', async importOriginal => ({
  ...await importOriginal<typeof import('@/loop/loopRatings')>(), logLoopRating: vi.fn(),
}))
const slot: MusicSlot = { key: 'song|4|0.00|8.00', render: { wrapCrossfadeSec: 0.1, normalize: false },
  candidate: { id: 'loop', startSec: 0, endSec: 8, bars: 4, bpm: 120,
    seamScore: 1, contextScore: 1, qualityScore: 1, homogeneityScore: 1 } }
beforeEach(() => {
  vi.stubGlobal('localStorage', { setItem: vi.fn() })
  vi.mocked(logLoopRating).mockReset().mockResolvedValue(undefined)
  useAdaptiveStore.setState({ storageKey: 'test', slots: { exploration: [slot] },
    initialState: 'exploration', playback: STOPPED_MUSIC, starting: false, error: '',
    audition: { slot, mode: 'loop', sourceTime: 2 } })
  useLoopStore.setState({ sourceName: 'song', tags: { [slot.key]: ['exploration', 'combat'] },
    ratingRecords: [], candidates: [] })
})
it('persists an additional tag, retains the original assignment and keeps inline audition playing', async () => {
  expect(await setPassageFeel(slot.key, 'tension', true)).toBe(true)
  expect(logLoopRating).toHaveBeenCalledWith(expect.objectContaining({ tags: ['exploration', 'combat', 'tension'],
    startSec: 0, endSec: 8, wrapCrossfadeSec: 0.1 }))
  expect(useAdaptiveStore.getState()).toMatchObject({ slots: { exploration: [slot], tension: [slot] },
    initialState: 'exploration', audition: { sourceTime: 2 } })
  expect(localStorage.setItem).toHaveBeenCalled()
  expect(useLoopStore.getState().tags[slot.key]).toEqual(['exploration', 'combat', 'tension'])
})
it('keeps the old assignment when saving its tag fails', async () => {
  vi.mocked(logLoopRating).mockRejectedValue(new Error('offline'))
  expect(await setPassageFeel(slot.key, 'tension', true)).toBe(false)
  expect(useAdaptiveStore.getState().slots).toEqual({ exploration: [slot] })
  expect(useAdaptiveStore.getState().error).toContain('Could not save')
})
it('shares source passages without creating loop rating records or duplicate assignments', async () => {
  const passage = { ...slot, kind: 'passage' as const }
  useAdaptiveStore.setState({ slots: { exploration: [passage], tension: [passage] } })
  await setPassageFeel(slot.key, 'tension', true)
  expect(logLoopRating).not.toHaveBeenCalled()
  expect(useAdaptiveStore.getState().slots).toEqual({ exploration: [passage], tension: [passage] })
})

it('removes only the unchecked feel and preserves other assignments and tags', async () => {
  useAdaptiveStore.setState({ slots: { exploration: [slot], combat: [slot] } })
  await setPassageFeel(slot.key, 'exploration', false)
  expect(useAdaptiveStore.getState().slots).toEqual({ exploration: [], combat: [slot] })
  expect(useLoopStore.getState().tags[slot.key]).toEqual(['combat'])
  expect(useAdaptiveStore.getState().initialState).toBe('combat')
})
