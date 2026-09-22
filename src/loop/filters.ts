import { loopRatingKey } from '@/loop/loopRatings'
import type { LoopBarFilter, LoopCandidate, LoopLengthFilter, LoopFeel, LoopReviewFilter } from '@/loop/types'

export const LENGTH_SHORT_MAX = 8
export const LENGTH_LONG_MIN = 16

export function loopDuration(c: { startSec: number; endSec: number }): number {
  return c.endSec - c.startSec
}

export type LoopFilterOpts = {
  sourceName?: string
  ratings?: Record<string, 'good' | 'bad'>
  tags?: Record<string, LoopFeel[]>
  reviewFilter?: LoopReviewFilter
  feelFilter?: 'all' | LoopFeel
  candidateView?: 'found' | 'saved'
  minQuality: number
  minVibe: number
  barFilter: LoopBarFilter
  lengthFilter: LoopLengthFilter
}

export function candidatePassesFilters(c: LoopCandidate, opts: LoopFilterOpts): boolean {
  const key = loopRatingKey({ sourceName: opts.sourceName ?? '', ...c })
  const rating = opts.ratings?.[key]
  if (opts.feelFilter && opts.feelFilter !== 'all' && !opts.tags?.[key]?.includes(opts.feelFilter)) return false
  if (opts.reviewFilter === 'not-bad' && rating === 'bad') return false
  if (opts.reviewFilter === 'unrated' && rating) return false
  if ((opts.reviewFilter === 'good' || opts.reviewFilter === 'bad') && rating !== opts.reviewFilter) return false
  if ((c.origin ?? 'found') !== (opts.candidateView ?? 'found')) return false
  if (c.origin !== 'saved' && c.qualityScore + 1e-6 < opts.minQuality) return false
  if (c.origin !== 'saved' && c.contextScore + 1e-6 < opts.minVibe) return false
  if (opts.barFilter === 'beds' && c.bars < 4) return false
  if (opts.barFilter !== 'beds' && opts.barFilter !== 'all' && c.bars !== opts.barFilter) return false
  const dur = loopDuration(c)
  if (opts.lengthFilter === 'short' && dur >= LENGTH_SHORT_MAX) return false
  if (opts.lengthFilter === 'medium' && (dur < LENGTH_SHORT_MAX || dur > LENGTH_LONG_MIN)) return false
  if (opts.lengthFilter === 'long' && dur <= LENGTH_LONG_MIN) return false
  return true
}

export function filterLoopCandidates(
  candidates: LoopCandidate[],
  opts: LoopFilterOpts
): LoopCandidate[] {
  return candidates
    .filter((c) => candidatePassesFilters(c, opts))
    .sort((a, b) => b.qualityScore - a.qualityScore)
}
