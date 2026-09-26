import { estimateBeatOffsetSec, type FrameFeatures } from '@/loop/detectLoops'
import { jumpContext, jumpFeatures, withFade } from './jumpFeatures'
import { predictGood, type JumpModel } from './jumpModel'
import { TRAINED_JUMP_MODEL } from './trainedJumpModel'

export const SONG_MAP_VERSION = 'song-map-v2'
/** Probabilities are reported for a click-repair cut and for a one-bar-class blend. */
const CUT_FADE_SEC = 0.035
const BLEND_FADE_SEC = 1
export const BEATS_PER_BAR = 4
const DEFAULT_JUMPS_PER_EXIT = 8

export type SongBar = {
  index: number
  /** Index into `beatsSec` of this bar's first beat. */
  startBeat: number
  startSec: number
  endSec: number
  loudnessDb: number
  /** Spectral centroid / Nyquist, 0..1. */
  brightness: number
  /** Mean onset flux, 0..1 against the loudest hop of the song. */
  density: number
  chroma: number[]
}

/**
 * Leave at the start of beat `exitBeat` (after hearing beat exitBeat - 1) and continue at the start of `entryBeat`.
 * The two are always a whole number of bars apart, so the meter continues whichever beat is really the downbeat.
 */
export type SongJump = {
  exitBeat: number
  entryBeat: number
  /** Calibrated P(listener rates it Good) when joined with a short click-repair crossfade. */
  pGoodCut: number
  /** The same when crossfaded over about a second. */
  pGoodBlended: number
  seam: number
  vibe: number
  join: number
  closure: number
  loudnessChangeDb: number
}

export type SongMap = {
  version: typeof SONG_MAP_VERSION
  durationSec: number
  sampleRate: number
  bpm: number
  /** One global-tempo grid; the detector's rated loops were cut on this grid. */
  beatsSec: number[]
  /** Heuristic: beat index of the first bar line. Check it against listening before relying on phrasing. */
  downbeatBeat: number
  /** 0 when all four bar phases look alike, 1 when one phase clearly wins. */
  downbeatConfidence: number
  bars: SongBar[]
  jumpModel: string
  /** Best jumps from every exit beat, most likely Good first. Natural continuation is implicit. */
  jumps: SongJump[]
}

export type SongMapInput = {
  samples: Float32Array
  sampleRate: number
  bpmOverride?: number
  jumpsPerExit?: number
  jumpModel?: JumpModel
}

function fluxAt(frames: FrameFeatures[], hopSec: number, sec: number): number {
  const x = sec / hopSec
  const i = Math.floor(x)
  if (i < 0 || i + 1 >= frames.length) return 0
  return frames[i]!.flux * (1 - (x - i)) + frames[i + 1]!.flux * (x - i)
}

function meanChroma(frames: FrameFeatures[], hopSec: number, startSec: number, endSec: number): Float32Array {
  const out = new Float32Array(12)
  const a = Math.max(0, Math.floor(startSec / hopSec))
  const b = Math.min(frames.length, Math.max(a + 1, Math.floor(endSec / hopSec)))
  for (let i = a; i < b; i++) for (let k = 0; k < 12; k++) out[k]! += frames[i]!.chroma[k]!
  const norm = Math.hypot(...out) || 1
  for (let k = 0; k < 12; k++) out[k]! /= norm
  return out
}

