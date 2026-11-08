import type { FrameFeatures } from '@/loop/detectLoops'
import { estimateDownbeat, meanChroma, trackBeats } from '@/loop/beatTrack'

export { trackBeats }
import { jumpContext, jumpFeatures, withFade, type JumpContext } from './jumpFeatures'
import { predictGood, type JumpModel } from './jumpModel'
import { TRAINED_JUMP_MODEL } from './trainedJumpModel'

const SONG_MAP_VERSION = 'song-map-v2'
/** Probabilities are reported for a click-repair cut and for a one-bar-class blend. */
const CUT_FADE_SEC = 0.035
const BLEND_FADE_SEC = 1
export const BEATS_PER_BAR = 4
const DEFAULT_JUMPS_PER_EXIT = 8

type SongBar = {
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
type SongJump = {
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
  /** Tracked beats; they follow small tempo drift. */
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

export type SongGrid = {
  beatsSec: number[]
  downbeat: { beat: number; confidence: number }
  bars: SongBar[]
}

/** A tracked beat grid, its heuristic downbeat and per-bar features. */
export function songGrid(ctx: JumpContext, durationSec: number): SongGrid {
  const { flux, frames, hopSec, bpm } = ctx
  const beatsSec = trackBeats(flux, hopSec, bpm, durationSec)
  const downbeat = estimateDownbeat(frames, hopSec, beatsSec)
  const bars: SongBar[] = []
  for (let startBeat = downbeat.beat; startBeat + BEATS_PER_BAR < beatsSec.length; startBeat += BEATS_PER_BAR) {
    const startSec = beatsSec[startBeat]!
    const endSec = beatsSec[startBeat + BEATS_PER_BAR]!
    bars.push({ index: bars.length, startBeat, startSec, endSec, ...barFeatures(frames, hopSec, startSec, endSec) })
  }
  return { beatsSec, downbeat, bars }
}

export function analyzeSongMap(input: SongMapInput): SongMap {
  const { samples, sampleRate } = input
  const durationSec = samples.length / sampleRate
  const ctx = jumpContext(samples, sampleRate, input.bpmOverride)
  const { bpm } = ctx
  const { beatsSec, downbeat, bars } = songGrid(ctx, durationSec)

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
