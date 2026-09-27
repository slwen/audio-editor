/**
 * The file the game reads next to `<id>.base.mp3` and `<id>.top.mp3`.
 * Imported by the dev server too, so it must not use the `@/` alias.
 */

const GAME_SONG_VERSION = 'game-song-v1'

export type GameSongJson = {
  version: typeof GAME_SONG_VERSION
  id: string
  title: string
  sourceName: string
  bpm: number
  durationSec: number
  loop: { startSec: number; endSec: number; fadeSec: number }
  loudness: { integratedLufs: number; gainDb: number }
}

/** Loudness every exported song is brought to, so songs match when the game crossfades between them. */
export const TARGET_LUFS = -14
/** Gain is limited so the summed stems stay below this true peak. */
export const MAX_TRUE_PEAK_DB = -1

export function songIdFromName(name: string): string {
  return name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'song'
}

export function titleFromName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, c => c.toUpperCase())
}

export const isSongId = (id: string): boolean => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)

export const gameSongFiles = (id: string) =>
  ({ base: `${id}.base.mp3`, top: `${id}.top.mp3`, json: `${id}.song.json` }) as const

const ms = (sec: number) => Math.round(sec * 1000) / 1000

export function buildSongJson(input: {
  id: string
  title: string
  sourceName: string
  bpm: number
  durationSec: number
  loop: { startSec: number; endSec: number; fadeSec: number }
  integratedLufs: number
  gainDb: number
}): GameSongJson {
  return {
    version: GAME_SONG_VERSION,
    id: input.id,
    title: input.title,
    sourceName: input.sourceName,
    bpm: Math.round(input.bpm * 1000) / 1000,
    durationSec: ms(input.durationSec),
    loop: { startSec: ms(input.loop.startSec), endSec: ms(input.loop.endSec), fadeSec: ms(input.loop.fadeSec) },
    loudness: { integratedLufs: Math.round(input.integratedLufs * 10) / 10, gainDb: Math.round(input.gainDb * 100) / 100 },
  }
}

/** Gain that brings the mix to TARGET_LUFS without pushing its true peak past MAX_TRUE_PEAK_DB. */
export function normalizeGainDb(inputLufs: number, inputTruePeakDb: number): number {
  return Math.min(TARGET_LUFS - inputLufs, MAX_TRUE_PEAK_DB - inputTruePeakDb)
}
