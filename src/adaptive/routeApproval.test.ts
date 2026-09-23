import { beforeEach, expect, it, vi } from 'vitest'
import { prepareTwoStateTrial, reviewTransition, setPairRule } from './actions'
import { STOPPED_MUSIC } from './AdaptivePlayer'
import { DEFAULT_MUSIC_SETTINGS, passagePairKey, type MusicSlot, type TransitionReview } from './model'
import { useAdaptiveStore } from './store'
import { loopRatingKey } from '@/loop/loopRatings'
import type { LoopCandidate } from '@/loop/types'
import { useLoopStore } from '@/store/useLoopStore'

vi.mock('@/audio/AudioEngine', () => ({ audioEngine: { onStop: vi.fn(), stop: vi.fn() } }))
vi.mock('./transitionRatings', () => ({
  mergeTransitionReviews: (_saved: unknown, local: unknown) => local,
  syncTransitionRecords: vi.fn().mockResolvedValue([]),
}))

const combat: MusicSlot = { key: 'cathedral-combat', render: { wrapCrossfadeSec: 0.035, normalize: false },
  candidate: { id: 'combat', startSec: 142, endSec: 182, bars: 16, bpm: 96,
    seamScore: 1, contextScore: 1, qualityScore: 1, homogeneityScore: 1 } }
const exploration: MusicSlot = { key: 'cathedral-exploration', render: { wrapCrossfadeSec: 0.035, normalize: false },
  candidate: { ...combat.candidate, id: 'exploration', startSec: 130, endSec: 140, bars: 4 } }
const review: TransitionReview = { id: 'review-1', at: '2026-09-23T00:00:00Z', from: 'combat', to: 'exploration',
  fromLoop: combat, toLoop: exploration, settings: { exitBars: 2, fadeBeats: 1, releaseSec: 3 },
  exitOffsetSec: 10, entryOffsetSec: 0, fadeSec: 0.6, note: '' }

beforeEach(() => {
  vi.stubGlobal('localStorage', { setItem: vi.fn() })
  useAdaptiveStore.setState({ storageKey: 'cathedral-trial', slots: { combat: [combat], exploration: [exploration] },
    rules: {}, reviews: [], playback: { ...STOPPED_MUSIC, transition: review }, error: '' })
})

it('approves only the reviewed direction and pins its actual exit bar', () => {
  reviewTransition('good')
  expect(useAdaptiveStore.getState().rules[passagePairKey(combat, exploration)]).toMatchObject({
    approved: true, exitBar: 4, entryBar: 0, fadeBeats: 1,
    approvedExits: [{ exitBar: 4, entryBar: 0, fadeBeats: 1 }],
  })
  expect(useAdaptiveStore.getState().rules[passagePairKey(exploration, combat)]).toBeUndefined()
  expect(localStorage.setItem).toHaveBeenCalled()
})

it('adds a second Good point and removes only the point later marked Bad', () => {
  const key = passagePairKey(combat, exploration)
  reviewTransition('good')
  const second = { ...review, id: 'review-2', exitOffsetSec: 20 }
  useAdaptiveStore.setState({ playback: { ...STOPPED_MUSIC, transition: second } })
  reviewTransition('good')
  expect(useAdaptiveStore.getState().rules[key]?.approvedExits?.map(exit => exit.exitBar)).toEqual([4, 8])
  useAdaptiveStore.setState({ playback: { ...STOPPED_MUSIC, transition: second } })
  reviewTransition('bad')
  expect(useAdaptiveStore.getState().rules[key]).toMatchObject({ approved: true,
    approvedExits: [{ exitBar: 4, entryBar: 0, fadeBeats: 1 }] })
})

it('keeps a Good exit when a different arrival bar at that exit is rejected', () => {
  const key = passagePairKey(combat, exploration)
  useAdaptiveStore.setState({ playback: { ...STOPPED_MUSIC,
    transition: { ...review, entryOffsetSec: 5, id: 'entry-two' } } })
  reviewTransition('good')
  expect(useAdaptiveStore.getState().rules[key]?.approvedExits).toMatchObject([{ exitBar: 4, entryBar: 2 }])
  useAdaptiveStore.setState({ playback: { ...STOPPED_MUSIC,
    transition: { ...review, id: 'entry-zero' } } })
  reviewTransition('bad')
  expect(useAdaptiveStore.getState().rules[key]?.approvedExits).toMatchObject([{ exitBar: 4, entryBar: 2 }])
})

it('removes approval when the route is rejected or retimed', () => {
  reviewTransition('good')
  setPairRule(combat, exploration, { fadeBeats: 2 })
  expect(useAdaptiveStore.getState().rules[passagePairKey(combat, exploration)]?.approved).toBe(false)
  expect(useAdaptiveStore.getState().playback.transition).toBeNull()
  useAdaptiveStore.setState({ playback: { ...STOPPED_MUSIC, transition: review } })
  reviewTransition('bad')
  expect(useAdaptiveStore.getState().rules[passagePairKey(combat, exploration)]?.approved).toBe(false)
})

it('prepares Cathedral with the longest approved combat bed and nearest earlier exploration bed', () => {
  const earlier = { ...exploration.candidate, id: 'earlier', startSec: 35, endSec: 45 }
  const candidates = [earlier, exploration.candidate, combat.candidate] as LoopCandidate[]
  const sourceName = 'cathedral-of-iron.mp3'
  const keys = candidates.map(c => loopRatingKey({ sourceName, ...c }))
  useLoopStore.setState({ sourceName, candidates, ratings: Object.fromEntries(keys.map(k => [k, 'good'])),
    tags: { [keys[0]!]: ['exploration'], [keys[1]!]: ['exploration'], [keys[2]!]: ['combat'] } })
  useAdaptiveStore.setState({ slots: { combat: [{ ...combat, key: 'existing' }] }, initialState: 'exploration',
    settings: { ...DEFAULT_MUSIC_SETTINGS, approvedOnly: false } })
  const result = prepareTwoStateTrial()
  expect(result?.combat.candidate.startSec).toBe(142)
  expect(result?.exploration.candidate.startSec).toBe(130)
  expect(useAdaptiveStore.getState()).toMatchObject({ initialState: 'combat',
    settings: { approvedOnly: true, advance: true } })
  expect(useAdaptiveStore.getState().slots.combat?.map(p => p.key)).toEqual([keys[2], 'existing'])
})
