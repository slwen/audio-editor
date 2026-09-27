import { describe, expect, it } from 'vitest'
import { buildSongJson, gameSongFiles, isSongId, normalizeGainDb, songIdFromName, titleFromName } from './songJson'

describe('song.json', () => {
  const song = buildSongJson({
    id: 'cathedral-of-iron',
    title: 'Cathedral Of Iron',
    sourceName: 'cathedral-of-iron.mp3',
    bpm: 98.47689,
    durationSec: 241.68000001,
    loop: { startSec: 63.68512, endSec: 183.10399999, fadeSec: 1 },
    integratedLufs: -14.04,
    gainDb: -2.6312,
  })

  it('has exactly the fields the game reads, rounded for humans', () => {
    expect(song).toEqual({
      version: 'game-song-v1',
      id: 'cathedral-of-iron',
      title: 'Cathedral Of Iron',
      sourceName: 'cathedral-of-iron.mp3',
      bpm: 98.477,
      durationSec: 241.68,
      loop: { startSec: 63.685, endSec: 183.104, fadeSec: 1 },
      loudness: { integratedLufs: -14, gainDb: -2.63 },
    })
  })

  it('names the files after the id', () => {
    expect(gameSongFiles('graveyard-punk')).toEqual({
      base: 'graveyard-punk.base.mp3', top: 'graveyard-punk.top.mp3', json: 'graveyard-punk.song.json' })
  })
})

describe('names', () => {
  it('makes kebab-case ids and readable titles from file names', () => {
    expect(songIdFromName('Undead Hellcycle Descent_compressed.mp3')).toBe('undead-hellcycle-descent-compressed')
    expect(isSongId(songIdFromName('  Weird__Name!!.wav'))).toBe(true)
    expect(titleFromName('crypts-of-the-damned.mp3')).toBe('Crypts Of The Damned')
  })
})

describe('normalizeGainDb', () => {
  it('reaches the target unless the true peak would pass -1 dB', () => {
    expect(normalizeGainDb(-11, -3)).toBe(-3)
    expect(normalizeGainDb(-20, -8)).toBe(6)
    expect(normalizeGainDb(-20, -4)).toBe(3)
  })
})