/** Harmony tends to change and onsets tend to land on bar lines. Picks one of the four beat phases. */
export function estimateDownbeat(frames: FrameFeatures[], hopSec: number, beatsSec: number[]):
  { beat: number; confidence: number } {
  const beatSec = (beatsSec[1] ?? 0) - (beatsSec[0] ?? 0)
  const chromas = beatsSec.map(t => meanChroma(frames, hopSec, t, t + beatSec))
  const change = chromas.map((c, k) => k === 0 ? 0 : 1 - c.reduce((sum, v, i) => sum + v * chromas[k - 1]![i]!, 0))
  const onset = beatsSec.map(t => fluxAt(frames, hopSec, t))
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
  const changeAll = mean(change.slice(1)) || 1
  const onsetAll = mean(onset) || 1
  const scores = Array.from({ length: BEATS_PER_BAR }, (_, phase) => {
    const ks = change.map((_, k) => k).filter(k => k >= 1 && k % BEATS_PER_BAR === phase)
    return mean(ks.map(k => change[k]!)) / changeAll + 0.5 * mean(ks.map(k => onset[k]!)) / onsetAll
  })
  const ranked = scores.map((score, beat) => ({ score, beat })).sort((a, b) => b.score - a.score)
  const best = ranked[0]!
  const second = ranked[1]?.score ?? 0
  return { beat: best.beat, confidence: best.score > 0 ? Math.max(0, Math.min(1, (best.score - second) / best.score * 4)) : 0 }
}

function barFeatures(frames: FrameFeatures[], hopSec: number, startSec: number, endSec: number) {
  const a = Math.max(0, Math.floor(startSec / hopSec))
  const b = Math.min(frames.length, Math.max(a + 1, Math.floor(endSec / hopSec)))
  let rms = 0
  let centroid = 0
  let flux = 0
  for (let i = a; i < b; i++) {
    rms += frames[i]!.rms
    centroid += frames[i]!.centroid
    flux += frames[i]!.flux
  }
  const n = Math.max(1, b - a)
  return {
    loudnessDb: 20 * Math.log10(rms / n + 1e-9),
    brightness: centroid / n,
    density: flux / n,
    chroma: [...meanChroma(frames, hopSec, startSec, endSec)],
  }
}

export function analyzeSongMap(input: SongMapInput): SongMap {
  const { samples, sampleRate } = input
  const durationSec = samples.length / sampleRate
  const ctx = jumpContext(samples, sampleRate, input.bpmOverride)
  const { flux, frames, hopSec, bpm } = ctx
  const beatSec = 60 / bpm
  const beatsSec: number[] = []
  for (let t = estimateBeatOffsetSec(flux, hopSec, bpm); t <= durationSec - 0.1; t += beatSec) beatsSec.push(t)
  const downbeat = estimateDownbeat(frames, hopSec, beatsSec)
  const bars: SongBar[] = []
  for (let startBeat = downbeat.beat; startBeat + BEATS_PER_BAR < beatsSec.length; startBeat += BEATS_PER_BAR) {
    const startSec = beatsSec[startBeat]!
    const endSec = beatsSec[startBeat + BEATS_PER_BAR]!
    bars.push({ index: bars.length, startBeat, startSec, endSec, ...barFeatures(frames, hopSec, startSec, endSec) })
  }

  const jumpModel = input.jumpModel ?? TRAINED_JUMP_MODEL
  const perExit = input.jumpsPerExit ?? DEFAULT_JUMPS_PER_EXIT
  const jumps: SongJump[] = []
  for (let exitBeat = 1; exitBeat < beatsSec.length; exitBeat++) {
    const options: SongJump[] = []
    for (let entryBeat = exitBeat % BEATS_PER_BAR; entryBeat < beatsSec.length; entryBeat += BEATS_PER_BAR) {
      if (entryBeat === exitBeat) continue
      const x = jumpFeatures(ctx, beatsSec[exitBeat]!, beatsSec[entryBeat]!, CUT_FADE_SEC)
      options.push({ exitBeat, entryBeat, pGoodCut: predictGood(jumpModel, x),
        pGoodBlended: predictGood(jumpModel, withFade(x, BLEND_FADE_SEC)),
        seam: x.seam, vibe: x.vibe, join: x.join, closure: x.closure, loudnessChangeDb: x.loudnessChangeDb })
    }
    jumps.push(...options.sort((a, b) => b.pGoodCut - a.pGoodCut || b.pGoodBlended - a.pGoodBlended).slice(0, perExit))
  }
  return {
    version: SONG_MAP_VERSION,
    durationSec,
    sampleRate,
    bpm,
    beatsSec,
    downbeatBeat: downbeat.beat,
    downbeatConfidence: downbeat.confidence,
    bars,
    jumpModel: jumpModel.version,
    jumps,
  }
}
