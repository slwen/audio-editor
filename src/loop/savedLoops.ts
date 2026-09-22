import { latestRatingRecords, loopRatingKey, type LoopRatingRecord } from '@/loop/loopRatings'
import type { LoopCandidate, LoopSession } from '@/loop/types'

/** Saved listening decisions remain usable even when detection or tempo changes. */
export function restoreSavedLoops(
  records: LoopRatingRecord[],
  session: Pick<LoopSession, 'sourceName' | 'trimStart' | 'trimEnd'>
): LoopCandidate[] {
  return latestRatingRecords(records).filter(r =>
    r.sourceName === session.sourceName && r.startSec >= session.trimStart && r.endSec <= session.trimEnd &&
    Number.isFinite(r.bpm) && r.bpm > 0 &&
    (r.rating === 'good' || r.rating === 'bad' || !!r.note?.trim() || !!r.tags?.length)
  ).map(r => ({
    id: `saved:${loopRatingKey(r)}`,
    origin: 'saved',
    startSec: r.startSec, endSec: r.endSec, bars: r.bars, bpm: r.bpm,
    seamScore: r.seamScore, contextScore: r.contextScore,
    homogeneityScore: r.homogeneityScore, qualityScore: r.qualityScore,
    closureScore: r.closureScore,
    scoreVersion: r.analysisVersion ?? 'legacy',
    scoreVibeWindowSec: r.vibeWindowSec,
    savedRender: { wrapCrossfadeSec: r.wrapCrossfadeSec ?? 0, normalize: r.normalize ?? false },
  }))
}

export function mergeSavedLoops(
  candidates: LoopCandidate[], records: LoopRatingRecord[],
  session: Pick<LoopSession, 'sourceName' | 'trimStart' | 'trimEnd'>
): LoopCandidate[] {
  return [...candidates.filter(c => c.origin !== 'saved'), ...restoreSavedLoops(records, session)]
}
