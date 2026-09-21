import { describe, expect, it } from 'vitest'
import {
  combineQuality,
  detectLoopCandidates,
  estimateTempoBpm,
  foldBpm,
  joinPreviewOffset,
  pickLagPeaks,
  scoreLoopWindow,
  scoreSeam,
  spectralFlux,
  suppressNearDuplicates,
} from '@/loop/detectLoops'
import { bakeWrapEqualPower, peakNormalize } from '@/loop/wrapLoop'

function clickTrack(sampleRate: number, bpm: number, seconds: number): Float32Array {
  const n = Math.floor(sampleRate * seconds)
  const out = new Float32Array(n)
  const period = Math.round((60 / bpm) * sampleRate)
  const click = Math.floor(sampleRate * 0.004)
  for (let t = 0; t < n; t += period) {
    for (let i = 0; i < click && t + i < n; i++) {
      out[t + i] = i === 0 ? 1 : 0.4 * (1 - i / click)
    }
  }
  return out
}

function twoIdenticalBars(sampleRate: number, barSec: number): Float32Array {
  const nBar = Math.floor(sampleRate * barSec)
  const bar = new Float32Array(nBar)
  for (let i = 0; i < nBar; i++) {
    const t = i / sampleRate
    bar[i] = 0.4 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 330 * t)
  }
  const out = new Float32Array(nBar * 2)
  out.set(bar, 0)
  out.set(bar, nBar)
  return out
}

describe('foldBpm', () => {
  it('folds harmonics into 70–180', () => {
    expect(foldBpm(60)).toBe(120)
    expect(foldBpm(240)).toBe(120)
    expect(foldBpm(120)).toBe(120)
  })
})

describe('tempo', () => {
  it('estimates 120 BPM from a click track', () => {
    const sr = 22050
    const samples = clickTrack(sr, 120, 8)
    const flux = spectralFlux(samples)
    const hopSec = 256 / sr
    const bpm = estimateTempoBpm(flux, hopSec)
    expect(bpm).toBeGreaterThan(110)
    expect(bpm).toBeLessThan(130)
  })
})

describe('seam score', () => {
  it('scores a concatenated identical bar as a clean wrap', () => {
    const sr = 22050
    const barSec = 2
    const samples = twoIdenticalBars(sr, barSec)
    const good = scoreSeam(samples, sr, 0, barSec, 120)
    expect(good).toBeGreaterThan(0.75)
  })

  it('scores a wrap through a hard transient as worse than a matching wrap', () => {
    const sr = 22050
    const n = sr * 4
    const samples = new Float32Array(n)
    for (let i = 0; i < n; i++) samples[i] = 0.05 * Math.sin((2 * Math.PI * i) / 40)
    samples[0] = 1
    samples[1] = -1
    const bad = scoreSeam(samples, sr, 0, 2, 120)
    const barSec = 2
    const good = scoreSeam(twoIdenticalBars(sr, barSec), sr, 0, barSec, 120)
    expect(good).toBeGreaterThan(bad)
  })
})

describe('joinPreviewOffset', () => {
  it('starts one bar before the end', () => {
    expect(joinPreviewOffset(0, 8, 120)).toBeCloseTo(6, 5)
  })
})

describe('pickLagPeaks', () => {
  it('keeps separated high scores', () => {
    const scores = [0.2, 0.9, 0.88, 0.1, 0.85, 0.2]
    expect(pickLagPeaks(scores, 0.5, 2)).toEqual([1, 4])
  })
})

