/**
 * Listening decisions on wraps, from this screen and from the older tools' logs on disk.
 * Imported by the dev server too, so it must not use the `@/` alias.
 */

export type WrapRating = 'good' | 'bad'

/** One Good/Bad click on the Game song screen, appended to game-song-ratings.jsonl. */
export type GameSongRatingRecord = {
  version: 1
  at: string
  sourceName: string
  exitSec: number
  entrySec: number
  fadeSec: number
  rating: WrapRating | 'clear'
}

export type RatedJoin = { exitSec: number; entrySec: number; rating: WrapRating }

export function isGameSongRating(value: unknown): value is GameSongRatingRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as GameSongRatingRecord
  return r.version === 1 && typeof r.sourceName === 'string' && Number.isFinite(Date.parse(r.at))
    && [r.exitSec, r.entrySec, r.fadeSec].every(x => typeof x === 'number' && Number.isFinite(x))
    && (r.rating === 'good' || r.rating === 'bad' || r.rating === 'clear')
}

const wrapKey = (exitSec: number, entrySec: number) => `${exitSec.toFixed(3)}|${entrySec.toFixed(3)}`

function jsonLines(text: string): unknown[] {
  const out: unknown[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* Skip a partial line written during a crash. */ }
  }
  return out
}

/** Latest decision per wrap for one song; 'clear' removes it. */
export function gameSongRatings(text: string, sourceName: string): Map<string, RatedJoin> {
  const latest = new Map<string, RatedJoin>()
  for (const r of jsonLines(text)) {
    if (!isGameSongRating(r) || r.sourceName !== sourceName) continue
    const key = wrapKey(r.exitSec, r.entrySec)
    if (r.rating === 'clear') latest.delete(key)
    else latest.set(key, { exitSec: r.exitSec, entrySec: r.entrySec, rating: r.rating })
  }
  return latest
}

type OldPackRating = { sourceName?: unknown; rating?: unknown; join?: { kind?: unknown; exitSec?: unknown; entrySec?: unknown } }

/** Joins rated in the old pack simulator (pack-ratings.jsonl), latest vote per join. */
export function oldPackRatings(text: string, sourceName: string): RatedJoin[] {
  const latest = new Map<string, RatedJoin>()
  for (const value of jsonLines(text)) {
    const r = value as OldPackRating
    const j = r?.join
    if (r?.sourceName !== sourceName || (r.rating !== 'good' && r.rating !== 'bad') || !j || j.kind === 'natural-switch') continue
    if (typeof j.exitSec !== 'number' || typeof j.entrySec !== 'number') continue
    latest.set(wrapKey(j.exitSec, j.entrySec), { exitSec: j.exitSec, entrySec: j.entrySec, rating: r.rating })
  }
  return [...latest.values()]
}

/** Joins a listener approved in any old tool, as collected into analysis/<song>.pack.json. */
export function oldPackApprovedJoins(packJson: string): RatedJoin[] {
  try {
    const pack = JSON.parse(packJson) as { jumps?: { exitSec?: unknown; entrySec?: unknown; source?: unknown }[] }
    return (pack.jumps ?? []).flatMap(j => j.source === 'listener' && typeof j.exitSec === 'number' && typeof j.entrySec === 'number'
      ? [{ exitSec: j.exitSec, entrySec: j.entrySec, rating: 'good' as const }] : [])
  } catch {
    return []
  }
}

/** This screen's ratings replace older ones for the same wrap; among older tools Bad wins. */
export function mergeRatedJoins(current: RatedJoin[], older: RatedJoin[]): RatedJoin[] {
  const out = new Map<string, RatedJoin>()
  for (const j of older) {
    const key = wrapKey(j.exitSec, j.entrySec)
    if (out.get(key)?.rating !== 'bad') out.set(key, j)
  }
  for (const j of current) out.set(wrapKey(j.exitSec, j.entrySec), j)
  return [...out.values()]
}
