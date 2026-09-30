import { expect, it } from 'vitest'
import { buildTransitionModel, extractHopFeatures, scoreJump } from '@/loop/detectLoops'
import { analyzeSongMap, BEATS_PER_BAR, trackBeats } from './songMap'

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

it('tracks beats that drift off the global tempo', () => {
  // 120 BPM for 30 s, then 0.5% faster: a fixed grid is 75 ms out by the end.
  const beatAt = (k: number) => k <= 60 ? k * BEAT_SEC : 30 + (k - 60) * BEAT_SEC / 1.005
  const samples = new Float32Array(SR * 60)
  const truth: number[] = []
  for (let k = 0; beatAt(k) < 59.9; k++) {
    truth.push(beatAt(k))
    const start = Math.round(beatAt(k) * SR)
    for (let i = 0; i < SR * 0.03 && start + i < samples.length; i++) samples[start + i] = Math.sin(i * 0.9) * Math.exp(-i / SR * 150)
  }
  const { flux, hopSec } = extractHopFeatures(samples, SR)
  const beats = trackBeats(flux, hopSec, 120, 60)
  // Onset frames lag the audio by a constant; only a change in that lag moves a wrap.
  const offset = (t: number) => beats.reduce((best, b) => Math.abs(b - t) < Math.abs(best - t) ? b : best, Infinity) - t
  const early = offset(10)
  for (const t of truth.filter(t => t > 40 && t < 58)) expect(Math.abs(offset(t) - early)).toBeLessThan(0.02)
})

it('lists only meter-preserving jumps on the beat grid', () => {
  const map = analyzeSongMap({ samples: abaSong(), sampleRate: SR, jumpsPerExit: 4 })
  expect(map.bpm).toBeCloseTo(120, 0)
  expect((map.beatsSec.at(-1)! - map.beatsSec[0]!) / (map.beatsSec.length - 1)).toBeCloseTo(BEAT_SEC, 2)
  expect(map.jumps.length).toBeGreaterThan(0)
  for (const jump of map.jumps) {
    expect(Math.abs(jump.exitBeat - jump.entryBeat) % BEATS_PER_BAR).toBe(0)
    expect(jump.exitBeat).not.toBe(jump.entryBeat)
  }
  const fromMidA = map.jumps.filter(jump => Math.abs(map.beatsSec[jump.exitBeat]! - 10) < 0.26)
  const bestEntrySec = map.beatsSec[fromMidA[0]!.entryBeat]!
  expect(bestEntrySec < 16 || bestEntrySec >= 32).toBe(true)
})
