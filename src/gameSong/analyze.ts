import { jumpContext, jumpFeatures, type JumpContext } from '@/pack/jumpFeatures'
import { predictGood } from '@/pack/jumpModel'
import { songGrid } from '@/pack/songMap'
import { TRAINED_JUMP_MODEL } from '@/pack/trainedJumpModel'
import type { RatedJoin } from './ratings'

/** Loops shorter than this repeat too often during a level. */
const MIN_LOOP_SEC = 60
/** A bar whose drums+bass are this far below the song's usual level counts as quiet. */
const QUIET_DROP_DB = 9
/** The song's "usual" drums+bass level: this share of bars is quieter. */
const REFERENCE_PERCENTILE = 0.75
/** The intro ends at the first run of this many bars with drums. */
const INTRO_RUN_BARS = 4
/** Quiet stretches at least this long inside the loop are skipped by suggestions. */
const MAX_QUIET_RUN_BARS = 3
/** Joins within this of a rated join count as the same join. */
const PRIOR_MATCH_SEC = 0.06
const SUGGESTION_COUNT = 8
/** A top-layer drop or return this large counts fully as a section boundary. */
const TOP_CHANGE_FULL_DB = 12
/** Loops this long count as fully varied; longer is not better. */
const FULL_LENGTH_SEC = 90
/** Two suggestions this close at both ends sound the same. */
const DISTINCT_BARS = 2

export type GameSongBar = {
  startSec: number
  endSec: number
  /** Drums+bass level in dB RMS. */
  baseDb: number
  /** Everything-else level in dB RMS. */
  topDb: number
  quiet: boolean
}

export type GameSongAnalysis = {
  durationSec: number
  bpm: number
  beatsSec: number[]
  bars: GameSongBar[]
  /** Where the drums have properly started. */
  introEndSec: number
}

export type LoopSuggestion = {
  startSec: number
  endSec: number
  /** Chance a listener rates this wrap Good, from the trained join model (blended). */
  pGood: number
  score: number
  prior: 'good' | 'bad' | null
}

function rmsDb(samples: Float32Array, sampleRate: number, startSec: number, endSec: number): number {
  const a = Math.max(0, Math.floor(startSec * sampleRate))
  const b = Math.min(samples.length, Math.max(a + 1, Math.floor(endSec * sampleRate)))
  let sum = 0
  for (let i = a; i < b; i++) sum += samples[i]! * samples[i]!
  return 10 * Math.log10(sum / Math.max(1, b - a) + 1e-12)
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]!
}

/** Marks bars whose drums+bass fall well below the song's usual level. */
export function classifyBars(bars: { startSec: number; endSec: number; baseDb: number; topDb: number }[]): GameSongBar[] {
  const reference = percentile(bars.map(b => b.baseDb), REFERENCE_PERCENTILE)
  return bars.map(b => ({ ...b, quiet: b.baseDb < reference - QUIET_DROP_DB }))
}

export function introEndBar(bars: GameSongBar[]): number {
  for (let i = 0; i + INTRO_RUN_BARS <= bars.length; i++) {
    if (bars.slice(i, i + INTRO_RUN_BARS).every(b => !b.quiet)) return i
  }
  return 0
}

export function priorFor(priors: RatedJoin[], exitSec: number, entrySec: number): 'good' | 'bad' | null {
  let found: 'good' | 'bad' | null = null
  for (const p of priors) {
    if (Math.abs(p.exitSec - exitSec) > PRIOR_MATCH_SEC || Math.abs(p.entrySec - entrySec) > PRIOR_MATCH_SEC) continue
    // Bad wins: a disputed join is never suggested.
    if (p.rating === 'bad') return 'bad'
    found = 'good'
  }
  return found
}

