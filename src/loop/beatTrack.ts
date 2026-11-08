import type { FrameFeatures } from '@/loop/detectLoops'

const BEATS_PER_BAR = 4
/** Higher holds the beat period closer to the global tempo; librosa's default. */
const BEAT_TIGHTNESS = 100

function fluxAt(frames: FrameFeatures[], hopSec: number, sec: number): number {
  const x = sec / hopSec
  const i = Math.floor(x)
  if (i < 0 || i + 1 >= frames.length) return 0
  return frames[i]!.flux * (1 - (x - i)) + frames[i + 1]!.flux * (x - i)
}

export function meanChroma(frames: FrameFeatures[], hopSec: number, startSec: number, endSec: number): Float32Array {
  const out = new Float32Array(12)
  const a = Math.max(0, Math.floor(startSec / hopSec))
  const b = Math.min(frames.length, Math.max(a + 1, Math.floor(endSec / hopSec)))
  for (let i = a; i < b; i++) for (let k = 0; k < 12; k++) out[k]! += frames[i]!.chroma[k]!
  const norm = Math.hypot(...out) || 1
  for (let k = 0; k < 12; k++) out[k]! /= norm
  return out
}

/** Harmony tends to change and onsets tend to land on bar lines. Picks one of the four beat phases. */
export function estimateDownbeat(frames: FrameFeatures[], hopSec: number, beatsSec: number[]):
  { beat: number; confidence: number } {
  const beatSec = (beatsSec[1] ?? 0) - (beatsSec[0] ?? 0)
  const chromas = beatsSec.map(t => meanChroma(frames, hopSec, t, t + beatSec))
  const change = chromas.map((c, k) => k === 0 ? 0 : 1 - c.reduce((sum, v, i) => sum + v * chromas[k - 1]![i]!, 0))
  const onset = beatsSec.map(t => fluxAt(frames, hopSec, t))
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
  const changeAll = mean(change.slice(1)) || 1
  const onsetAll = mean(onset) || 1
  const scores = Array.from({ length: BEATS_PER_BAR }, (_, phase) => {
    const ks = change.map((_, k) => k).filter(k => k >= 1 && k % BEATS_PER_BAR === phase)
    return mean(ks.map(k => change[k]!)) / changeAll + 0.5 * mean(ks.map(k => onset[k]!)) / onsetAll
  })
  const ranked = scores.map((score, beat) => ({ score, beat })).sort((a, b) => b.score - a.score)
  const best = ranked[0]!
  const second = ranked[1]?.score ?? 0
  return { beat: best.beat, confidence: best.score > 0 ? Math.max(0, Math.min(1, (best.score - second) / best.score * 4)) : 0 }
}

/**
 * Beats that follow the onsets (Ellis 2007 dynamic programming), seeded with the global tempo. A song that drifts
 * even 0.2% off one fixed grid is 100 ms out after a minute, which breaks every wrap that crosses the drift.
 */
export function trackBeats(flux: Float32Array, hopSec: number, bpm: number, durationSec: number): number[] {
  const n = flux.length
  const period = 60 / bpm / hopSec
  let sumSq = 0
  for (let i = 0; i < n; i++) sumSq += flux[i]! * flux[i]!
  const std = Math.sqrt(sumSq / Math.max(1, n)) || 1
  const radius = Math.max(1, Math.round(period / 32))
  const local = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let k = -radius; k <= radius; k++) {
      const v = flux[i + k]
      if (v !== undefined) s += (v / std) * Math.exp(-0.5 * (k / radius) ** 2)
    }
    local[i] = s
  }
  const lo = Math.max(1, Math.round(period * 0.8))
  const hi = Math.round(period * 1.25)
  const score = new Float64Array(n)
  const prev = new Int32Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    let best = 0
    for (let d = lo; d <= hi && i - d >= 0; d++) {
      const v = score[i - d]! - BEAT_TIGHTNESS * Math.log(d / period) ** 2
      if (prev[i] === -1 || v > best) { best = v; prev[i] = i - d }
    }
    score[i] = local[i]! + best
  }
  let end = Math.max(0, n - Math.ceil(period))
  for (let i = end; i < n; i++) if (score[i]! > score[end]!) end = i
  const hops: number[] = []
  for (let i = end; i >= 0; i = prev[i]!) hops.push(i)
  hops.reverse()
  return hops.map(i => {
    const a = local[i - 1] ?? local[i]!
    const b = local[i]!
    const c = local[i + 1] ?? local[i]!
    const curve = a - 2 * b + c
    const shift = curve < 0 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * curve))) : 0
    return (i + shift) * hopSec
  }).filter(t => t >= 0 && t <= durationSec - 0.1)
}
