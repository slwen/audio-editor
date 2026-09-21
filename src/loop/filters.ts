import type { LoopBarFilter, LoopCandidate, LoopLengthFilter } from '@/loop/types'

export const LENGTH_SHORT_MAX = 8
export const LENGTH_LONG_MIN = 16

export function loopDuration(c: { startSec: number; endSec: number }): number {
  return c.endSec - c.startSec
}

export type LoopFilterOpts = {
  minQuality: number
  minVibe: number
  barFilter: LoopBarFilter
  lengthFilter: LoopLengthFilter
}

export function candidatePassesFilters(c: LoopCandidate, opts: LoopFilterOpts): boolean {
  if (c.qualityScore + 1e-6 < opts.minQuality) return false
  if (c.contextScore + 1e-6 < opts.minVibe) return false
  if (opts.barFilter !== 'all' && c.bars !== opts.barFilter) return false
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
