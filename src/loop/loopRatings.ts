import { LOOP_FEELS, type LoopFeel, type LoopBarLength } from '@/loop/types'

export type LoopRatingValue = 'good' | 'bad' | 'clear'

export type LoopRatingRecord = {
  tags?: LoopFeel[]
  analysisVersion?: string
  wrapCrossfadeSec?: number
  normalize?: boolean
  closureScore?: number
  at: string
  sourceName: string
  startSec: number
  endSec: number
  bars: LoopBarLength
  seamScore: number
  contextScore: number
  homogeneityScore: number
  qualityScore: number
  bpm: number
  vibeWindowSec: number
  /** Omitted when the line only updates the note. */
  rating?: LoopRatingValue
  /** Listener note for this loop. Empty string clears it. */
  note?: string
}

export function loopRatingKey(loop: {
  sourceName: string
  bars: number
  startSec: number
  endSec: number
}): string {
  return `${loop.sourceName}|${loop.bars}|${loop.startSec.toFixed(2)}|${loop.endSec.toFixed(2)}`
}

export function collectNotes(records: LoopRatingRecord[]): Record<string, string> {
  const notes: Record<string, string> = {}
  for (const record of records) {
    if (typeof record.note !== 'string') continue
    notes[loopRatingKey(record)] = record.note
  }
  return notes
}

export function applyRatingRecord(
  ratings: Record<string, 'good' | 'bad'>,
  record: LoopRatingRecord
): Record<string, 'good' | 'bad'> {
  if (record.rating == null) return ratings
  const next = { ...ratings }
  const key = loopRatingKey(record)
  switch (record.rating) {
    case 'good':
    case 'bad':
      next[key] = record.rating
      break
    case 'clear':
      delete next[key]
      break
    default: {
      const unexpected: never = record.rating
      throw new Error(`Unknown rating ${String(unexpected)}`)
    }
  }
  return next
}

export function latestRatings(records: LoopRatingRecord[]): Record<string, 'good' | 'bad'> {
  let ratings: Record<string, 'good' | 'bad'> = {}
  for (const record of records) ratings = applyRatingRecord(ratings, record)
  return ratings
}

function isRatingRecord(value: unknown): value is LoopRatingRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as LoopRatingRecord
  const ratingOk =
    record.rating == null ||
    record.rating === 'good' ||
    record.rating === 'bad' ||
    record.rating === 'clear'
  const hasPayload = record.rating != null || typeof record.note === 'string' || Array.isArray(record.tags)
  return ratingOk && hasPayload && typeof record.sourceName === 'string' &&
    Number.isFinite(record.startSec) && Number.isFinite(record.endSec) &&
    record.startSec >= 0 && record.endSec > record.startSec &&
    [1, 2, 4, 6, 8, 12, 16].includes(record.bars) &&
    (record.tags === undefined || (Array.isArray(record.tags) && record.tags.every(tag => LOOP_FEELS.includes(tag))))
}

export function parseRatingLog(text: string): LoopRatingRecord[] {
  const records: LoopRatingRecord[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const value: unknown = JSON.parse(trimmed)
      if (isRatingRecord(value)) records.push(value)
    } catch {
      // Ignore a partial line written during a crash.
    }
  }
  return records
}

export async function loadLoopRatings(): Promise<LoopRatingRecord[]> {
  const res = await fetch('/__loop-ratings')
  if (!res.ok) throw new Error('Could not load loop ratings')
  return parseRatingLog(await res.text())
}

export async function logLoopRating(record: LoopRatingRecord): Promise<void> {
  const res = await fetch('/__loop-ratings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  })
  if (!res.ok) throw new Error('Could not save loop rating')
}

/** Replay append-only events without counting note edits as new listening votes. */
export function latestRatingRecords(records: LoopRatingRecord[]): LoopRatingRecord[] {
  const latest = new Map<string, LoopRatingRecord>()
  for (const record of records) {
    const key = loopRatingKey(record)
    latest.set(key, { ...latest.get(key), ...record, rating: record.rating ?? latest.get(key)?.rating })
  }
  return [...latest.values()]
}

/** Evaluation keeps different audible renders separate. A note on a new blend
 * must not inherit a Good vote that was cast on the old blend. The UI still
 * uses latestRatingRecords for its one current decision per cut.
 */
export function latestRenderedRatingRecords(records: LoopRatingRecord[]): LoopRatingRecord[] {
  const latest = new Map<string, LoopRatingRecord>()
  for (const record of records) {
    const cut = loopRatingKey(record)
    if (record.rating === 'clear') {
      for (const [key, previous] of latest) if (loopRatingKey(previous) === cut) latest.delete(key)
      continue
    }
    const key = `${cut}|${record.wrapCrossfadeSec ?? 0}|${record.normalize ?? false}`
    const previous = latest.get(key)
    latest.set(key, { ...previous, ...record, rating: record.rating ?? previous?.rating })
  }
  return [...latest.values()]
}

export function collectTags(records: LoopRatingRecord[]): Record<string, LoopFeel[]> {
  const tags: Record<string, LoopFeel[]> = {}
  for (const record of records) {
    if (record.tags) tags[loopRatingKey(record)] = record.tags
  }
  return tags
}
