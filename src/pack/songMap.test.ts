import { expect, it } from 'vitest'
import { buildTransitionModel, extractHopFeatures, scoreJump } from '@/loop/detectLoops'
import { analyzeSongMap, BEATS_PER_BAR } from './songMap'

const SR = 8000
const BEAT_SEC = 0.5

/** 120 BPM clicks under sections A (0-16 s), B (16-32 s), A (32-48 s). */
function abaSong(): Float32Array {
  const samples = new Float32Array(SR * 48)
  let seed = 1
  for (let i = 0; i < samples.length; i++) {
    const t = i / SR
    const sinceBeat = t % BEAT_SEC
    seed = (seed * 1103515245 + 12345) % 2147483648
    const click = sinceBeat < 0.03 ? (seed / 2147483648 - 0.5) * Math.exp(-sinceBeat * 150) : 0
    const b = t >= 16 && t < 32
    const tone = b ? 0.3 * Math.sin(2 * Math.PI * 330 * t) + 0.2 * Math.sin(2 * Math.PI * 1320 * t)
      : 0.3 * Math.sin(2 * Math.PI * 220 * t)
    samples[i] = 0.6 * click + tone
  }
  return samples
}

it('scores a jump by whether both sides match, in either direction', () => {
  const samples = abaSong()
  const { frames, hopSec } = extractHopFeatures(samples, SR)
  const model = buildTransitionModel(frames, hopSec, BEAT_SEC, 1.5)
  const score = (exitSec: number, entrySec: number) =>
    scoreJump(samples, SR, frames, hopSec, model, 120, exitSec, entrySec).qualityScore
  const forwardWithinA = score(10, 38)
  const backwardWithinA = score(44, 6)
  const intoB = score(10, 22)
  expect(forwardWithinA).toBeGreaterThan(intoB + 0.1)
  expect(backwardWithinA).toBeGreaterThan(intoB + 0.1)
})

it('lists only meter-preserving jumps on one tempo grid', () => {
  const map = analyzeSongMap({ samples: abaSong(), sampleRate: SR, jumpsPerExit: 4 })
  expect(map.bpm).toBeCloseTo(120, 0)
  expect(map.beatsSec[1]! - map.beatsSec[0]!).toBeCloseTo(BEAT_SEC, 2)
  expect(map.jumps.length).toBeGreaterThan(0)
  for (const jump of map.jumps) {
    expect(Math.abs(jump.exitBeat - jump.entryBeat) % BEATS_PER_BAR).toBe(0)
    expect(jump.exitBeat).not.toBe(jump.entryBeat)
  }
  const fromMidA = map.jumps.filter(jump => Math.abs(map.beatsSec[jump.exitBeat]! - 10) < 0.26)
  const bestEntrySec = map.beatsSec[fromMidA[0]!.entryBeat]!
  expect(bestEntrySec < 16 || bestEntrySec >= 32).toBe(true)
})
