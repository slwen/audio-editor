/**
 * How well does scoreJump separate Good from Bad listening decisions?
 * Loop wraps are jumps from a loop's end to its start; rated transitions are jumps between two sections.
 * Run: npm run eval:jumps. Requires ffmpeg, sample_songs/, loop-ratings.jsonl and transition-ratings.jsonl.
 */
import { scoreLoopWindow } from '@/loop/detectLoops'
import { suggestRoutes } from '@/adaptive/zonePlan'
import type { MusicSlot } from '@/adaptive/model'
import { analyzeSongMap, type SongMap } from '@/pack/songMap'
import { auc, loadRatedJumps, type RatedJump } from './jumpDataset.ts'

type Scored = RatedJump & { score: number; baseline?: number; mapRank?: number }

/** Rank of this jump among all meter-preserving jumps from the same exit beat, or undefined when off the map's grid. */
function mapRank(map: SongMap, exitSec: number, entrySec: number): number | undefined {
  const nearest = (t: number) => map.beatsSec.reduce((best, beat, i) => Math.abs(beat - t) < Math.abs(map.beatsSec[best]! - t) ? i : best, 0)
  const exitBeat = nearest(exitSec)
  const entryBeat = nearest(entrySec)
  if (Math.abs(map.beatsSec[exitBeat]! - exitSec) > 0.04 || Math.abs(map.beatsSec[entryBeat]! - entrySec) > 0.04) return undefined
  const index = map.jumps.filter(jump => jump.exitBeat === exitBeat).findIndex(jump => jump.entryBeat === entryBeat)
  return index < 0 ? undefined : index + 1
}

function reportMapRecall(rows: Scored[]) {
  for (const good of [true, false]) {
    const ranked = rows.filter(r => r.good === good && r.mapRank !== undefined)
    const offGrid = rows.filter(r => r.good === good).length - ranked.length
    const within = (k: number) => ranked.filter(r => r.mapRank! <= k).length
    const scores = rows.filter(r => r.good === good).map(r => r.score).sort((a, b) => a - b)
    console.log(`  ${good ? 'Good' : 'Bad '} wraps: scoreJump median=${scores[Math.floor(scores.length / 2)]?.toFixed(3)};`
      + ` ${ranked.length} on the map grid (${offGrid} off-grid), rank in their exit beat's list: top 1=${within(1)}, top 8=${within(8)}, top 20=${within(20)}`)
  }
}

function report(label: string, rows: Scored[]) {
  const good = rows.filter(r => r.good).length
  const withBaseline = rows.filter(r => r.baseline !== undefined)
  const base = withBaseline.length ? ` | current app AUC=${auc(withBaseline.map(r => ({ good: r.good, value: r.baseline! }))).toFixed(3)}` : ''
  console.log(`  ${label.padEnd(34)} ${String(good).padStart(3)} good / ${String(rows.length - good).padStart(3)} bad`
    + ` | scoreJump AUC=${auc(rows.map(r => ({ good: r.good, value: r.score }))).toFixed(3)}${base}`)
}

export async function main() {
  const { songs, jumps } = loadRatedJumps()
  const rows: Scored[] = []
  for (const { song, ctx } of songs) {
    const songJumps = jumps.filter(j => j.song === song)
    const map = songJumps.some(j => j.kind === 'loop')
      ? analyzeSongMap({ samples: ctx.samples, sampleRate: ctx.sampleRate, jumpsPerExit: Infinity }) : undefined
    const reviews = songJumps.flatMap(j => j.transition ? [j.transition] : [])
    const slots = new Map<string, MusicSlot>()
    for (const r of reviews) { slots.set(r.fromLoop.key, r.fromLoop); slots.set(r.toLoop.key, r.toLoop) }
    const buffer = { sampleRate: ctx.sampleRate, getChannelData: () => ctx.samples } as unknown as AudioBuffer
    const suggestions = reviews.length ? suggestRoutes(buffer, [...slots.values()], [...slots.values()]) : []
    for (const jump of songJumps) {
      const score = Math.exp(jump.x.logQuality)
      if (jump.loop) {
        const r = jump.loop
        const current = scoreLoopWindow(ctx.samples, ctx.sampleRate, r.startSec, r.endSec, r.bpm, ctx.frames, ctx.hopSec, r.vibeWindowSec)
        rows.push({ ...jump, score, baseline: current.qualityScore, mapRank: mapRank(map!, r.endSec, r.startSec) })
      } else if (!jump.transition) {
        rows.push({ ...jump, score })
      } else {
        const r = jump.transition
        const from = r.fromLoop.candidate
        const to = r.toLoop.candidate
        const fromDur = from.endSec - from.startSec
        const exitBar = Math.round((r.exitOffsetSec % fromDur) / fromDur * from.bars) % Math.max(1, Math.floor(from.bars))
        const entryBar = Math.round((r.entryOffsetSec ?? 0) / (to.endSec - to.startSec) * to.bars)
        const baseline = suggestions.find(s => s.from.key === r.fromLoop.key && s.to.key === r.toLoop.key
          && s.exitBar === exitBar && s.entryBar === entryBar)?.score
        rows.push({ ...jump, score, baseline })
      }
    }
  }
  const loopRows = rows.filter(r => r.kind === 'loop')
  const transitionRows = rows.filter(r => r.kind === 'transition')
  console.log('Loop wraps (end -> start), original cuts only:')
  report('all', loopRows)
  for (const { song } of songs) report(song.slice(0, 34), loopRows.filter(r => r.song === song))
  reportMapRecall(loopRows)
  console.log('\nRated section transitions (natural continuations excluded):')
  report('all', transitionRows)
  report('fade <= 0.6 s', transitionRows.filter(r => r.fadeSec <= 0.6))
  report('fade > 0.6 s', transitionRows.filter(r => r.fadeSec > 0.6))
  for (const direction of new Set(transitionRows.map(r => r.direction))) report(direction, transitionRows.filter(r => r.direction === direction))
  for (const { song } of songs) report(song.slice(0, 34), transitionRows.filter(r => r.song === song))
  const packRows = rows.filter(r => r.kind === 'pack')
  if (packRows.length) {
    console.log('\nJoins rated in the pack simulator:')
    report('all', packRows)
    for (const direction of new Set(packRows.map(r => r.direction))) report(direction, packRows.filter(r => r.direction === direction))
  }
}
