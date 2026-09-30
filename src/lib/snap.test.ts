import { describe, expect, it } from 'vitest'
import type { Clip } from '@/types'
import { snapClipDragDelta } from './snap'

function clip(id: string, startTime: number, overrides: Partial<Clip> = {}): Clip {
  return {
    id, bufferId: 'audio', startTime, row: 0, layerIndex: 0,
    trimStart: 0, trimEnd: 2, speed: 1, gain: 1, fadeInSec: 0, fadeOutSec: 0,
    ...overrides,
  }
}

describe('clip dragging', () => {
  it('preserves fine movement without quantizing to a time grid', () => {
    const moving = clip('moving', 3.017)
    expect(snapClipDragDelta([moving], [moving], 0.0137, 80, 20)).toBe(0.0137)
  })

  it('joins a start to an exact trimmed, speed-adjusted end', () => {
    const other = clip('other', 1.013, { trimStart: 0.5, trimEnd: 3.5, speed: 2 })
    const moving = clip('moving', 4)
    const delta = snapClipDragDelta([other, moving], [moving], -1.467, 80, 20)
    expect(moving.startTime + delta).toBeCloseTo(2.513, 12)
  })

  it('joins a dragged end to another clip start', () => {
    const other = clip('other', 8.123)
    const moving = clip('moving', 3, { speed: 2 })
    expect(snapClipDragDelta([other, moving], [moving], 4.1, 80, 20)).toBeCloseTo(4.123)
  })

  it.each([0, 2])('aligns either edge with the playhead (edge offset %s)', (edge) => {
    const moving = clip('moving', 3)
    const delta = snapClipDragDelta([moving], [moving], 2.023 - edge, 80, 5)
    expect(moving.startTime + delta + edge).toBe(5)
  })

  it('snaps only to clips on the destination row', () => {
    const moving = clip('moving', 3, { row: 1 })
    const other = clip('other', 3)
    expect(snapClipDragDelta([other], [moving], 2.023, 80, 20)).toBe(2.023)
    expect(snapClipDragDelta([clip('other', 3, { row: 1 })], [moving], 2.023, 80, 20)).toBe(2)
  })

  it('chooses the nearest edge or playhead target', () => {
    const moving = clip('moving', 3)
    const other = clip('other', 3)
    expect(snapClipDragDelta([other], [moving], 2.027, 80, 5.03)).toBeCloseTo(2.03)
  })

  it('uses the stronger snap zone for both a neighboring clip and the playhead', () => {
    const moving = clip('moving', 3)
    expect(snapClipDragDelta([clip('other', 3)], [moving], 2.08, 80, 20)).toBe(2)
    expect(snapClipDragDelta([], [moving], 2.08, 80, 5)).toBe(2)
  })

  it('releases snapping outside the small pixel radius', () => {
    const moving = clip('moving', 3)
    expect(snapClipDragDelta([], [moving], 2.03, 400, 5)).toBe(2.03)
    expect(snapClipDragDelta([], [moving], 2.015, 400, 5)).toBe(2)
  })

  it('caps the time radius when zoomed out', () => {
    const moving = clip('moving', 3)
    expect(snapClipDragDelta([], [moving], 2.16, 10, 5)).toBe(2.16)
    expect(snapClipDragDelta([], [moving], 2.08, 10, 5)).toBe(2)
  })

  it('allows the modifier key to bypass both kinds of snapping', () => {
    const moving = clip('moving', 3)
    expect(snapClipDragDelta([clip('other', 3)], [moving], 2.023, 80, 5, false)).toBe(2.023)
  })

  it('snaps any selected clip while keeping the group spacing fixed', () => {
    const moving = [clip('a', 3), clip('b', 8, { row: 1 })]
    const other = clip('other', 8, { row: 1 })
    const delta = snapClipDragDelta([other, ...moving], moving, 2.023, 80, 20)
    expect(delta).toBe(2)
    expect(moving.map((c) => c.startTime + delta)).toEqual([5, 10])
  })

  it('ignores snap targets inside the dragged selection', () => {
    const moving = [clip('a', 3), clip('b', 5)]
    expect(snapClipDragDelta(moving, moving, 0.023, 80, 20)).toBe(0.023)
  })

  it('stops the entire group at zero and rejects snaps that cross it', () => {
    const moving = [clip('a', 0.02), clip('b', 5)]
    expect(snapClipDragDelta([], moving, -1, 80, 20)).toBe(-0.02)
    expect(snapClipDragDelta([], moving, 0, 80, 4.97)).toBe(0)
  })
})
