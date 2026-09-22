import { describe, expect, it } from 'vitest'
import { filterLoopCandidates } from '@/loop/filters'
import type { LoopCandidate } from '@/loop/types'

function cand(partial: Partial<LoopCandidate> & Pick<LoopCandidate, 'id' | 'bars' | 'qualityScore'>): LoopCandidate {
  return {
    startSec: 0,
    endSec: 8,
    seamScore: 0.5,
    contextScore: 0.5,
    homogeneityScore: 0.5,
    bpm: 120,
    ...partial,
  }
}

describe('filterLoopCandidates', () => {
  const list = [
    cand({ id: 'a', bars: 4, qualityScore: 0.9, endSec: 8 }),
    cand({ id: 'b', bars: 8, qualityScore: 0.4, endSec: 16 }),
    cand({ id: 'c', bars: 16, qualityScore: 0.7, endSec: 32 }),
  ]

  it('drops below min quality', () => {
    const out = filterLoopCandidates(list, {
      minQuality: 0.55,
      minVibe: 0,
      barFilter: 'all',
      lengthFilter: 'all',
    })
    expect(out.map((c) => c.id)).toEqual(['a', 'c'])
  })

  it('filters by bar count', () => {
    const out = filterLoopCandidates(list, {
      minQuality: 0,
      minVibe: 0,
      barFilter: 8,
      lengthFilter: 'all',
    })
    expect(out.map((c) => c.id)).toEqual(['b'])
  })

  it('drops weak wrap vibe even if quality is high', () => {
    const weak = [
      cand({ id: 'ok', bars: 4, qualityScore: 0.9, contextScore: 0.85 }),
      cand({ id: 'jump', bars: 4, qualityScore: 0.9, contextScore: 0.4 }),
    ]
    const out = filterLoopCandidates(weak, {
      minQuality: 0.5,
      minVibe: 0.7,
      barFilter: 'all',
      lengthFilter: 'all',
    })
    expect(out.map((c) => c.id)).toEqual(['ok'])
  })

  it('filters long loops', () => {
    const out = filterLoopCandidates(list, {
      minQuality: 0,
      minVibe: 0,
      barFilter: 'all',
      lengthFilter: 'long',
    })
    expect(out.map((c) => c.id)).toEqual(['c'])
  })
})

it('uses listening decisions and feel tags consistently without changing quality scores', () => {
  const good = cand({ id: 'good', bars: 4, startSec: 1, endSec: 9, qualityScore: 0.6 })
  const bad = cand({ id: 'bad', bars: 4, startSec: 10, endSec: 18, qualityScore: 0.95 })
  const opts = { minQuality: 0, minVibe: 0, barFilter: 'all' as const, lengthFilter: 'all' as const,
    sourceName: 'song', ratings: { 'song|4|10.00|18.00': 'bad' as const },
    tags: { 'song|4|1.00|9.00': ['combat' as const] } }
  expect(filterLoopCandidates([bad, good], { ...opts, reviewFilter: 'not-bad' })).toEqual([good])
  expect(filterLoopCandidates([bad, good], { ...opts, reviewFilter: 'all' })).toEqual([bad, good])
  expect(filterLoopCandidates([bad, good], { ...opts, feelFilter: 'combat' })).toEqual([good])
  expect(bad.qualityScore).toBe(0.95)
})
