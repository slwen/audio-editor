import { describe, expect, it } from 'vitest'
import { restoreSavedLoops, mergeSavedLoops } from './savedLoops'
import { candidatePassesFilters } from './filters'
import type { LoopRatingRecord } from './loopRatings'
import { useLoopStore } from '@/store/useLoopStore'

const saved: LoopRatingRecord = {
  at: '2026-09-22T00:00:00Z', sourceName: 'song.mp3',
  startSec: 34.60266666666667, endSec: 65.32266666666666, bars: 16,
  bpm: 125, vibeWindowSec: 2, seamScore: 0.85, contextScore: 0.87,
  homogeneityScore: 0.93, qualityScore: 0.82, rating: 'good',
}
const session = { sourceName: 'song.mp3', trimStart: 0, trimEnd: 180 }

describe('saved listening cuts', () => {
  it('restores exact approved boundaries, historical tempo, tags and raw rendering fallback', () => {
    const [loop] = restoreSavedLoops([saved, { ...saved, rating: undefined, tags: ['combat'] }], session)
    expect(loop).toMatchObject({ startSec: saved.startSec, endSec: saved.endSec, bpm: 125, bars: 16,
      origin: 'saved', scoreVersion: 'legacy', savedRender: { wrapCrossfadeSec: 0, normalize: false } })
  })

  it('does not restore another source, out-of-trim audio or cleared decisions without notes', () => {
    expect(restoreSavedLoops([saved], { ...session, sourceName: 'other.mp3' })).toEqual([])
    expect(restoreSavedLoops([saved], { ...session, trimEnd: 60 })).toEqual([])
    expect(restoreSavedLoops([saved, { ...saved, rating: 'clear' }], session)).toEqual([])
  })

  it('keeps annotated cuts when a rating is cleared, without multiplying note edits', () => {
    const records: LoopRatingRecord[] = [saved,
      { ...saved, rating: undefined, note: 'click' },
      { ...saved, rating: 'clear', note: 'slight click' }]
    expect(restoreSavedLoops(records, session)).toHaveLength(1)
    expect(mergeSavedLoops(restoreSavedLoops(records, session), records, session)).toHaveLength(1)
  })

  it('never hides saved decisions behind new algorithm score thresholds or mixes views', () => {
    const loop = restoreSavedLoops([saved], session)[0]!
    const opts = { minQuality: 1, minVibe: 1, barFilter: 'beds' as const, lengthFilter: 'all' as const }
    expect(candidatePassesFilters(loop, { ...opts, candidateView: 'saved' })).toBe(true)
    expect(candidatePassesFilters(loop, { ...opts, candidateView: 'found' })).toBe(false)
  })

  it('retains a saved loop and selection when a new analysis finds nothing', () => {
    const store = useLoopStore.getState()
    store.startSession({ ...session, sourceClipId: 'clip', bufferId: 'buffer' })
    store.replaceRatings([saved])
    store.setCandidateView('saved')
    const id = useLoopStore.getState().candidates[0]!.id
    store.setSelectedIds([id]); store.setPreviewId(id)
    store.setResults({ bpm: 124.9, beatOffsetSec: 0, candidates: [] })
    expect(useLoopStore.getState().candidates[0]?.bpm).toBe(125)
    expect(useLoopStore.getState().previewId).toBe(id)
    expect(useLoopStore.getState().selectedIds).toEqual([id])
    store.clear(); store.replaceRatings([])
  })
})
