import fs from 'node:fs'
import { latestRenderedRatingRecords, parseRatingLog } from '@/loop/loopRatings'
import { mergeTransitionReviews, parseTransitionRatings } from '@/adaptive/transitionRatings'
import type { TransitionReview } from '@/adaptive/model'
import type { ListenerJoins } from '@/pack/pack'
import { parsePackRatings } from '@/pack/packRatings'

/** Where an adaptive-preview transition left its source loop and arrived in the destination. */
export function transitionJoinTimes(review: TransitionReview): { exitSec: number; entrySec: number } {
  const from = review.fromLoop.candidate
  const fromDur = from.endSec - from.startSec
  // A repeating loop that exits at its bar 0 has just played its own tail.
  const exitOffset = review.exitOffsetSec % fromDur
  return { exitSec: exitOffset < 1e-3 ? from.endSec : from.startSec + exitOffset,
    entrySec: review.toLoop.candidate.startSec + (review.entryOffsetSec ?? 0) }
}

const read = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''

/** Every join this listener has rated for one song, in any tool: loop wraps, preview transitions, pack joins. */
export function listenerJoins(sourceName: string): ListenerJoins {
  const joins: ListenerJoins = { good: [], bad: [] }
  for (const loop of latestRenderedRatingRecords(parseRatingLog(read('loop-ratings.jsonl')))) {
    if (loop.sourceName !== sourceName || (loop.rating !== 'good' && loop.rating !== 'bad')) continue
    const join = { exitSec: loop.endSec, entrySec: loop.startSec, fadeSec: loop.wrapCrossfadeSec ?? 0.035 }
    joins[loop.rating].push(join)
  }
  const sourceOf = new Map<string, string>()
  const reviews = mergeTransitionReviews(parseTransitionRatings(read('transition-ratings.jsonl'))
    .map(record => { sourceOf.set(record.review.id, record.sourceName); return record.review }))
  for (const review of reviews) {
    if (sourceOf.get(review.id) !== sourceName || !review.rating || review.natural) continue
    joins[review.rating].push({ ...transitionJoinTimes(review), fadeSec: review.fadeSec })
  }
  for (const r of parsePackRatings(read('pack-ratings.jsonl'))) {
    if (r.sourceName !== sourceName || r.join.kind === 'natural-switch') continue
    joins[r.rating].push({ exitSec: r.join.exitSec, entrySec: r.join.entrySec, fadeSec: r.join.fadeSec })
  }
  // Each tool keeps only its latest vote; across tools Bad wins, so a disputed join is never planned.
  joins.good = joins.good.filter(g => !joins.bad.some(b =>
    Math.abs(b.exitSec - g.exitSec) < 0.002 && Math.abs(b.entrySec - g.entrySec) < 0.002))
  return joins
}
