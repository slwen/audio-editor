import { describe, expect, it } from 'vitest'
import { encoderOffsets, naturalEndFrames, offsetSpread, TAIL_SEC } from './exportChecks'

const SR = 1000

describe('naturalEndFrames', () => {
  it('ends a second after the last sound', () => {
    const ch = new Float32Array(20 * SR)
    ch.fill(0.5, 0, 10 * SR)
    expect(naturalEndFrames([ch, ch], SR, 0)).toBe(10 * SR + TAIL_SEC * SR)
  })

  it('never cuts into the loop and never grows the file', () => {
    const ch = new Float32Array(20 * SR)
    ch.fill(0.5, 0, 5 * SR)
    expect(naturalEndFrames([ch], SR, 12)).toBe(12 * SR)
    expect(naturalEndFrames([new Float32Array(20 * SR).fill(0.5)], SR, 0)).toBe(20 * SR)
  })
})

describe('encoderOffsets', () => {
  it('finds a constant encoder delay', () => {
    const sr = 8000
    let seed = 1
    const noise = Float32Array.from({ length: 10 * sr }, () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5 })
    const delayed = new Float32Array(noise.length)
    delayed.set(noise.subarray(0, noise.length - 40), 40)
    const offsets = encoderOffsets(noise, delayed, sr)
    expect(offsets.every(o => Math.abs(o - 40 / sr) < 1e-9)).toBe(true)
    expect(offsetSpread(offsets)).toBe(0)
  })
})
