import { describe, expect, it } from 'vitest'
import { classifyBars, introEndBar, loopWarnings, priorFor, rankSuggestions, snapToGrid, stepOnGrid, topChange, type GameSongBar } from './analyze'

const BAR = 2.5

/** Bars of a song from per-bar drums+bass and top levels. */
function song(baseDb: number[], topDb: number[] = baseDb.map(() => -20)): GameSongBar[] {
  return classifyBars(baseDb.map((db, i) => ({ startSec: i * BAR, endSec: (i + 1) * BAR, baseDb: db, topDb: topDb[i]! })))
}

/** 8 bars of intro without drums, then 80 loud bars, then a 4-bar quiet breakdown and 8 more loud bars. */
const LEVELS = [...Array(8).fill(-40), ...Array(80).fill(-12), ...Array(4).fill(-35), ...Array(8).fill(-12)]
const beatsSec = Array.from({ length: LEVELS.length * 4 }, (_, i) => i * BAR / 4)

describe('bar classification', () => {
  it('marks bars far below the usual drum level as quiet and finds the intro end', () => {
    const bars = song(LEVELS)
    expect(bars[0]!.quiet).toBe(true)
    expect(bars[8]!.quiet).toBe(false)
    expect(bars[89]!.quiet).toBe(true)
    expect(introEndBar(bars)).toBe(8)
  })
})

describe('rankSuggestions', () => {
  const bars = song(LEVELS)
  const flat = () => 0.6

  it('never wraps into the intro, never loops through the breakdown, and keeps loops long', () => {
    const list = rankSuggestions({ bars, beatsSec, pGood: flat, priors: [] })
    expect(list.length).toBeGreaterThan(0)
    for (const s of list) {
      expect(s.startSec).toBeGreaterThanOrEqual(8 * BAR)
      expect(s.endSec - s.startSec).toBeGreaterThanOrEqual(60)
      const crossesBreakdown = s.startSec < 88 * BAR && s.endSec > 88 * BAR + 3 * BAR
      expect(crossesBreakdown).toBe(false)
    }
  })

  it('follows the join model when nothing else differs', () => {
    const target = { exit: 80 * BAR, entry: 30 * BAR }
    const list = rankSuggestions({ bars, beatsSec, priors: [],
      pGood: (x, e) => (x === target.exit && e === target.entry ? 0.95 : 0.3) })
    expect(list[0]).toMatchObject({ endSec: target.exit, startSec: target.entry })
  })

  it('boosts wraps rated Good before and drops ones rated Bad', () => {
    const good = { exitSec: 70 * BAR, entrySec: 20 * BAR, rating: 'good' as const }
    const bad = { exitSec: 80 * BAR, entrySec: 30 * BAR, rating: 'bad' as const }
    const list = rankSuggestions({ bars, beatsSec, priors: [good, bad],
      pGood: (x, e) => (x === bad.exitSec && e === bad.entrySec ? 0.99 : 0.5) })
    expect(list[0]).toMatchObject({ endSec: good.exitSec, startSec: good.entrySec, prior: 'good' })
    expect(list.some(s => s.endSec === bad.exitSec && s.startSec === bad.entrySec)).toBe(false)
  })

  it('includes a Good wrap even when it is off the bar grid', () => {
    const offGrid = { exitSec: 70 * BAR + 0.6, entrySec: 20 * BAR + 0.6, rating: 'good' as const }
    const list = rankSuggestions({ bars, beatsSec, priors: [offGrid], pGood: flat })
    expect(list[0]).toMatchObject({ endSec: offGrid.exitSec, startSec: offGrid.entrySec })
  })

  it('prefers wraps that skip a top-layer dropout and restart where it returns', () => {
    const top = LEVELS.map(() => -20)
    top[60] = top[61] = -40
    top[18] = top[19] = -40
    const list = rankSuggestions({ bars: song(LEVELS, top), beatsSec, pGood: flat, priors: [] })
    expect(list[0]).toMatchObject({ endSec: 60 * BAR, startSec: 20 * BAR })
  })

  it('returns distinct suggestions', () => {
    const list = rankSuggestions({ bars, beatsSec, pGood: flat, priors: [] })
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const same = Math.abs(list[i]!.startSec - list[j]!.startSec) < 2 * BAR && Math.abs(list[i]!.endSec - list[j]!.endSec) < 2 * BAR
        expect(same).toBe(false)
      }
    }
  })
})

describe('topChange', () => {
  it('measures a dropout after a bar line and a return at one', () => {
    const top = [-20, -20, -40, -40, -20, -20]
    const bars = song(top.map(() => -12), top)
    expect(topChange(bars, 2, 'drop')).toBe(1)
    expect(topChange(bars, 4, 'return')).toBe(1)
    expect(topChange(bars, 1, 'drop')).toBeLessThan(1)
  })
})

describe('priorFor', () => {
  it('matches nearby joins and lets Bad win', () => {
    const priors = [{ exitSec: 10, entrySec: 5, rating: 'good' as const }, { exitSec: 10.01, entrySec: 5, rating: 'bad' as const }]
    expect(priorFor(priors, 10.02, 5)).toBe('bad')
    expect(priorFor(priors.slice(0, 1), 10.02, 5)).toBe('good')
    expect(priorFor(priors, 11, 5)).toBeNull()
  })
})

describe('loopWarnings', () => {
  const bars = song(LEVELS)
  const analysis = { bars, introEndSec: 8 * BAR }

  it('warns about short loops and wrapping into the intro', () => {
    const ids = loopWarnings(analysis, { startSec: 2 * BAR, endSec: 20 * BAR }).map(w => w.id)
    expect(ids).toContain('short')
    expect(ids).toContain('intro-start')
  })

  it('warns when the loop repeats a quiet breakdown', () => {
    expect(loopWarnings(analysis, { startSec: 40 * BAR, endSec: 96 * BAR }).map(w => w.id)).toEqual(['quiet-inside'])
  })

  it('is quiet for a good loop', () => {
    expect(loopWarnings(analysis, { startSec: 20 * BAR, endSec: 80 * BAR })).toEqual([])
  })
})

describe('grid snapping', () => {
  const analysis = { bars: song(LEVELS), beatsSec }

  it('snaps to bars or beats', () => {
    expect(snapToGrid(analysis, 11.1, 'bar')).toBe(10)
    expect(snapToGrid(analysis, 11.1, 'beat')).toBe(11.25)
  })

  it('steps along the grid', () => {
    expect(stepOnGrid(analysis, 10, 'bar', 1)).toBe(12.5)
    expect(stepOnGrid(analysis, 10, 'beat', -1)).toBe(9.375)
    expect(stepOnGrid(analysis, 0, 'bar', -1)).toBe(0)
  })
})
