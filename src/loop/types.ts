import type { BufferId, ClipId } from '@/types'
import type { LoopRenderOptions } from './wrapLoop'

export type LoopBarLength = 1 | 2 | 4 | 6 | 8 | 12 | 16

export type LoopBarFilter = 'all' | 'beds' | LoopBarLength
export type LoopLengthFilter = 'all' | 'short' | 'medium' | 'long'

export const LOOP_FEELS = ['exploration', 'tension', 'combat', 'intensity', 'stinger'] as const
export type LoopFeel = typeof LOOP_FEELS[number]
export type LoopReviewFilter = 'all' | 'not-bad' | 'good' | 'bad' | 'unrated'
export const LOOP_ANALYSIS_VERSION = 'phase-closure-v1'

export type LoopCandidate = {
  id: string
  origin?: 'found' | 'saved'
  scoreVersion?: string
  scoreVibeWindowSec?: number
  savedRender?: { wrapCrossfadeSec: number; normalize: boolean }
  /** Source-buffer time (seconds). */
  startSec: number
  endSec: number
  bars: LoopBarLength
  /** 0..1, splice continuity at the wrap. */
  seamScore: number
  /** 0..1, wrap vibe × join continuity (jump smoothness). */
  contextScore: number
  /** 0..1, internal section stability (no mid-loop scene change). */
  homogeneityScore: number
  /** Weighted musical quality used for ranking and the quality filter. */
  qualityScore: number
  bpm: number
  closureScore?: number
}

export type LoopSessionStatus = 'idle' | 'analyzing' | 'ready' | 'error'

export type LoopSession = {
  sourceClipId: ClipId
  bufferId: BufferId
  sourceName: string
  trimStart: number
  trimEnd: number
  manualBpm: number | null
  bpm: number | null
  /** Time of beat 0 in source-buffer seconds. */
  beatOffsetSec: number | null
  status: LoopSessionStatus
  isRescoring: boolean
  errorMessage?: string
  feelFilter: 'all' | LoopFeel
  reviewFilter: LoopReviewFilter
  candidateView: 'found' | 'saved'
  candidates: LoopCandidate[]
  selectedIds: string[]
  previewId: string | null
  /** Audition edits keyed by source and cut, retained across detection reruns. */
  renderOverrides: Record<string, LoopRenderOptions>
  wrapCrossfadeSec: number
  normalizeExport: boolean
  minQuality: number
  /** Minimum wrap-vibe (contextScore). */
  minVibe: number
  /** Seconds of loudness before the cut that must match the arrival at the start. */
  vibeWindowSec: number
  barFilter: LoopBarFilter
  lengthFilter: LoopLengthFilter
}

/** Loudness contour compared just before the loop start and just before the loop end. */
export const VIBE_WINDOW_MIN_SEC = 0.25
export const VIBE_WINDOW_MAX_SEC = 4
export const DEFAULT_VIBE_WINDOW_SEC = 1.5

export function clampVibeWindowSec(sec: number): number {
  if (!Number.isFinite(sec)) return DEFAULT_VIBE_WINDOW_SEC
  return Math.min(VIBE_WINDOW_MAX_SEC, Math.max(VIBE_WINDOW_MIN_SEC, sec))
}

export type DetectLoopsInput = {
  bpmOverride?: number
  samples: Float32Array
  sampleRate: number
  /** How many seconds around the join to compare for wrap vibe. */
  vibeWindowSec?: number
}

export type DetectedLoop = {
  closureScore?: number
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

export type LoopScores = Pick<DetectedLoop, 'seamScore' | 'contextScore' | 'homogeneityScore' | 'qualityScore' | 'closureScore'>
export type RescoreWorkerRequest = {
  kind: 'rescore'
  requestId: number
  sourceRequestId: number
  startSec: number
  endSec: number
  bpm: number
  vibeWindowSec: number
}
export type RescoreWorkerResponse = { kind: 'rescore'; requestId: number } & (
  | { ok: true; scores: LoopScores }
  | { ok: false; error: string }
)
