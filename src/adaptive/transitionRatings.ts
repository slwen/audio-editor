import type { TransitionReview } from './model'

export type TransitionRatingRecord = { version: 1; sourceKey: string; sourceName: string; review: TransitionReview }
export function isTransitionRating(value: unknown): value is TransitionRatingRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as TransitionRatingRecord
  const v = r.review
  return r.version === 1 && typeof r.sourceKey === 'string' && typeof r.sourceName === 'string'
    && !!v && typeof v.id === 'string' && Number.isFinite(Date.parse(v.at))
    && (v.updatedAt === undefined || Number.isFinite(Date.parse(v.updatedAt)))
    && ['exploration', 'tension', 'combat', 'intensity'].includes(v.from)
    && ['exploration', 'tension', 'combat', 'intensity'].includes(v.to)
    && (v.rating === undefined || v.rating === 'good' || v.rating === 'bad') && typeof v.note === 'string'
    && [v.fromLoop, v.toLoop].every(slot => slot && typeof slot.key === 'string'
      && Number.isFinite(slot.candidate?.startSec) && Number.isFinite(slot.candidate?.endSec)
      && slot.candidate.endSec > slot.candidate.startSec)
    && Number.isFinite(v.exitOffsetSec) && Number.isFinite(v.fadeSec) && !!v.settings
}
export function transitionRecordKey(r: TransitionRatingRecord): string {
  return JSON.stringify([r.sourceKey, r.review.id, r.review.updatedAt ?? r.review.at, r.review.rating, r.review.note])
}
export function parseTransitionRatings(text: string): TransitionRatingRecord[] {
  return text.split('\n').flatMap(line => {
    try { const r: unknown = JSON.parse(line); return isTransitionRating(r) ? [r] : [] }
    catch { return [] }
  })
}
export function mergeTransitionReviews(...groups: TransitionReview[][]): TransitionReview[] {
  const latest = new Map<string, TransitionReview>()
  for (const review of groups.flat()) {
    const old = latest.get(review.id)
    if (!old || Date.parse(review.updatedAt ?? review.at) >= Date.parse(old.updatedAt ?? old.at)) latest.set(review.id, review)
  }
  return [...latest.values()]
}

/** Scan every song, so old browser-only feedback migrates without reopening each source. */
export function browserTransitionRecords(storage: Storage): TransitionRatingRecord[] {
  const records: TransitionRatingRecord[] = []
  for (let i = 0; i < storage.length; i++) {
    const sourceKey = storage.key(i)!
    if (!sourceKey.startsWith('adaptive-music-v1:')) continue
    try {
      const saved = JSON.parse(storage.getItem(sourceKey) ?? '{}')
      const sourceName = sourceKey.slice('adaptive-music-v1:'.length).replace(/:\d+:\d+$/, '')
      for (const review of saved.reviews ?? []) {
        const record = { version: 1, sourceKey, sourceName, review }
        if (isTransitionRating(record)) records.push(record)
      }
    } catch { /* Keep other songs recoverable if one entry is corrupt. */ }
  }
  return records
}

export async function syncTransitionRecords(storage: Storage): Promise<TransitionRatingRecord[]> {
  const response = await fetch('/__transition-ratings', { cache: 'no-store' })
  if (!response.ok || !response.headers.get('content-type')?.includes('ndjson')) throw new Error('Transition log unavailable')
  const records = parseTransitionRatings(await response.text())
  const known = new Set(records.map(transitionRecordKey))
  for (const record of browserTransitionRecords(storage)) {
    if (known.has(transitionRecordKey(record))) continue
    const saved = await fetch('/__transition-ratings', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) })
    if (!saved.ok) throw new Error('Transition rating could not be saved')
    records.push(record)
    known.add(transitionRecordKey(record))
  }
  return records
}
