import { clipTimelineDuration, clipTimelineEnd } from '@/lib/clipMath'
import type { Clip } from '@/types'

// Keep the magnet small on screen and avoid broad time jumps when zoomed out.
const SNAP_PX = 8
const MAX_SNAP_SEC = 0.12

/** Return one shared movement delta, preserving spacing between selected clips. */
export function snapClipDragDelta(
  clips: Clip[],
  moving: Clip[],
  candidateDelta: number,
  pixelsPerSecond: number,
  playhead: number,
  snapOn = true
): number {
  if (moving.length === 0) return candidateDelta
  const minDelta = -Math.min(...moving.map((clip) => clip.startTime))
  const delta = Math.max(minDelta, candidateDelta)
  if (!snapOn) return delta
  let best = delta
  let bestAbs = Math.min(MAX_SNAP_SEC, SNAP_PX / pixelsPerSecond)
  const movingIds = new Set(moving.map((clip) => clip.id))
  const stationary = clips.filter((clip) => !movingIds.has(clip.id))

  const consider = (targetDelta: number) => {
    const distance = Math.abs(targetDelta - delta)
    if (targetDelta >= minDelta && distance < bestAbs) {
      bestAbs = distance
      best = targetDelta
    }
  }

  for (const clip of moving) {
    const end = clip.startTime + clipTimelineDuration(clip)
    for (const other of stationary) {
      if (other.row !== clip.row) continue
      consider(clipTimelineEnd(other) - clip.startTime)
      consider(other.startTime - end)
    }
    // Either edge can align with the playhead, on any row.
    consider(playhead - clip.startTime)
    consider(playhead - end)
  }

  return best
}
