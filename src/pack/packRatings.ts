import type { ZoneFeel } from '@/adaptive/zonePlan'
import type { PackJoin, PackJoinKind } from './runtime'

/** One listening decision on a join heard in the pack simulator, appended to pack-ratings.jsonl. */
export type PackRatingRecord = {
  version: 1
  sourceName: string
  packVersion: string
  jumpModel: string
  at: string
  rating: 'good' | 'bad'
  note: string
  join: { kind: PackJoinKind; exitSec: number; entrySec: number; fadeSec: number; p: number; from: ZoneFeel | null; to: ZoneFeel
    /** Whether the join was a model suggestion or one a listener had approved before. Absent in early records. */
    source?: PackJoin['source'] }
}

const KINDS: PackJoinKind[] = ['natural-switch', 'switch', 'hold', 'fallback', 'lead-in', 'hit-cut']
const FEELS = ['exploration', 'combat']

export function isPackRating(value: unknown): value is PackRatingRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as PackRatingRecord
  const j = r.join
  return r.version === 1 && typeof r.sourceName === 'string' && typeof r.packVersion === 'string'
    && typeof r.jumpModel === 'string' && Number.isFinite(Date.parse(r.at))
    && (r.rating === 'good' || r.rating === 'bad') && typeof r.note === 'string' && !!j
    && KINDS.includes(j.kind) && [j.exitSec, j.entrySec, j.fadeSec, j.p].every(Number.isFinite)
    && (j.from === null || FEELS.includes(j.from)) && FEELS.includes(j.to)
    && (j.source === undefined || ['model', 'listener', 'song'].includes(j.source))
}

export const packJoinKey = (r: PackRatingRecord): string =>
  JSON.stringify([r.sourceName, r.join.exitSec.toFixed(3), r.join.entrySec.toFixed(3), r.join.fadeSec.toFixed(3)])

/** Latest decision per exact join; a later vote replaces an earlier one. */
export function parsePackRatings(text: string): PackRatingRecord[] {
  const latest = new Map<string, PackRatingRecord>()
  for (const line of text.split('\n')) {
    try {
      const r: unknown = JSON.parse(line)
      if (isPackRating(r)) latest.set(packJoinKey(r), r)
    } catch { /* Skip partial lines. */ }
  }
  return [...latest.values()]
}

export async function savePackRating(record: PackRatingRecord): Promise<void> {
  const response = await fetch('/__pack-ratings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record) })
  if (!response.ok) throw new Error('Rating could not be saved')
}
