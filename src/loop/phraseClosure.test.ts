import { expect, it } from 'vitest'
import { extractHopFeatures, scorePhraseClosure } from './detectLoops'

it('detects a changing background under an unchanged loud foreground', () => {
  const sr = 8000
  const samples = new Float32Array(sr * 12)
  for (let i = 0; i < samples.length; i++) {
    const t = i / sr
    const foreground = 0.65 * Math.sin(2 * Math.PI * 110 * t)
    const pad = (t > 7 ? 0.16 : 0.02) * Math.sin(2 * Math.PI * 1600 * t)
    samples[i] = foreground + pad
  }
  const { frames, hopSec } = extractHopFeatures(samples, sr)
  const stable = scorePhraseClosure(frames, hopSec, 2, 4, 1)!
  const swell = scorePhraseClosure(frames, hopSec, 2, 8, 1)!
  expect(stable).toBeGreaterThan(0.95)
  expect(swell).toBeLessThan(stable - 0.1)
})

it('compares corresponding phases, not a downbeat against the preceding upbeat', () => {
  const sr = 8000
  const samples = new Float32Array(sr * 12)
  for (let i = 0; i < samples.length; i++) {
    const t = i / sr
    const hz = (t % 2) < 1 ? 220 : 880
    samples[i] = 0.4 * Math.sin(2 * Math.PI * hz * t)
  }
  const { frames, hopSec } = extractHopFeatures(samples, sr)
  const wholePhrase = scorePhraseClosure(frames, hopSec, 2, 6, 0.8)!
  const wrongPhase = scorePhraseClosure(frames, hopSec, 2, 7, 0.8)!
  expect(wholePhrase).toBeGreaterThan(wrongPhase + 0.2)
})
