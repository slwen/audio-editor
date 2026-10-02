import { getProjectEndTime } from '@/lib/clipMath'
import type { Clip } from '@/types'

/** Must match timeline `tx` / `xt` padding (same constant as canvas left gutter). */
export const TIMELINE_PAD_L = 8
export const TIMELINE_PAD_R = 48

/** Zoom limits in pixels per second. The floor is half the old 10 px/s limit. */
export const MIN_PIXELS_PER_SECOND = 5
export const MAX_PIXELS_PER_SECOND = 500

export function clampPixelsPerSecond(pps: number): number {
  return Math.max(MIN_PIXELS_PER_SECOND, Math.min(MAX_PIXELS_PER_SECOND, pps))
}

/** Maximum `scrollX` (px) so the right edge of the project can reach the viewport. */
export function maxTimelineScrollPx(canvasCssWidth: number, clips: Clip[], pps: number): number {
  const end = getProjectEndTime(clips)
  const contentW = end * pps + TIMELINE_PAD_L + TIMELINE_PAD_R
  return Math.max(0, contentW - canvasCssWidth)
}

/** `scrollX` so the playhead sits near the horizontal center (clamped at start/end). */
export function scrollForPlayheadCentered(
  playheadSec: number,
  canvasCssWidth: number,
  clips: Clip[],
  pps: number
): number {
  const maxS = maxTimelineScrollPx(canvasCssWidth, clips, pps)
  const ideal = playheadSec * pps + TIMELINE_PAD_L - canvasCssWidth / 2
  return Math.max(0, Math.min(maxS, ideal))
}
