import { describe, expect, it } from 'vitest'
import { collectNotes, latestRatings, latestRenderedRatingRecords, parseRatingLog, type LoopRatingRecord } from '@/loop/loopRatings'

function record(rating: LoopRatingRecord['rating'], start = 1): LoopRatingRecord {
  return {
    at: '2026-09-22T00:00:00.000Z',
    sourceName: 'song',
    startSec: start,
    endSec: start + 8,
    bars: 4,
    seamScore: 0.5,
    contextScore: 0.8,
    homogeneityScore: 0.7,
    qualityScore: 0.6,
    bpm: 120,
    vibeWindowSec: 2,
    rating,
  }
}

describe('loop ratings log', () => {
  it('keeps listening votes tied to the actual render and does not invent a vote for a changed blend', () => {
    const raw = { ...record('bad'), wrapCrossfadeSec: 0.035 }
    const blend = { ...record(undefined), wrapCrossfadeSec: 0.5, note: 'Trying a musical blend' }
    expect(latestRenderedRatingRecords([raw, blend]).map(r => r.rating)).toEqual(['bad', undefined])
    const decisions = latestRenderedRatingRecords([raw, { ...blend, rating: 'good' },
      { ...blend, note: 'Background now matches' }])
    expect(decisions.map(r => r.rating)).toEqual(['bad', 'good'])
    expect(latestRenderedRatingRecords([raw, { ...blend, rating: 'good' }, record('clear')])).toEqual([])
  })
  it('keeps the latest mark and drops a cleared loop', () => {
    const ratings = latestRatings([record('good'), record('bad'), record('clear', 4), record('good', 4)])
    expect(ratings['song|4|1.00|9.00']).toBe('bad')
    expect(ratings['song|4|4.00|12.00']).toBe('good')
  })

  it('keeps each loop note separate from the others', () => {
    const notes = collectNotes([
      { ...record('good'), note: 'click' },
      { ...record('bad', 4), note: 'late snare' },
      { ...record('good'), note: '' },
    ])
    expect(notes['song|4|1.00|9.00']).toBe('')
    expect(notes['song|4|4.00|12.00']).toBe('late snare')
  })

  it('skips torn lines', () => {
    const text = `${JSON.stringify(record('good'))}\n{not json\n`
    expect(parseRatingLog(text)).toHaveLength(1)
  })
})
describe('rating event replay', () => {
  it('keeps ratings through note-only updates and honors clear events', async () => {
    const { latestRatingRecords } = await import('./loopRatings')
    const rows = latestRatingRecords([
      record('good'),
      { ...record(undefined), note: 'combat' },
      record('bad', 5),
      record('clear', 5),
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]?.rating).toBe('good')
    expect(rows[0]?.note).toBe('combat')
    expect(rows[1]?.rating).toBe('clear')
  })

  it('persists tag-only events and rejects malformed endpoints', async () => {
    const { collectTags } = await import('./loopRatings')
    const tagged = { ...record(undefined), tags: ['tension' as const] }
    expect(collectTags(parseRatingLog(JSON.stringify(tagged)))).toEqual({ 'song|4|1.00|9.00': ['tension'] })
    expect(parseRatingLog(JSON.stringify({ ...tagged, endSec: null }))).toEqual([])
    expect(parseRatingLog(JSON.stringify({ ...tagged, tags: ['unknown'] }))).toEqual([])
  })
})
