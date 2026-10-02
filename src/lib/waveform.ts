import { clampPlaybackSpeed, clipTimelineDuration } from '@/lib/clipMath'
import type { Clip } from '@/types'

/** Source-anchored columns keep the same peaks and scale after splitting or trimming. */
export function* waveformColumns(
  peaks: Float32Array,
  bufferDuration: number,
  clip: Pick<Clip, 'trimStart' | 'trimEnd' | 'speed'>,
  pixelsPerSecond: number,
  visibleStartPx: number,
  visibleEndPx: number,
): Generator<{ x: number; min: number; max: number }> {
  const buckets = peaks.length / 2
  if (buckets < 1 || bufferDuration <= 0 || pixelsPerSecond <= 0) return
  const sourceSecPerPixel = clampPlaybackSpeed(clip.speed) / pixelsPerSecond
  const startPx = Math.max(0, visibleStartPx)
  const endPx = Math.min(clipTimelineDuration(clip) * pixelsPerSecond, visibleEndPx)
  if (endPx <= startPx) return
  const first = Math.floor(clip.trimStart / sourceSecPerPixel + startPx)
  const last = Math.ceil(clip.trimStart / sourceSecPerPixel + endPx)
  const bucketsPerSec = buckets / bufferDuration
  for (let column = first; column < last; column++) {
    // Read the full source column even at a cut: clipping handles its visible portion.
    const from = Math.max(0, Math.min(buckets - 1, Math.floor(column * sourceSecPerPixel * bucketsPerSec)))
    const to = Math.max(from + 1, Math.min(buckets, Math.ceil((column + 1) * sourceSecPerPixel * bucketsPerSec)))
    let min = 0
    let max = 0
    for (let bucket = from; bucket < to; bucket++) {
      min = Math.min(min, peaks[bucket * 2]!)
      max = Math.max(max, peaks[bucket * 2 + 1]!)
    }
    yield { x: column - clip.trimStart / sourceSecPerPixel, min, max }
  }
}
