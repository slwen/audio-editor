import { describe, expect, it } from 'vitest'
import { gameSongRatings, mergeRatedJoins, oldPackApprovedJoins, oldPackRatings, type GameSongRatingRecord } from './ratings'

const line = (r: Partial<GameSongRatingRecord>) => JSON.stringify({ version: 1, at: '2026-09-27T00:00:00Z', sourceName: 'a.mp3',
  exitSec: 100, entrySec: 40, fadeSec: 1, rating: 'good', ...r })

describe('gameSongRatings', () => {
  it('keeps the latest decision per wrap and honours clear', () => {
    const text = [line({}), line({ rating: 'bad' }), line({ exitSec: 90 }), line({ exitSec: 90, rating: 'clear' }),
      line({ sourceName: 'b.mp3' }), '{"partial'].join('\n')
    expect([...gameSongRatings(text, 'a.mp3').values()]).toEqual([{ exitSec: 100, entrySec: 40, rating: 'bad' }])
  })
})

describe('older logs', () => {
  it('reads pack simulator votes, skipping natural section changes', () => {
    const rec = (kind: string, rating: string) => JSON.stringify({ sourceName: 'a.mp3', rating, join: { kind, exitSec: 10, entrySec: 5 } })
    expect(oldPackRatings([rec('switch', 'good'), rec('switch', 'bad'), rec('natural-switch', 'good')].join('\n'), 'a.mp3'))
      .toEqual([{ exitSec: 10, entrySec: 5, rating: 'bad' }])
  })

  it('reads approved joins from a pack file', () => {
    const pack = JSON.stringify({ jumps: [{ exitSec: 1, entrySec: 2, source: 'listener' }, { exitSec: 3, entrySec: 4, source: 'model' }] })
    expect(oldPackApprovedJoins(pack)).toEqual([{ exitSec: 1, entrySec: 2, rating: 'good' }])
    expect(oldPackApprovedJoins('not json')).toEqual([])
  })
})

describe('mergeRatedJoins', () => {
  it('lets this screen override older tools, and Bad win among older tools', () => {
    const older = [{ exitSec: 1, entrySec: 2, rating: 'bad' as const }, { exitSec: 1, entrySec: 2, rating: 'good' as const },
      { exitSec: 3, entrySec: 4, rating: 'bad' as const }]
    const merged = mergeRatedJoins([{ exitSec: 3, entrySec: 4, rating: 'good' }], older)
    expect(merged).toEqual([{ exitSec: 1, entrySec: 2, rating: 'bad' }, { exitSec: 3, entrySec: 4, rating: 'good' }])
  })
})
