import { expect, it } from 'vitest'
import { choosePassage, sourceGaps, sourcePassage, type MusicSlot } from './model'

const make = (startSec: number, endSec: number): MusicSlot => ({ key: `${startSec}-${endSec}`,
  render: { wrapCrossfadeSec: 0.035, normalize: false }, candidate: { id: `${startSec}`, startSec, endSec,
    bars: (endSec - startSec) / 2, bpm: 120, seamScore: 1, contextScore: 1, homogeneityScore: 1, qualityScore: 1 } })

it('finds uncovered source intervals without inventing gaps within overlapping loops', () => {
  const long = make(0, 20), nested = make(8, 12), later = make(30, 40)
  expect(sourceGaps([nested, later, long])).toEqual([{ from: long, to: later }])
  expect(sourceGaps([])).toEqual([])
})

it('includes the exact original audio between sections, even for a fractional-bar gap', () => {
  const a = make(10, 26), b = make(37.25, 53.25)
  const gap = sourcePassage('song', a, b.candidate.startSec)!
  expect(gap).toMatchObject({ kind: 'passage', render: { wrapCrossfadeSec: 0, normalize: false },
    candidate: { startSec: 26, endSec: 37.25, bars: 5.625, qualityScore: 0 } })
  expect(choosePassage([a, gap, b], a, [], {})).toBe(gap)
  expect(choosePassage([a, gap, b], gap, [], {})).toBe(b)
  expect(sourceGaps([a, gap, b])).toEqual([])
})

it('does not create a reversed or inaudibly short span', () => {
  expect(sourcePassage('song', make(0, 10), 9)).toBeNull()
  expect(sourcePassage('song', make(0, 10), 10.01)).toBeNull()
})
