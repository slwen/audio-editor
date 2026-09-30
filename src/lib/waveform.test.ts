import { describe, expect, it } from 'vitest'
import type { Clip } from '@/types'
import { clampPlaybackSpeed, clipTimelineEnd } from './clipMath'
import { waveformColumns } from './waveform'

const original: Clip = {
  id: 'original', bufferId: 'audio', startTime: 2.031, row: 0, layerIndex: 0,
  trimStart: 0.137, trimEnd: 5.983, speed: 1,
  gain: 1, fadeInSec: 0, fadeOutSec: 0,
}
const peaks = Float32Array.from({ length: 2000 }, (_, i) =>
  i % 2 === 0 ? -((i * 17) % 100) / 100 : ((i * 31) % 100) / 100)

describe('source-anchored waveform rendering', () => {
  it.each([0.2, 1, 1.37, 3])('preserves waveform positions and heights after a fractional split at speed %s', (speed) => {
    const clip = { ...original, speed }
    const pps = 80
    const splitTime = clip.startTime + 1.713
    const srcSplit = clip.trimStart + (splitTime - clip.startTime) * speed
    const left = { ...clip, trimEnd: srcSplit }
    const right = { ...clip, id: 'right', startTime: splitTime, trimStart: srcSplit }
    const before = Array.from(waveformColumns(peaks, 6, clip, pps, 0, Infinity))
    const byPosition = new Map(before.map((c) => [
      (clip.startTime * pps + c.x).toFixed(8), [c.min, c.max],
    ]))
    for (const part of [left, right]) {
      const columns = Array.from(waveformColumns(peaks, 6, part, pps, 0, Infinity))
      expect(columns.length).toBeGreaterThan(0)
      for (const c of columns) {
        expect([c.min, c.max]).toEqual(byPosition.get((part.startTime * pps + c.x).toFixed(8)))
      }
    }
    expect(clipTimelineEnd(right)).toBeCloseTo(clipTimelineEnd(clip), 12)
  })

  it('matches the same source region in a moved duplicate', () => {
    const duplicate = { ...original, id: 'copy', row: 1, startTime: 20 }
    expect(Array.from(waveformColumns(peaks, 6, duplicate, 150, 0, Infinity)))
      .toEqual(Array.from(waveformColumns(peaks, 6, original, 150, 0, Infinity)))
  })

  it('keeps transients between pixels when zoomed out', () => {
    const detailedPeaks = new Float32Array(200)
    detailedPeaks[2 * 7] = -0.8
    detailedPeaks[2 * 7 + 1] = 0.9
    const clip = { ...original, trimStart: 0, trimEnd: 1 }
    const columns = Array.from(waveformColumns(detailedPeaks, 1, clip, 10, 0, Infinity))
    expect(columns).toHaveLength(10)
    expect(columns[0]?.min).toBeCloseTo(-0.8)
    expect(columns[0]?.max).toBeCloseTo(0.9)
  })

  it('draws the same columns when scrolled or partially offscreen', () => {
    const all = Array.from(waveformColumns(peaks, 6, original, 80, 0, Infinity))
    const visible = Array.from(waveformColumns(peaks, 6, original, 80, 20.3, 40.7))
    expect(visible.length).toBeGreaterThan(0)
    for (const c of visible) expect(all).toContainEqual(c)
    expect(visible[0]!.x).toBeLessThanOrEqual(20.3)
    expect(visible.at(-1)!.x + 1).toBeGreaterThanOrEqual(40.7)
  })

  it('does not stretch clips shorter than the minimum displayed clip width', () => {
    const clip = { ...original, trimEnd: original.trimStart + 0.003 }
    const columns = Array.from(waveformColumns(peaks, 6, clip, 80, 0, Infinity))
    expect(columns.length).toBeGreaterThan(0)
    expect(columns.length).toBeLessThanOrEqual(2)
    for (const c of columns) {
      const sourceStart = clip.trimStart + c.x * clampPlaybackSpeed(clip.speed) / 80
      expect(sourceStart).toBeLessThan(clip.trimEnd)
    }
  })
})
