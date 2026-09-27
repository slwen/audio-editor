import { describe, expect, it } from 'vitest'
import { blendSec, clampFade, fadeCurve, fadeGain, sourceTimeAt } from './wrap'

describe('fadeGain', () => {
  it('is equal-power for real blends', () => {
    for (const x of [0, 0.25, 0.5, 0.9]) {
      expect(fadeGain(x, 1, true) ** 2 + fadeGain(x, 1, false) ** 2).toBeCloseTo(1, 10)
    }
  })

  it('is linear for click repairs', () => {
    expect(fadeGain(0.25, 0.035, true)).toBeCloseTo(0.25)
    expect(fadeGain(0.25, 0.035, false)).toBeCloseTo(0.75)
  })

  it('samples a rising curve from 0 to 1', () => {
    const curve = fadeCurve(1, true, 5)
    expect(curve[0]).toBe(0)
    expect(curve[4]).toBeCloseTo(1)
  })
})

describe('blendSec', () => {
  it('turns beat-based choices into seconds', () => {
    expect(blendSec('beat', 120)).toBe(0.5)
    expect(blendSec('bar', 120)).toBe(2)
    expect(blendSec('half-beat', 120)).toBe(0.25)
    expect(blendSec('click', 120)).toBe(0.035)
    expect(blendSec('second', 120)).toBe(1)
  })
})

describe('sourceTimeAt', () => {
  it('maps playing time to song position', () => {
    const loop = { startSec: 2, endSec: 6, fadeSec: 1 }
    expect(sourceTimeAt(loop, 3)).toBe(3)
    expect(sourceTimeAt(loop, 7)).toBe(3)
    expect(sourceTimeAt(loop, 11)).toBe(3)
  })
})

describe('clampFade', () => {
  it('keeps the fade inside the loop and the song', () => {
    expect(clampFade({ startSec: 0.2, endSec: 10, fadeSec: 1 }, 20)).toBeCloseTo(0.4)
    expect(clampFade({ startSec: 5, endSec: 19.9, fadeSec: 1 }, 20)).toBeCloseTo(0.2)
    expect(clampFade({ startSec: 5, endSec: 10, fadeSec: 1 }, 20)).toBe(1)
  })
})
