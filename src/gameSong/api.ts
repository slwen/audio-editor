/**
 * Shapes exchanged with the dev server's /__game-song endpoints.
 * Imported by the dev server too, so it must not use the `@/` alias.
 */
import type { RatedJoin } from './ratings'
import type { GameSongJson } from './songJson'

export type StemStatus = {
  state: 'missing' | 'running' | 'ready' | 'error'
  /** 0..1 while running. */
  progress: number
  message: string
  demucsInstalled: boolean
  installCommand: string
}

export type SongListing = { name: string; stems: boolean }

export type RatingsResponse = {
  /** Ratings made on the Game song screen. */
  current: RatedJoin[]
  /** Those plus approvals and rejections from the older tools' logs. */
  all: RatedJoin[]
}

export type ExportRequest = {
  sourceName: string
  id: string
  title: string
  bpm: number
  loop: { startSec: number; endSec: number; fadeSec: number }
  monoBase: boolean
  /** 128 kbps full-band instead of the default 96 kbps cut at 16 kHz. */
  highQuality: boolean
  trimEnd: boolean
  /** Absolute folder to copy the three files into; empty for download only. */
  destDir: string
}

export type ExportResult = {
  song: GameSongJson
  files: { name: string; bytes: number }[]
  stagingDir: string
  copiedTo: string | null
  notes: string[]
}

export function isExportRequest(value: unknown): value is ExportRequest {
  if (!value || typeof value !== 'object') return false
  const r = value as ExportRequest
  const finite = (...xs: unknown[]) => xs.every(x => typeof x === 'number' && Number.isFinite(x))
  return typeof r.sourceName === 'string' && typeof r.id === 'string' && typeof r.title === 'string' && finite(r.bpm)
    && !!r.loop && finite(r.loop.startSec, r.loop.endSec, r.loop.fadeSec) && typeof r.monoBase === 'boolean'
    && typeof r.highQuality === 'boolean' && typeof r.trimEnd === 'boolean' && typeof r.destDir === 'string'
}
