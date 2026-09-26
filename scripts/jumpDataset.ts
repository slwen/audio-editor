import fs from 'node:fs'
import path from 'node:path'
import { latestRatingRecords, parseRatingLog, type LoopRatingRecord } from '@/loop/loopRatings'
import { mergeTransitionReviews, parseTransitionRatings } from '@/adaptive/transitionRatings'
import type { TransitionReview } from '@/adaptive/model'
import { jumpContext, jumpFeatures, type JumpContext, type JumpFeatures } from '@/pack/jumpFeatures'
import { parsePackRatings } from '@/pack/packRatings'
import { decodeForAnalysis } from './decodeAudio.ts'
import { transitionJoinTimes } from './listenerJoins.ts'

export type RatedJump = {
  /** Loop wrap, adaptive-preview transition, or a join heard in the pack simulator. */
  kind: 'loop' | 'transition' | 'pack'
  song: string
  good: boolean
  exitSec: number
  entrySec: number
  fadeSec: number
  direction: string
  x: JumpFeatures
  loop?: LoopRatingRecord
  transition?: TransitionReview
}

export type RatedSong = { song: string; ctx: JumpContext }

/** Every Good/Bad listening decision that corresponds to one hard jump in the source. */
export function loadRatedJumps(): { songs: RatedSong[]; jumps: RatedJump[] } {
  const loops = latestRatingRecords(parseRatingLog(fs.readFileSync('loop-ratings.jsonl', 'utf8'))
    // Long musical blends are separate renderings; their votes do not describe the original splice.
    .filter(r => r.rating === 'clear' || (r.wrapCrossfadeSec ?? 0) <= 0.12))
    .filter(r => r.rating === 'good' || r.rating === 'bad')
  const sourceOf = new Map<string, string>()
  const transitions = mergeTransitionReviews(parseTransitionRatings(fs.readFileSync('transition-ratings.jsonl', 'utf8'))
    .map(record => { sourceOf.set(record.review.id, record.sourceName); return record.review }))
    .filter(review => review.rating && !review.natural)
  const packRatings = fs.existsSync('pack-ratings.jsonl')
    // Stingers are judged as designed transitions, not as splices the join model predicts.
    ? parsePackRatings(fs.readFileSync('pack-ratings.jsonl', 'utf8'))
      .filter(r => !['natural-switch', 'lead-in', 'hit-cut'].includes(r.join.kind)) : []

  const songs: RatedSong[] = []
  const jumps: RatedJump[] = []
  for (const song of new Set([...loops.map(r => r.sourceName), ...sourceOf.values(), ...packRatings.map(r => r.sourceName)])) {
    const file = path.join('sample_songs', song)
    if (!fs.existsSync(file)) { console.log(`Skipping ${song}: not in sample_songs/`); continue }
    const { samples, sampleRate } = decodeForAnalysis(file)
    const ctx = jumpContext(samples, sampleRate)
    songs.push({ song, ctx })
    for (const loop of loops.filter(r => r.sourceName === song)) {
      const fadeSec = loop.wrapCrossfadeSec ?? 0.035
      jumps.push({ kind: 'loop', song, good: loop.rating === 'good', exitSec: loop.endSec, entrySec: loop.startSec,
        fadeSec, direction: 'loop', x: jumpFeatures(ctx, loop.endSec, loop.startSec, fadeSec), loop })
    }
    for (const review of transitions.filter(r => sourceOf.get(r.id) === song)) {
      const { exitSec, entrySec } = transitionJoinTimes(review)
      jumps.push({ kind: 'transition', song, good: review.rating === 'good', exitSec, entrySec, fadeSec: review.fadeSec,
        direction: `${review.from}->${review.to}`, x: jumpFeatures(ctx, exitSec, entrySec, review.fadeSec), transition: review })
    }
    for (const r of packRatings.filter(r => r.sourceName === song)) {
      const { exitSec, entrySec, fadeSec, from, to } = r.join
      jumps.push({ kind: 'pack', song, good: r.rating === 'good', exitSec, entrySec, fadeSec,
        direction: `${from ?? 'none'}->${to}`, x: jumpFeatures(ctx, exitSec, entrySec, fadeSec) })
    }
  }
  return { songs, jumps }
}

export function auc(rows: { good: boolean; value: number }[]): number {
  const goods = rows.filter(r => r.good).map(r => r.value)
  const bads = rows.filter(r => !r.good).map(r => r.value)
  let wins = 0
  for (const g of goods) for (const b of bads) wins += g > b ? 1 : g === b ? 0.5 : 0
  return goods.length && bads.length ? wins / (goods.length * bads.length) : NaN
}
