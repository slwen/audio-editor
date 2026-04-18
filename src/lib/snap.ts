import { clipTimelineEnd } from '@/lib/clipMath'
import type { Clip } from '@/types'

/** Stitch snap: dragged clip start meets another clip end on same row. */
const EDGE_SNAP_PX = 5

export function edgeSnapStart(
  clips: Clip[],
  moving: Clip,
  candidateStart: number,
  pixelsPerSecond: number
): number {
  const threshSec = EDGE_SNAP_PX / pixelsPerSecond
  let best = candidateStart
  let bestAbs = threshSec

  for (const o of clips) {
    if (o.id === moving.id || o.row !== moving.row) continue
    const endO = clipTimelineEnd(o)
    const dStartToEnd = Math.abs(candidateStart - endO)
    if (dStartToEnd < bestAbs) {
      bestAbs = dStartToEnd
      best = endO
    }
  }

  return Math.max(0, best)
}
