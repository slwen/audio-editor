import { describe, expect, it } from 'vitest'
import { rulerStepSeconds } from './rulerTicks'

describe('timeline ruler tick spacing', () => {
  it('keeps second marks when labels have room', () => {
    expect(rulerStepSeconds(80, 48)).toBe(1)
  })

  it('uses readable wider intervals when zoomed out', () => {
    expect(rulerStepSeconds(20, 48)).toBe(5)
    expect(rulerStepSeconds(10, 48)).toBe(5)
    expect(rulerStepSeconds(10, 58)).toBe(10)
  })
})