function longestQuietRun(bars: GameSongBar[], from: number, to: number): number {
  let run = 0
  let longest = 0
  for (let i = from; i < to; i++) {
    run = bars[i]!.quiet ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  return longest
}

const meanTopDb = (bars: GameSongBar[], from: number, to: number) => {
  const xs = bars.slice(Math.max(0, from), Math.max(0, to)).map(b => b.topDb)
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
}

/**
 * 0..1: how clearly the top layer drops out right after `bar` starts (for exits: the wrap skips a breakdown)
 * or comes back right at `bar` (for entries: the loop restarts on a fresh section).
 */
export function topChange(bars: GameSongBar[], bar: number, direction: 'drop' | 'return'): number {
  const before = meanTopDb(bars, bar - 2, bar)
  const after = meanTopDb(bars, bar, bar + 2)
  const change = direction === 'drop' ? before - after : after - before
  return Number.isFinite(change) ? Math.max(0, Math.min(1, change / TOP_CHANGE_FULL_DB)) : 0
}

/** How far through its run of loud bars `bar` is, 0..1. Late exits keep the most of the loud section. */
function lateness(bars: GameSongBar[], bar: number): number {
  let start = bar
  while (start > 0 && !bars[start - 1]!.quiet) start--
  let end = bar
  while (end + 1 < bars.length && !bars[end + 1]!.quiet) end++
  return end === start ? 1 : (bar - start) / (end - start)
}

/**
 * Bar-aligned wraps, best first: the wrap target is after the intro and has drums, the loop has no long quiet
 * stretch, and exits come late in a loud section. Rated joins are included even off the bar grid; Bad ones never.
 */
export function rankSuggestions(input: {
  bars: GameSongBar[]
  beatsSec: number[]
  pGood: (exitSec: number, entrySec: number) => number
  priors: RatedJoin[]
  minLoopSec?: number
  count?: number
}): LoopSuggestion[] {
  const { bars, priors } = input
  const minLoop = input.minLoopSec ?? MIN_LOOP_SEC
  const intro = introEndBar(bars)
  const barAt = (sec: number) => bars.findIndex(b => sec >= b.startSec - PRIOR_MATCH_SEC && sec < b.endSec - PRIOR_MATCH_SEC)
  const acceptable = (exitSec: number, entrySec: number) => {
    const e = barAt(entrySec)
    const x = barAt(exitSec)
    if (e < intro || x < 2 || exitSec - entrySec < minLoop) return false
    if (bars[e]!.quiet || bars[e + 1]?.quiet || bars[x - 1]!.quiet || bars[x - 2]!.quiet) return false
    return longestQuietRun(bars, e, x) < MAX_QUIET_RUN_BARS
  }
  const score = (exitSec: number, entrySec: number, pGood: number, prior: 'good' | 'bad' | null) => {
    const e = barAt(entrySec)
    const x = barAt(exitSec)
    let quiet = 0
    for (let i = e; i < x; i++) if (bars[i]!.quiet) quiet++
    return pGood + 0.3 * Math.min(1, (exitSec - entrySec) / FULL_LENGTH_SEC) + 0.1 * lateness(bars, x - 1) - 0.1 * quiet
      + 0.25 * topChange(bars, x, 'drop') + 0.25 * topChange(bars, e, 'return') + (prior === 'good' ? 0.5 : 0)
  }
  const all: (LoopSuggestion & { e: number; x: number })[] = []
  for (let x = intro + 2; x < bars.length; x++) {
    for (let e = intro; e < x; e++) {
      const exitSec = bars[x]!.startSec
      const entrySec = bars[e]!.startSec
      if (!acceptable(exitSec, entrySec)) continue
      const prior = priorFor(priors, exitSec, entrySec)
      if (prior === 'bad') continue
      const pGood = input.pGood(exitSec, entrySec)
      all.push({ startSec: entrySec, endSec: exitSec, pGood, prior, score: score(exitSec, entrySec, pGood, prior), e, x })
    }
  }
  for (const p of priors) {
    if (p.rating !== 'good' || !acceptable(p.exitSec, p.entrySec)) continue
    if (priorFor(priors, p.exitSec, p.entrySec) !== 'good') continue
    if (all.some(s => Math.abs(s.endSec - p.exitSec) <= PRIOR_MATCH_SEC && Math.abs(s.startSec - p.entrySec) <= PRIOR_MATCH_SEC)) continue
    const pGood = input.pGood(p.exitSec, p.entrySec)
    all.push({ startSec: p.entrySec, endSec: p.exitSec, pGood, prior: 'good', score: score(p.exitSec, p.entrySec, pGood, 'good'),
      e: barAt(p.entrySec), x: barAt(p.exitSec) })
  }
  all.sort((a, b) => b.score - a.score)
  const picked: typeof all = []
  for (const s of all) {
    if (picked.length >= (input.count ?? SUGGESTION_COUNT)) break
    if (picked.some(p => Math.abs(p.e - s.e) < DISTINCT_BARS && Math.abs(p.x - s.x) < DISTINCT_BARS)) continue
    picked.push(s)
  }
  return picked.map(({ startSec, endSec, pGood, score, prior }) => ({ startSec, endSec, pGood, score, prior }))
}

/** Nearest bar line or beat to `sec`. */
export function snapToGrid(analysis: Pick<GameSongAnalysis, 'bars' | 'beatsSec'>, sec: number, mode: 'bar' | 'beat'): number {
  const grid = mode === 'bar' ? analysis.bars.map(b => b.startSec) : analysis.beatsSec
  let best = sec
  let bestDistance = Infinity
  for (const t of grid) {
    const d = Math.abs(t - sec)
    if (d < bestDistance) { best = t; bestDistance = d }
  }
  return best
}

/** The grid point `steps` bars or beats away from `sec` (which should already be on the grid). */
export function stepOnGrid(analysis: Pick<GameSongAnalysis, 'bars' | 'beatsSec'>, sec: number, mode: 'bar' | 'beat', steps: number): number {
  const grid = mode === 'bar' ? analysis.bars.map(b => b.startSec) : analysis.beatsSec
  if (grid.length === 0) return sec
  let index = 0
  for (let i = 0; i < grid.length; i++) if (Math.abs(grid[i]! - sec) < Math.abs(grid[index]! - sec)) index = i
  return grid[Math.max(0, Math.min(grid.length - 1, index + steps))]!
}

export type LoopWarning = { id: 'short' | 'quiet-start' | 'intro-start' | 'quiet-inside'; text: string }

export function loopWarnings(analysis: Pick<GameSongAnalysis, 'bars' | 'introEndSec'>,
  loop: { startSec: number; endSec: number }): LoopWarning[] {
  const warnings: LoopWarning[] = []
  const length = loop.endSec - loop.startSec
  if (length < MIN_LOOP_SEC) {
    warnings.push({ id: 'short', text: `The loop is only ${Math.round(length)} s long, so players will notice it repeating. Aim for at least ${MIN_LOOP_SEC} s.` })
  }
  const bars = analysis.bars
  const startBar = bars.findIndex(b => loop.startSec >= b.startSec - PRIOR_MATCH_SEC && loop.startSec < b.endSec - PRIOR_MATCH_SEC)
  if (loop.startSec < analysis.introEndSec - PRIOR_MATCH_SEC) {
    warnings.push({ id: 'intro-start', text: 'The loop goes back into the intro, before the drums start. It may sound like the song ended and restarted.' })
  } else if (startBar >= 0 && (bars[startBar]!.quiet || bars[startBar + 1]?.quiet)) {
    warnings.push({ id: 'quiet-start', text: 'The loop goes back to a quiet part with few drums. The music may seem to drop out.' })
  }
  const endBar = bars.findIndex(b => loop.endSec >= b.startSec - PRIOR_MATCH_SEC && loop.endSec < b.endSec - PRIOR_MATCH_SEC)
  const inside = bars.slice(Math.max(0, startBar), endBar < 0 ? bars.length : endBar)
  const quietSec = inside.filter(b => b.quiet).reduce((sum, b) => sum + b.endSec - b.startSec, 0)
  if (quietSec >= 8) {
    warnings.push({ id: 'quiet-inside', text: `The loop contains about ${Math.round(quietSec)} s of quiet, low-drum music that will repeat every time.` })
  }
  return warnings
}

/** Everything the loop picker needs from one song. `base` and `top` are mono at the same analysis rate. */
export function analyzeGameSong(base: Float32Array, top: Float32Array, sampleRate: number): { analysis: GameSongAnalysis; ctx: JumpContext } {
  const mix = new Float32Array(Math.min(base.length, top.length))
  for (let i = 0; i < mix.length; i++) mix[i] = base[i]! + top[i]!
  const durationSec = mix.length / sampleRate
  const ctx = jumpContext(mix, sampleRate)
  const grid = songGrid(ctx, durationSec)
  const bars = classifyBars(grid.bars.map(b => ({ startSec: b.startSec, endSec: b.endSec,
    baseDb: rmsDb(base, sampleRate, b.startSec, b.endSec), topDb: rmsDb(top, sampleRate, b.startSec, b.endSec) })))
  const intro = introEndBar(bars)
  return {
    analysis: { durationSec, bpm: ctx.bpm, beatsSec: grid.beatsSec, bars, introEndSec: bars[intro]?.startSec ?? 0 },
    ctx,
  }
}

export function wrapPGood(ctx: JumpContext, exitSec: number, entrySec: number, fadeSec: number): number {
  return predictGood(TRAINED_JUMP_MODEL, jumpFeatures(ctx, exitSec, entrySec, fadeSec))
}