describe('detectLoopCandidates', () => {
  it('finds loops in a repeating groove and not only in a two-section jump', () => {
    const sr = 22050
    const barSec = 2
    const nBar = Math.floor(sr * barSec)
    const tone = (hz: number, n: number) => {
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = 0.35 * Math.sin((2 * Math.PI * hz * i) / sr)
      return out
    }
    const samples = new Float32Array(nBar * 12)
    const a = tone(220, nBar)
    const b = tone(880, nBar)
    for (let i = 0; i < 12; i++) samples.set(i < 8 ? a : b, i * nBar)
    const result = detectLoopCandidates({ samples, sampleRate: sr })
    expect(result.candidates.length).toBeGreaterThan(0)
    const midJump = 8 * barSec
    const coveringJump = result.candidates.filter(
      (c) => c.startSec < midJump - 1 && c.endSec > midJump + 1
    )
    const inGroove = result.candidates.filter((c) => c.endSec <= midJump + 0.6)
    expect(inGroove.length).toBeGreaterThan(0)
    if (coveringJump.length && inGroove.length) {
      const bestJump = Math.max(...coveringJump.map((c) => c.qualityScore))
      const bestGroove = Math.max(...inGroove.map((c) => c.qualityScore))
      expect(bestGroove).toBeGreaterThanOrEqual(bestJump)
    }
  })

  it('returns bar-aligned candidates on a loopable click pattern', () => {
    const sr = 22050
    const samples = clickTrack(sr, 120, 20)
    const result = detectLoopCandidates({ samples, sampleRate: sr })
    expect(result.bpm).toBeGreaterThan(110)
    expect(result.bpm).toBeLessThan(130)
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.candidates.length).toBeLessThanOrEqual(36)
    for (const c of result.candidates) {
      expect(c.endSec - c.startSec).toBeGreaterThan(1.9)
      expect([4, 8, 16]).toContain(c.bars)
      expect(c.qualityScore).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('suppressNearDuplicates', () => {
  it('keeps the higher-scoring overlapping window of the same length', () => {
    const kept = suppressNearDuplicates(
      [
        {
          startSec: 0,
          endSec: 8,
          bars: 4,
          seamScore: 0.9,
          contextScore: 0.2,
          homogeneityScore: 0.2,
          qualityScore: 0.4,
        },
        {
          startSec: 0.2,
          endSec: 8.2,
          bars: 4,
          seamScore: 0.5,
          contextScore: 0.9,
          homogeneityScore: 0.9,
          qualityScore: 0.9,
        },
      ],
      12
    )
    expect(kept).toHaveLength(1)
    expect(kept[0]?.qualityScore).toBe(0.9)
  })
})

describe('musical context', () => {
  it('scores a repeating groove higher than a two-section jump of the same length', () => {
    const sr = 22050
    const barSec = 2
    const nBar = Math.floor(sr * barSec)
    const tone = (hz: number, n: number) => {
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = 0.35 * Math.sin((2 * Math.PI * hz * i) / sr)
      return out
    }
    const stable = new Float32Array(nBar * 4)
    const jumped = new Float32Array(nBar * 4)
    const a = tone(220, nBar)
    const b = tone(880, nBar)
    for (let i = 0; i < 4; i++) {
      stable.set(a, i * nBar)
      jumped.set(i < 2 ? a : b, i * nBar)
    }
    const dur = 8
    const good = scoreLoopWindow(stable, sr, 0, dur, 120)
    const stark = scoreLoopWindow(jumped, sr, 0, dur, 120)
    expect(good.homogeneityScore).toBeGreaterThan(stark.homogeneityScore)
    expect(good.contextScore).toBeGreaterThan(stark.contextScore)
    expect(good.qualityScore).toBeGreaterThan(stark.qualityScore)
  })

  it('does not let a perfect seam rescue a vibe jump', () => {
    expect(combineQuality(1, 0.3, 1)).toBeLessThan(0.4)
    expect(combineQuality(1, 0.9, 0.9)).toBeGreaterThan(0.7)
  })

  it('slides the loop point off a silence gap in a repeating pattern', () => {
    const sr = 22050
    const cycle = 8
    const seconds = cycle * 4
    const n = Math.floor(sr * seconds)
    const samples = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const t = i / sr
      const phase = t % cycle
      const gap = phase < 0.1
      samples[i] = gap ? 0 : 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr)
    }
    const result = detectLoopCandidates({ samples, sampleRate: sr })
    const fours = result.candidates.filter((c) => c.bars === 4)
    expect(fours.length).toBeGreaterThan(0)
    const best = fours.reduce((a, b) => (a.qualityScore >= b.qualityScore ? a : b))
    const phase = ((best.startSec % cycle) + cycle) % cycle
    const distToGap = Math.min(phase, cycle - phase)
    expect(distToGap).toBeGreaterThan(0.2)
  })

  it('a longer vibe window catches a loudness change the boundary misses', () => {
    const sr = 22050
    const dur = 8
    const n = sr * dur
    const samples = new Float32Array(n)
    const ampAt = (t: number) => {
      if (t < 0.5) return 0.12
      if (t < 4) return 0.85
      return 0.12
    }
    for (let i = 0; i < n; i++) {
      const t = i / sr
      samples[i] = ampAt(t) * Math.sin((2 * Math.PI * 220 * i) / sr)
    }
    const edge = scoreLoopWindow(samples, sr, 0, dur, 120, undefined, undefined, 0.5)
    const wide = scoreLoopWindow(samples, sr, 0, dur, 120, undefined, undefined, 3)
    expect(edge.contextScore).toBeGreaterThan(0.7)
    expect(wide.contextScore).toBeLessThan(edge.contextScore - 0.2)
  })
})

describe('wrapLoop', () => {
  it('mixes tail onto head without changing length', () => {
    const ch = new Float32Array([1, 1, 1, 1, 0, 0, 0, 0])
    bakeWrapEqualPower(ch, 4)
    expect(ch.length).toBe(8)
    expect(ch[0]).toBeCloseTo(0, 5)
    expect(ch[3]).toBeCloseTo(1, 5)
  })

  it('peak-normalizes to the target', () => {
    const a = new Float32Array([0.2, -0.1])
    peakNormalize([a], 0.8)
    expect(Math.max(...a.map(Math.abs))).toBeCloseTo(0.8, 5)
  })
})
