import {
  buildTransitionModel,
  estimateTempoBpm,
  extractHopFeatures,
  scoreJump,
  type FrameFeatures,
  type TransitionModel,
} from '@/loop/detectLoops'
import { DEFAULT_VIBE_WINDOW_SEC } from '@/loop/types'

/** Listening shows a crossfade this long hides splices that fail as a cut. */
export const BLEND_MIN_SEC = 0.3

/** Everything needed to score any jump in one song. Build once per song. */
export type JumpContext = {
  samples: Float32Array
  sampleRate: number
  frames: FrameFeatures[]
  flux: Float32Array
  hopSec: number
  model: TransitionModel
  bpm: number
}

export function jumpContext(samples: Float32Array, sampleRate: number, bpmOverride?: number): JumpContext {
  const { flux, frames, hopSec } = extractHopFeatures(samples, sampleRate)
  const bpm = bpmOverride ?? estimateTempoBpm(flux, hopSec)
  const model = buildTransitionModel(frames, hopSec, 60 / bpm, DEFAULT_VIBE_WINDOW_SEC)
  return { samples, sampleRate, frames, flux, hopSec, model, bpm }
}

export const JUMP_FEATURES = [
  'seam',
  'vibe',
  'join',
  'closure',
  'logQuality',
  /** Arrival minus departure, one beat either side. Negative is a drop in level. */
  'loudnessChangeDb',
  'absLoudnessChangeDb',
  'densityChange',
  /** 1 when the join is crossfaded over at least BLEND_MIN_SEC, else 0 (a cut or click repair). */
  'blended',
  'closureIfBlended',
  'closureIfCut',
] as const
export type JumpFeatureName = typeof JUMP_FEATURES[number]
export type JumpFeatures = Record<JumpFeatureName, number>

function meanOver(ctx: JumpContext, startSec: number, endSec: number): { db: number; density: number } {
  const a = Math.max(0, Math.floor(startSec / ctx.hopSec))
  const b = Math.min(ctx.frames.length, Math.max(a + 1, Math.floor(endSec / ctx.hopSec)))
  let rms = 0
  let density = 0
  for (let i = a; i < b; i++) {
    rms += ctx.frames[i]!.rms
    density += ctx.frames[i]!.flux
  }
  const n = Math.max(1, b - a)
  return { db: 20 * Math.log10(rms / n + 1e-9), density: density / n }
}

export function jumpFeatures(ctx: JumpContext, exitSec: number, entrySec: number, fadeSec: number): JumpFeatures {
  const score = scoreJump(ctx.samples, ctx.sampleRate, ctx.frames, ctx.hopSec, ctx.model, ctx.bpm, exitSec, entrySec)
  const beatSec = 60 / ctx.bpm
  const before = meanOver(ctx, exitSec - beatSec, exitSec)
  const after = meanOver(ctx, entrySec, entrySec + beatSec)
  const loudnessChangeDb = after.db - before.db
  return withFade({
    seam: score.seamScore,
    vibe: score.vibeScore,
    join: score.joinScore,
    closure: score.closureScore,
    logQuality: Math.log(Math.max(1e-4, score.qualityScore)),
    loudnessChangeDb,
    absLoudnessChangeDb: Math.abs(loudnessChangeDb),
    densityChange: after.density - before.density,
    blended: 0,
    closureIfBlended: 0,
    closureIfCut: 0,
  }, fadeSec)
}

/** The same audio features joined with a different crossfade. */
export function withFade(x: JumpFeatures, fadeSec: number): JumpFeatures {
  const blended = fadeSec >= BLEND_MIN_SEC ? 1 : 0
  return { ...x, blended, closureIfBlended: blended * x.closure, closureIfCut: (1 - blended) * x.closure }
}
