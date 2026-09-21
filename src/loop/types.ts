import type { BufferId, ClipId } from '@/types'

export type LoopBarLength = 4 | 8 | 16

export type LoopBarFilter = 'all' | LoopBarLength
export type LoopLengthFilter = 'all' | 'short' | 'medium' | 'long'

export type LoopCandidate = {
  id: string
  /** Source-buffer time (seconds). */
  startSec: number
  endSec: number
  bars: LoopBarLength
  /** 0..1, splice continuity at the wrap. */
  seamScore: number
  /** 0..1, first vs last bars (harmony/timbre vibe). */
  contextScore: number
  /** 0..1, internal section stability (no mid-loop scene change). */
  homogeneityScore: number
  /** Weighted musical quality used for ranking and the quality filter. */
  qualityScore: number
  bpm: number
}

export type LoopSessionStatus = 'idle' | 'analyzing' | 'ready' | 'error'

export type LoopSession = {
  sourceClipId: ClipId
  bufferId: BufferId
  sourceName: string
  trimStart: number
  trimEnd: number
  bpm: number | null
  /** Time of beat 0 in source-buffer seconds. */
  beatOffsetSec: number | null
  status: LoopSessionStatus
  errorMessage?: string
  candidates: LoopCandidate[]
  selectedIds: string[]
  previewId: string | null
  wrapCrossfadeSec: number
  normalizeExport: boolean
  minQuality: number
  /** Minimum wrap-vibe (contextScore). */
  minVibe: number
  /** Seconds sampled after the start and before the end for vibe match. */
  vibeWindowSec: number
  barFilter: LoopBarFilter
  lengthFilter: LoopLengthFilter
}

/** Seconds of audio after the loop start compared with the same length before the end. */
export const VIBE_WINDOW_MIN_SEC = 0.5
export const VIBE_WINDOW_MAX_SEC = 8
export const DEFAULT_VIBE_WINDOW_SEC = 2

export function clampVibeWindowSec(sec: number): number {
  if (!Number.isFinite(sec)) return DEFAULT_VIBE_WINDOW_SEC
  return Math.min(VIBE_WINDOW_MAX_SEC, Math.max(VIBE_WINDOW_MIN_SEC, sec))
}

export type DetectLoopsInput = {
  samples: Float32Array
  sampleRate: number
  /** How many seconds after the start must match the seconds before the end. */
  vibeWindowSec?: number
}

export type DetectedLoop = {
  startSec: number
  endSec: number
  bars: LoopBarLength
  seamScore: number
  contextScore: number
  homogeneityScore: number
  qualityScore: number
}

export type DetectLoopsResult = {
  bpm: number
  beatOffsetSec: number
  candidates: DetectedLoop[]
}

export type DetectWorkerRequest = DetectLoopsInput & { requestId: number }
export type DetectWorkerResponse =
  | { requestId: number; ok: true; result: DetectLoopsResult }
  | { requestId: number; ok: false; error: string }
