import { fftRadix2 } from '@/loop/fft'
import {
  clampVibeWindowSec,
  DEFAULT_VIBE_WINDOW_SEC,
  type DetectLoopsInput,
  type DetectLoopsResult,
  type DetectedLoop,
  type LoopBarLength,
} from '@/loop/types'

const MIN_BPM = 70
const MAX_BPM = 180
const FALLBACK_BPM = 120
const FFT_N = 1024
const HOP = 256
const MIN_LOOP_SEC = 1
const MAX_KEEP = 48
const PER_LENGTH_KEEP = 8
/** Prefer musical powers of two for game-ready phrase lengths. */
const BAR_LENGTHS: LoopBarLength[] = [1, 2, 4, 8, 16]
const WRAP_CORR_SEC = 0.05
const ONSET_HEAD_SEC = 0.03
const CHROMA_BINS = 12
const TIMBRE_BINS = 8
const SPEC_BINS = 24
/** Wrap vibe / jump smoothness below this is an audible scene jump. */
const MIN_WRAP = 0.58
/** Absolute seam floor — clicks and hard cuts. */
const MIN_SEAM = 0.58

/**
 * How much of each side of the join we can compare. Always clamps into the
 * loop so short 1–2 bar grooves still get scored instead of being skipped.
 */
export function effectiveVibeWindowSec(loopSec: number, requestedSec: number): number {
  const requested = clampVibeWindowSec(requestedSec)
  const maxFit = Math.max(0.2, loopSec * 0.45)
  return Math.min(requested, maxFit)
}

/** True when the requested window fits without clamping (UI / tests). */
export function loopCanUseVibeWindow(loopSec: number, windowSec: number): boolean {
  return loopSec * 0.45 + 1e-6 >= windowSec
}

export type FrameFeatures = {
  chroma: Float32Array
  timbre: Float32Array
  /** Log band energy, not normalized, so loudness and tone both survive. */
  spec: Float32Array
  rms: number
  /** Spectral centroid / Nyquist, 0..1 (brightness). */
  centroid: number
  /** Flux of this hop, 0..1 vs the clip max. */
  flux: number
}

export type TransitionModel = {
  scales: { width: number; distances: number[] }[]
}

export function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  const n = channels[0]!.length
  if (channels.length === 1) return channels[0]!.slice()
  const out = new Float32Array(n)
  const inv = 1 / channels.length
  for (let i = 0; i < n; i++) {
    let s = 0
    for (const ch of channels) s += ch[i] ?? 0
    out[i] = s * inv
  }
  return out
}

export function decimate(samples: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return samples
  const n = Math.floor(samples.length / factor)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = samples[i * factor]!
  return out
}

export function foldBpm(bpm: number): number {
  let b = bpm
  while (b < MIN_BPM) b *= 2
  while (b > MAX_BPM) b /= 2
  return Math.min(MAX_BPM, Math.max(MIN_BPM, b))
}

function hamming(n: number): Float32Array {
  const w = new Float32Array(n)
  if (n === 1) {
    w[0] = 1
    return w
  }
  for (let i = 0; i < n; i++) {
    w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1))
  }
  return w
}

function hopSecFor(sampleRate: number): number {
  return HOP / sampleRate
}

function l2normalize(v: Float32Array): void {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!
  n = Math.sqrt(n) || 1
  for (let i = 0; i < v.length; i++) v[i]! /= n
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let d = 0
  for (let i = 0; i < n; i++) d += a[i]! * b[i]!
  return Math.max(0, Math.min(1, d))
}

function cosineUnnorm(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  const den = Math.sqrt(na * nb)
  if (den < 1e-12) return 1
  return Math.max(0, Math.min(1, dot / den))
}

function specBandRanges(sampleRate: number): { a: number; b: number }[] {
  const nyquist = sampleRate / 2
  const fMin = 40
  const fMax = Math.max(fMin * 2, Math.min(nyquist * 0.95, 12000))
  const ranges: { a: number; b: number }[] = []
  for (let i = 0; i < SPEC_BINS; i++) {
    const f0 = fMin * Math.pow(fMax / fMin, i / SPEC_BINS)
    const f1 = fMin * Math.pow(fMax / fMin, (i + 1) / SPEC_BINS)
    const a = Math.max(1, Math.floor((f0 / sampleRate) * FFT_N))
    const b = Math.min(FFT_N / 2, Math.max(a + 1, Math.ceil((f1 / sampleRate) * FFT_N)))
    ranges.push({ a, b })
  }
  return ranges
}

function fillLogSpec(
  re: Float32Array,
  im: Float32Array,
  ranges: { a: number; b: number }[],
  out: Float32Array
): void {
  for (let i = 0; i < ranges.length; i++) {
    const band = ranges[i]!
    let e = 0
    for (let k = band.a; k < band.b; k++) e += re[k]! * re[k]! + im[k]! * im[k]!
    out[i] = Math.log1p(e / Math.max(1, band.b - band.a))
  }
}

function fillChromaTimbre(
  re: Float32Array,
  im: Float32Array,
  sampleRate: number,
  chroma: Float32Array,
  timbre: Float32Array
): number {
  chroma.fill(0)
  timbre.fill(0)
  const bins = FFT_N / 2
  const nyquist = sampleRate / 2
  let magSum = 0
  let weighted = 0
  for (let k = 1; k < bins; k++) {
    const freq = (k / FFT_N) * sampleRate
    if (freq >= nyquist) break
    const mag = Math.hypot(re[k]!, im[k]!)
    magSum += mag
    weighted += freq * mag
    if (freq >= 65 && freq <= 5000) {
      const midi = 69 + 12 * Math.log2(freq / 440)
      const pc = ((Math.round(midi) % 12) + 12) % 12
      chroma[pc]! += mag
    }
    const logF = Math.log2(1 + freq)
    const logMax = Math.log2(1 + nyquist)
    const bi = Math.min(TIMBRE_BINS - 1, Math.floor((logF / logMax) * TIMBRE_BINS))
    timbre[bi]! += mag
  }
  l2normalize(chroma)
  l2normalize(timbre)
  return magSum > 1e-12 ? Math.min(1, weighted / magSum / nyquist) : 0
}

/** Hop-wise flux plus chroma/timbre/RMS for musical context scoring. */
export function extractHopFeatures(
  samples: Float32Array,
  sampleRate: number
): { flux: Float32Array; frames: FrameFeatures[]; hopSec: number } {
  const win = hamming(FFT_N)
  const nHops = Math.max(0, Math.floor((samples.length - FFT_N) / HOP) + 1)
  const flux = new Float32Array(Math.max(1, nHops))
  const frames: FrameFeatures[] = []
  const re = new Float32Array(FFT_N)
  const im = new Float32Array(FFT_N)
  const prev = new Float32Array(FFT_N / 2)
  const bins = FFT_N / 2
  const hopSec = hopSecFor(sampleRate)
  const bands = specBandRanges(sampleRate)

  for (let h = 0; h < nHops; h++) {
    const off = h * HOP
    re.fill(0)
    im.fill(0)
    let e = 0
    for (let i = 0; i < FFT_N; i++) {
      const s = samples[off + i] ?? 0
      e += s * s
      re[i] = s * win[i]!
    }
    fftRadix2(re, im)
    let f = 0
    for (let k = 0; k < bins; k++) {
      const mag = Math.hypot(re[k]!, im[k]!)
      const d = mag - prev[k]!
      if (d > 0) f += d
      prev[k] = mag
    }
    flux[h] = f
    const chroma = new Float32Array(CHROMA_BINS)
    const timbre = new Float32Array(TIMBRE_BINS)
    const spec = new Float32Array(SPEC_BINS)
    const centroid = fillChromaTimbre(re, im, sampleRate, chroma, timbre)
    fillLogSpec(re, im, bands, spec)
    frames.push({ chroma, timbre, spec, rms: Math.sqrt(e / FFT_N), centroid, flux: f })
  }
  if (nHops === 0) {
    flux[0] = 0
    frames.push({
      chroma: new Float32Array(CHROMA_BINS),
      timbre: new Float32Array(TIMBRE_BINS),
      spec: new Float32Array(SPEC_BINS),
      rms: 0,
      centroid: 0,
      flux: 0,
    })
  }
  let maxFlux = 1e-8
  for (let i = 0; i < frames.length; i++) maxFlux = Math.max(maxFlux, frames[i]!.flux)
  for (let i = 0; i < frames.length; i++) frames[i]!.flux /= maxFlux
  return { flux, frames, hopSec }
}

/** Spectral-flux envelope. Returns one value per hop. */
export function spectralFlux(samples: Float32Array): Float32Array {
  return extractHopFeatures(samples, 44100).flux
}

export function estimateTempoBpm(flux: Float32Array, hopSec: number): number {
  if (flux.length < 8 || hopSec <= 0) return FALLBACK_BPM
  const minLag = Math.max(2, Math.round(60 / MAX_BPM / hopSec))
  const maxLag = Math.min(Math.floor(flux.length / 2) - 1, Math.round(60 / MIN_BPM / hopSec))
  if (maxLag <= minLag) return FALLBACK_BPM

  let bestLag = minLag
  let best = -Infinity
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0
    let n = 0
    for (let i = 0; i + lag < flux.length; i++) {
      s += flux[i]! * flux[i + lag]!
      n++
    }
    const v = n > 0 ? s / n : 0
    if (v > best) {
      best = v
      bestLag = lag
    }
  }

  const mean = flux.reduce((a, b) => a + b, 0) / flux.length
  const energy = flux.reduce((a, b) => a + b * b, 0) / flux.length
  if (energy < 1e-12 || best < mean * mean * 1.05) return FALLBACK_BPM

  // Integer-hop tempo errors accumulate into a misplaced beat over long beds.
  // Refine with correlations spanning up to 16 beats, then interpolate the peak.
  const correlation = (lag: number) => {
    const lo = Math.floor(lag)
    const frac = lag - lo
    let sum = 0
    let count = 0
    for (let i = 0; i + lo + 1 < flux.length; i++) {
      sum += flux[i]! * (flux[i + lo]! * (1 - frac) + flux[i + lo + 1]! * frac)
      count++
    }
    return sum / Math.max(1, count)
  }
  const objective = (period: number) => {
    let value = 0
    let weight = 0
    for (const beats of [1, 2, 4, 8, 16]) {
      if (period * beats >= flux.length / 2) continue
      value += correlation(period * beats)
      weight++
    }
    return value / Math.max(1, weight)
  }
  let refined = bestLag
  let refinedScore = -Infinity
  for (let lag = bestLag - 1; lag <= bestLag + 1; lag += 0.01) {
    const score = objective(lag)
    if (score > refinedScore) { refinedScore = score; refined = lag }
  }
  return foldBpm(60 / (refined * hopSec))
}

export function estimateBeatOffsetSec(flux: Float32Array, hopSec: number, bpm: number): number {
  const periodSec = 60 / bpm
  const periodHops = periodSec / hopSec
  let bestOff = 0
  let best = -Infinity
  for (let off = 0; off < periodHops; off += 0.25) {
    let sum = 0
    let count = 0
    for (let i = off; i + 1 < flux.length; i += periodHops) {
      const lo = Math.floor(i)
      sum += flux[lo]! * (1 - (i - lo)) + flux[lo + 1]! * (i - lo)
      count++
    }
    if (sum / Math.max(1, count) > best) {
      best = sum / Math.max(1, count)
      bestOff = off
    }
  }
  return bestOff * hopSec
}

function rms(samples: Float32Array, start: number, end: number): number {
  const a = Math.max(0, Math.min(samples.length, start))
  const b = Math.max(a + 1, Math.min(samples.length, end))
  let s = 0
  for (let i = a; i < b; i++) s += samples[i]! * samples[i]!
  return Math.sqrt(s / (b - a))
}

function bandEnergy(samples: Float32Array, start: number, end: number, sampleRate: number): Float32Array {
  const out = new Float32Array(TIMBRE_BINS)
  const a = Math.max(0, Math.min(samples.length, start))
  const len = Math.max(1, Math.min(samples.length, end) - a)
  const n = FFT_N
  const re = new Float32Array(n)
  const im = new Float32Array(n)
  const take = Math.min(n, len)
  const win = hamming(take)
  for (let i = 0; i < take; i++) re[i] = samples[a + i]! * (win[i] ?? 1)
  fftRadix2(re, im)
  const chroma = new Float32Array(CHROMA_BINS)
  fillChromaTimbre(re, im, sampleRate, chroma, out)
  return out
}

function wrapCorrelation(samples: Float32Array, start: number, end: number, n: number): number {
  const len = n
  if (len < 8) return 0
  const a0 = start
  const b0 = end - len
  if (b0 < 0 || start < 0) return 0
  let meanA = 0
  let meanB = 0
  for (let i = 0; i < len; i++) {
    meanA += samples[a0 + i] ?? 0
    meanB += samples[b0 + i] ?? 0
  }
  meanA /= len
  meanB /= len
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < len; i++) {
    const xa = (samples[a0 + i] ?? 0) - meanA
    const xb = (samples[b0 + i] ?? 0) - meanB
    num += xa * xb
    da += xa * xa
    db += xb * xb
  }
  const den = Math.sqrt(da * db)
  if (den < 1e-12) return 1
  return Math.max(0, Math.min(1, (num / den + 1) / 2))
}

export function scoreSeam(
  samples: Float32Array,
  sampleRate: number,
  startSec: number,
  endSec: number,
  bpm: number
): number {
  const start = Math.floor(startSec * sampleRate)
  const end = Math.floor(endSec * sampleRate)
  if (end - start < sampleRate * 0.25) return 0

  const beatSec = 60 / Math.max(1, bpm)
  const beatN = Math.max(16, Math.floor(beatSec * 2 * sampleRate))
  return seamAcross(samples, sampleRate, start, end, Math.min(end, start + beatN), Math.max(start, end - beatN),
    end, rms(samples, start, end))
}

/** Sample-level join from `end` into `start`. The two sides may be anywhere in the source. */
function seamAcross(samples: Float32Array, sampleRate: number, start: number, end: number,
  firstEnd: number, lastStart: number, headLimit: number, loopRms: number): number {
  const r1 = rms(samples, start, firstEnd)
  const r2 = rms(samples, lastStart, end)
  const rmsMatch = Math.min(r1, r2) / Math.max(r1, r2, 1e-8)

  const e1 = bandEnergy(samples, start, firstEnd, sampleRate)
  const e2 = bandEnergy(samples, lastStart, end, sampleRate)
  const specMatch = cosineSim(e1, e2)

  const wrapN = Math.max(8, Math.floor(WRAP_CORR_SEC * sampleRate))
  const corr = wrapCorrelation(samples, start, end, wrapN)

  const headN = Math.max(4, Math.floor(ONSET_HEAD_SEC * sampleRate))
  let peakHead = 0
  for (let i = start; i < start + headN && i < headLimit; i++) {
    peakHead = Math.max(peakHead, Math.abs(samples[i] ?? 0))
  }
  const onsetPen = Math.max(0, Math.min(1, (peakHead - loopRms * 4) / (loopRms * 8 + 1e-6)))

  // Derivative discontinuity across the join → audible click/clack.
  const pre0 = samples[end - 2] ?? 0
  const pre1 = samples[end - 1] ?? 0
  const post0 = samples[start] ?? 0
  const post1 = samples[start + 1] ?? 0
  const derivJump = Math.abs(pre1 - pre0 - (post1 - post0))
  const levelJump = Math.abs(pre1 - post0)
  const clickPen = Math.max(0, Math.min(1, derivJump * 4 + levelJump * 1.5))

  const score =
    0.28 * rmsMatch +
    0.22 * specMatch +
    0.22 * corr +
    0.1 * (1 - onsetPen) +
    0.18 * (1 - clickPen)
  return Math.max(0, Math.min(1, score))
}

function ratioSim(a: number, b: number): number {
  const hi = Math.max(Math.abs(a), Math.abs(b), 1e-8)
  return Math.min(Math.abs(a), Math.abs(b)) / hi
}

/**
 * Harmony, instrumentation, loudness, and spectrum each have to agree.
 * A shared key cannot hide a chorus hit or a drop.
 */
function frameVibeSim(a: FrameFeatures, b: FrameFeatures): number {
  const harmony = cosineSim(a.chroma, b.chroma)
  const timbre = cosineSim(a.timbre, b.timbre)
  const spectrum = cosineUnnorm(a.spec, b.spec)
  const energy = ratioSim(a.rms, b.rms)
  const brightness = 1 - Math.min(1, Math.abs(a.centroid - b.centroid) / 0.2)
  const worst = Math.min(harmony, timbre, spectrum, energy)
  const mean = (harmony + timbre + spectrum + energy + brightness) / 5
  return Math.max(0, Math.min(1, worst * 0.55 + mean * 0.45))
}

function meanFrames(frames: FrameFeatures[], i0: number, i1: number): FrameFeatures {
  const a = Math.max(0, Math.min(frames.length - 1, i0))
  const b = Math.max(a + 1, Math.min(frames.length, i1))
  const chroma = new Float32Array(CHROMA_BINS)
  const timbre = new Float32Array(TIMBRE_BINS)
  const spec = new Float32Array(SPEC_BINS)
  let rmsSum = 0
  let centroidSum = 0
  let fluxSum = 0
  const n = b - a
  for (let i = a; i < b; i++) {
    const f = frames[i]!
    for (let k = 0; k < CHROMA_BINS; k++) chroma[k]! += f.chroma[k]!
    for (let k = 0; k < TIMBRE_BINS; k++) timbre[k]! += f.timbre[k]!
    for (let k = 0; k < SPEC_BINS; k++) spec[k]! += f.spec[k]!
    rmsSum += f.rms
    centroidSum += f.centroid
    fluxSum += f.flux
  }
  const inv = 1 / n
  for (let k = 0; k < CHROMA_BINS; k++) chroma[k]! *= inv
  for (let k = 0; k < TIMBRE_BINS; k++) timbre[k]! *= inv
  for (let k = 0; k < SPEC_BINS; k++) spec[k]! *= inv
  l2normalize(chroma)
  l2normalize(timbre)
  return {
    chroma,
    timbre,
    spec,
    rms: rmsSum * inv,
    centroid: centroidSum * inv,
    flux: fluxSum * inv,
  }
}

function frameAt(tSec: number, hopSec: number, n: number): number {
  return Math.max(0, Math.min(n - 1, Math.floor(tSec / hopSec)))
}

function specDistance(a: Float32Array, b: Float32Array, rmsA: number, rmsB: number): number {
  const shape = 1 - cosineUnnorm(a, b)
  const level = Math.min(1, Math.abs(Math.log(rmsA + 1e-6) - Math.log(rmsB + 1e-6)) / Math.log(8))
  return shape + 0.75 * level
}

/** How different two stretches of the spectrogram are, including their shape over time. */
function spanDistance(frames: FrameFeatures[], a0: number, a1: number, b0: number, b1: number): number {
  const aStart = Math.max(0, Math.min(frames.length - 1, a0))
  const aEnd = Math.max(aStart + 1, Math.min(frames.length, a1))
  const bStart = Math.max(0, Math.min(frames.length - 1, b0))
  const bEnd = Math.max(bStart + 1, Math.min(frames.length, b1))
  const meanA = new Float32Array(SPEC_BINS)
  const meanB = new Float32Array(SPEC_BINS)
  let rmsA = 0
  let rmsB = 0
  const nA = aEnd - aStart
  const nB = bEnd - bStart
  for (let i = aStart; i < aEnd; i++) {
    const f = frames[i]!
    rmsA += f.rms
    for (let k = 0; k < SPEC_BINS; k++) meanA[k]! += f.spec[k]!
  }
  for (let i = bStart; i < bEnd; i++) {
    const f = frames[i]!
    rmsB += f.rms
    for (let k = 0; k < SPEC_BINS; k++) meanB[k]! += f.spec[k]!
  }
  for (let k = 0; k < SPEC_BINS; k++) {
    meanA[k]! /= nA
    meanB[k]! /= nB
  }
  const meanD = specDistance(meanA, meanB, rmsA / nA, rmsB / nB)
  const n = Math.min(nA, nB)
  const step = Math.max(1, Math.floor(n / 24))
  let seq = 0
  let count = 0
  for (let k = 0; k < n; k += step) {
    const fa = frames[aStart + k]!
    const fb = frames[bStart + k]!
    seq += specDistance(fa.spec, fb.spec, fa.rms, fb.rms)
    count++
  }
  return 0.4 * meanD + 0.6 * (seq / Math.max(1, count))
}

export function buildTransitionModel(
  frames: FrameFeatures[],
  hopSec: number,
  beatSec: number,
  windowSec: number,
  beatOffsetSec = 0
): TransitionModel {
  const beatFrames = Math.max(2, Math.round(beatSec / Math.max(hopSec, 1e-6)))
  const origin = Math.max(0, Math.round(beatOffsetSec / Math.max(hopSec, 1e-6)))
  const widths = [
    ...new Set(
      [0.2, windowSec]
        .map((sec) => Math.max(4, Math.round(sec / Math.max(hopSec, 1e-6))))
        .filter((w) => origin + w * 2 < frames.length)
    ),
  ]
  const scales = widths.map((width) => {
    const distances: number[] = []
    for (let t = origin; t + width * 2 < frames.length; t += beatFrames) {
      distances.push(spanDistance(frames, t, t + width, t + width, t + width * 2))
    }
    return { width, distances }
  })
  return { scales }
}

/**
 * Typical motion in the song scores high. A jump past the rough end of that
 * distribution — a hard cut — scores low. Tiny spectral noise does not.
 */
function continuityAgainst(distances: number[], value: number): number {
  if (distances.length === 0) return 0
  const sorted = [...distances].sort((a, b) => a - b)
  const median = sorted[Math.floor((sorted.length - 1) * 0.5)]!
  const hi = sorted[Math.min(sorted.length - 1, Math.ceil((sorted.length - 1) * 0.9))]!
  if (value <= median + 1e-3) return 0.95
  const span = Math.max(hi - median, 0.02)
  const t = (value - median) / span
  return Math.max(0, Math.min(0.95, 0.95 - t * 0.75))
}

/**
 * Play the end straight into the start and compare that splice with every
 * ordinary step of the same length in the song.
 */
function scoreJoinContinuity(
  frames: FrameFeatures[],
  hopSec: number,
  startSec: number,
  endSec: number,
  model: TransitionModel
): number {
  if (frames.length < 8 || hopSec <= 0 || model.scales.length === 0) return 0
  const startF = frameAt(startSec, hopSec, frames.length)
  const endF = frameAt(endSec, hopSec, frames.length)
  let worst = 1
  let used = 0
  for (const scale of model.scales) {
    const width = scale.width
    if (width < 4 || scale.distances.length === 0) continue
    if (Math.abs(endF - startF) < width * 2) continue
    const pre = endF - width
    if (pre < 0 || startF + width > frames.length) continue
    const distance = spanDistance(frames, pre, endF, startF, startF + width)
    worst = Math.min(worst, continuityAgainst(scale.distances, distance))
    used++
  }
  return used === 0 ? 0 : worst
}

/** Penalize a section change in the middle of the candidate (Foote-style homogeneity). */
export function scoreHomogeneity(
  frames: FrameFeatures[],
  hopSec: number,
  startSec: number,
  endSec: number,
  barSec: number
): number {
  if (frames.length < 2 || hopSec <= 0 || barSec <= 0) return 0
  const nBars = Math.max(1, Math.round((endSec - startSec) / barSec))
  if (nBars < 2) return 1
  const bars: FrameFeatures[] = []
  for (let i = 0; i < nBars; i++) {
    const t0 = startSec + i * barSec
    const t1 = Math.min(endSec, startSec + (i + 1) * barSec)
    bars.push(
      meanFrames(frames, frameAt(t0, hopSec, frames.length), frameAt(t1, hopSec, frames.length) + 1)
    )
  }
  let sum = 0
  let minSim = 1
  for (let i = 0; i < bars.length - 1; i++) {
    const s = frameVibeSim(bars[i]!, bars[i + 1]!)
    sum += s
    minSim = Math.min(minSim, s)
  }
  const meanAdj = sum / Math.max(1, bars.length - 1)
  const mid = Math.floor(bars.length / 2)
  const firstHalf = meanFrames(
    frames,
    frameAt(startSec, hopSec, frames.length),
    frameAt(startSec + mid * barSec, hopSec, frames.length) + 1
  )
  const secondHalf = meanFrames(
    frames,
    frameAt(startSec + mid * barSec, hopSec, frames.length),
    frameAt(endSec, hopSec, frames.length) + 1
  )
  const halfSim = frameVibeSim(firstHalf, secondHalf)
  return Math.max(0, Math.min(1, 0.35 * meanAdj + 0.35 * minSim + 0.3 * halfSim))
}

/**
 * What you hear across the jump: the stretch after the start vs the stretch
 * before the end. Mean match alone misses a phrase change that shares a key;
 * frame-aligned sequence match catches that.
 */
export function scoreWrapVibe(
  frames: FrameFeatures[],
  hopSec: number,
  startSec: number,
  endSec: number,
  windowSec: number
): number {
  if (frames.length < 4 || hopSec <= 0 || windowSec <= 0) return 0
  const dur = endSec - startSec
  return vibeAcross(frames, hopSec, startSec, endSec, Math.min(windowSec, Math.max(0.2, dur * 0.45)))
}

function vibeAcross(frames: FrameFeatures[], hopSec: number, startSec: number, endSec: number, w: number): number {
  const a0 = frameAt(startSec, hopSec, frames.length)
  const a1 = Math.max(a0 + 1, frameAt(startSec + w, hopSec, frames.length) + 1)
  const b1 = frameAt(endSec, hopSec, frames.length) + 1
  const b0 = Math.max(0, frameAt(endSec - w, hopSec, frames.length))
  const meanA = meanFrames(frames, a0, a1)
  const meanB = meanFrames(frames, b0, b1)
  const meanSim = frameVibeSim(meanA, meanB)

  const n = Math.min(a1 - a0, b1 - b0)
  if (n < 2) return meanSim
  const step = Math.max(1, Math.floor(n / 20))
  let seq = 0
  let worst = 1
  let count = 0
  for (let k = 0; k < n; k += step) {
    const s = frameVibeSim(frames[a0 + k]!, frames[b0 + k]!)
    seq += s
    worst = Math.min(worst, s)
    count++
  }
  const seqSim = seq / Math.max(1, count)
  return Math.max(0, Math.min(1, 0.4 * meanSim + 0.35 * seqSim + 0.25 * worst))
}

/** Fast beat-grid proxy for wrap vibe while searching offsets. */
function beatWrapVibe(beats: FrameFeatures[], startBeat: number, endBeat: number, windowBeats: number): number {
  const w = Math.max(1, Math.min(windowBeats, Math.floor((endBeat - startBeat) / 2)))
  if (startBeat < 0 || endBeat > beats.length || endBeat - startBeat < w * 2) return 0
  let sum = 0
  let worst = 1
  for (let k = 0; k < w; k++) {
    const s = frameVibeSim(beats[startBeat + k]!, beats[endBeat - w + k]!)
    sum += s
    worst = Math.min(worst, s)
  }
  return 0.65 * (sum / w) + 0.35 * worst
}

/** Vibe match gates the score: a clean splice cannot rescue a character jump. */
export function combineQuality(seam: number, context: number, homogeneity: number): number {
  // Context (wrap + join) dominates. Homogeneity blocks mid-loop scene changes.
  // Seam is a click/level gate that should not inflate a vibe mismatch.
  return Math.max(
    0,
    Math.min(
      1,
      Math.pow(Math.max(0.01, context), 0.55) *
        Math.pow(Math.max(0.01, homogeneity), 0.25) *
        Math.pow(Math.max(0.01, seam), 0.2)
    )
  )
}

/**
 * Shift both edges by the same amount, within `radiusSec`, so the samples
 * that meet at the join disagree less. Length stays put. Returns seconds.
 */
export function softenSeamShiftSec(
  samples: Float32Array,
  sampleRate: number,
  startSec: number,
  endSec: number,
  radiusSec = 0.03
): number {
  const start = Math.round(startSec * sampleRate)
  const end = Math.round(endSec * sampleRate)
  const radius = Math.max(1, Math.round(radiusSec * sampleRate))
  const win = Math.max(8, Math.round(0.012 * sampleRate))
  let best = 0
  let bestCost = Infinity
  for (let d = -radius; d <= radius; d++) {
    const s = start + d
    const e = end + d
    if (s < win || e >= samples.length || e - win < s) continue
    let jump = 0
    let energy = 0
    for (let i = 0; i < win; i++) {
      const a = samples[e - win + i] ?? 0
      const b = samples[s + i] ?? 0
      const diff = a - b
      jump += diff * diff
      energy += a * a + b * b
    }
    const pre0 = samples[e - 2] ?? 0
    const pre1 = samples[e - 1] ?? 0
    const post0 = samples[s] ?? 0
    const post1 = samples[s + 1] ?? 0
    const deriv = Math.abs(pre1 - pre0 - (post1 - post0))
    const edge = Math.abs(post0) + Math.abs(pre1)
    // Prefer staying on the beat grid unless the click improvement is clear.
    const drift = Math.abs(d) / radius
    const cost = jump / (energy + 1e-8) + 0.8 * deriv + 0.35 * edge + 0.25 * drift
    if (cost < bestCost) {
      bestCost = cost
      best = d
    }
  }
  return best / sampleRate
}

/** Nearest supported bar count for a duration on this beat grid. */
export function nearestBarLength(durationSec: number, beatSec: number): LoopBarLength {
  let best: LoopBarLength = 4
  let bestDiff = Infinity
  for (const bars of BAR_LENGTHS) {
    const len = bars * 4 * beatSec
    const diff = Math.abs(len - durationSec)
    if (diff < bestDiff) {
      bestDiff = diff
      best = bars
    }
  }
  return best
}

/** Playback offset so the wrap is the first thing you hear. */
export function joinPreviewOffset(startSec: number, endSec: number, bpm: number): number {
  const barSec = (60 / Math.max(1, bpm)) * 4
  const lead = Math.min(barSec, Math.max(0.25, (endSec - startSec) * 0.5))
  return Math.max(startSec, endSec - lead)
}

function beatSyncFeatures(
  frames: FrameFeatures[],
  hopSec: number,
  beatOffsetSec: number,
  bpm: number
): FrameFeatures[] {
  const beatSec = 60 / Math.max(1, bpm)
  const duration = frames.length * hopSec
  const beats: FrameFeatures[] = []
  for (let t = Math.max(0, beatOffsetSec); t + beatSec * 0.4 < duration; t += beatSec) {
    beats.push(
      meanFrames(
        frames,
        frameAt(t, hopSec, frames.length),
        frameAt(t + beatSec, hopSec, frames.length) + 1
      )
    )
  }
  return beats
}

/** Mean vibe match of beat[i+k] vs beat[i+k+lag] along the lag diagonal. */
export function lagStripeScore(beats: FrameFeatures[], start: number, lag: number): number {
  if (lag < 1 || start < 0) return 0
  if (start + lag * 2 <= beats.length) {
    let s = 0
    for (let k = 0; k < lag; k++) {
      s += frameVibeSim(beats[start + k]!, beats[start + k + lag]!)
    }
    return s / lag
  }
  if (start + lag > beats.length) return 0
  return frameVibeSim(beats[start + lag - 1]!, beats[start]!)
}

export function pickLagPeaks(scores: number[], minScore: number, minDist: number): number[] {
  const idx = scores.map((_, i) => i).filter((i) => (scores[i] ?? 0) >= minScore)
  idx.sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0))
  const kept: number[] = []
  const dist = Math.max(1, minDist)
  for (const i of idx) {
    if (kept.every((j) => Math.abs(j - i) >= dist)) kept.push(i)
  }
  return kept.sort((a, b) => a - b)
}

function rmsEnvelope(samples: Float32Array, start: number, end: number, hop: number): Float32Array {
  const n = Math.max(0, Math.floor((end - start) / hop))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    const a = start + i * hop
    for (let k = 0; k < hop; k++) {
      const v = samples[a + k] ?? 0
      s += v * v
    }
    out[i] = Math.sqrt(s / hop)
  }
  return out
}

/** Null when the contour is too flat to compare, such as a steady tone. */
function pearson(a: Float32Array, b: Float32Array): number | null {
  const n = Math.min(a.length, b.length)
  if (n < 4) return null
  let meanA = 0
  let meanB = 0
  for (let i = 0; i < n; i++) {
    meanA += a[i]!
    meanB += b[i]!
  }
  meanA /= n
  meanB /= n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const xa = a[i]! - meanA
    const xb = b[i]! - meanB
    num += xa * xb
    da += xa * xa
    db += xb * xb
  }
  if (da < 1e-8 || db < 1e-8) return null
  const meanLevel = Math.max(meanA, meanB, 1e-8)
  const depth = Math.max(Math.sqrt(da / n), Math.sqrt(db / n)) / meanLevel
  // A steady tone has no arrival shape. Leave that to the spectral check.
  if (depth < 0.04) return null
  return num / Math.sqrt(da * db)
}

/**
 * Soft bonus: does loudness just before the end arrive like loudness just
 * before the start? Never a hard gate — real songs rarely clear a high
 * Pearson threshold even on good loops.
 */
function scoreArrival(
  samples: Float32Array,
  sampleRate: number,
  startSec: number,
  endSec: number,
  windowSec: number
): number | null {
  const hop = Math.max(32, Math.round(sampleRate * (512 / 22050)))
  const dur = endSec - startSec
  const window = effectiveVibeWindowSec(dur, windowSec)
  const n = Math.round(window * sampleRate)
  const start = Math.round(startSec * sampleRate)
  const end = Math.round(endSec * sampleRate)
  if (n < hop * 4 || start - n < 0 || end - n < 0 || end > samples.length || start > samples.length) {
    return null
  }
  const raw = pearson(rmsEnvelope(samples, end - n, end, hop), rmsEnvelope(samples, start - n, start, hop))
  if (raw == null) return null
  // Pearson is -1..1; map to a gentle 0..1 bonus.
  return Math.max(0, Math.min(1, (raw + 1) / 2))
}

/** Compare the same musical phase on both sides of the proposed splice.
 * A natural beat transition need not sound identical before and after the cut.
 * Instead the arrival must resemble the continuation it replaces, including
 * quiet spectral bands (pads/reverb can change underneath loud drums).
 */
export function scorePhraseClosure(
  frames: FrameFeatures[], hopSec: number, startSec: number, endSec: number,
  windowSec: number
): number | null {
  const distances: number[] = []
  const compare = (a: number, b: number, width: number) => {
    if (a < 0 || b < 0 || a + width > frames.length || b + width > frames.length) return
    const steps = Math.min(16, width)
    for (let k = 0; k < steps; k++) {
      const x = frames[a + Math.floor(k * width / steps)]!
      const y = frames[b + Math.floor(k * width / steps)]!
      let bandDelta = 0
      let weight = 0
      for (let j = 0; j < x.spec.length; j++) {
        // Log magnitudes retain quieter layers; ignore inaudible bands.
        const w = Math.min(1, Math.max(x.spec[j]!, y.spec[j]!) / 0.5)
        bandDelta += w * Math.abs(x.spec[j]! - y.spec[j]!)
        weight += w
      }
      distances.push(bandDelta / Math.max(1, weight))
    }
  }
  const width = Math.max(2, Math.round(windowSec / hopSec))
  const start = Math.round(startSec / hopSec)
  const end = Math.round(endSec / hopSec)
  compare(start - width, end - width, width)
  compare(start, end, width)
  if (!distances.length) return null
  distances.sort((a, b) => a - b)
  const mean = distances.reduce((a, b) => a + b, 0) / distances.length
  const high = distances[Math.floor((distances.length - 1) * 0.8)]!
  return Math.exp(-(0.65 * mean + 0.35 * high))
}

export function scoreLoopWindow(
  samples: Float32Array,
  sampleRate: number,
  startSec: number,
  endSec: number,
  bpm: number,
  frames?: FrameFeatures[],
  hopSec?: number,
  vibeWindowSec: number = DEFAULT_VIBE_WINDOW_SEC,
  transitionModel?: TransitionModel
): {
  seamScore: number
  contextScore: number
  homogeneityScore: number
  qualityScore: number
  closureScore: number
} {
  const seamScore = scoreSeam(samples, sampleRate, startSec, endSec, bpm)
  const feats = frames ?? extractHopFeatures(samples, sampleRate).frames
  const hop = hopSec ?? hopSecFor(sampleRate)
  const barSec = (60 / Math.max(1, bpm)) * 4
  const beatSec = 60 / Math.max(1, bpm)
  const windowSec = effectiveVibeWindowSec(endSec - startSec, vibeWindowSec)
  const wrap = scoreWrapVibe(feats, hop, startSec, endSec, windowSec)
  const model = transitionModel ?? buildTransitionModel(feats, hop, beatSec, windowSec)
  const join = scoreJoinContinuity(feats, hop, startSec, endSec, model)
  const arrival = scoreArrival(samples, sampleRate, startSec, endSec, windowSec)
  // Wrap vibe is what the ear hears across the jump. Join continuity asks
  // whether that jump is as smooth as a normal step in the song. Arrival is
  // only a soft swell bonus — it must not veto real loops.
  const arrivalSoft = arrival == null ? 0.75 : 0.55 + 0.45 * arrival
  // Arithmetic blend: geometric mean let a single weak join continuity
  // nuke otherwise strong wrap matches (and sparse click grids).
  const contextScore = Math.max(
    0,
    Math.min(1, 0.55 * wrap + 0.35 * join + 0.1 * arrivalSoft)
  )
  const closureScore = scorePhraseClosure(feats, hop, startSec, endSec, windowSec) ?? wrap
  const homogeneityScore = scoreHomogeneity(feats, hop, startSec, endSec, barSec)
  return {
    seamScore,
    contextScore,
    homogeneityScore,
    closureScore,
    qualityScore: combineQuality(seamScore, contextScore, homogeneityScore) * Math.pow(closureScore, 0.7),
  }
}

export type JumpScore = {
  seamScore: number
  vibeScore: number
  joinScore: number
  closureScore: number
  qualityScore: number
}

/**
 * Leave the source at `exitSec` and continue from `entrySec`, forwards or backwards.
 * A loop wrap is the jump from its end back to its start. Homogeneity belongs to
 * a held loop, not to a jump, so it is left out.
 */
export function scoreJump(
  samples: Float32Array,
  sampleRate: number,
  frames: FrameFeatures[],
  hopSec: number,
  model: TransitionModel,
  bpm: number,
  exitSec: number,
  entrySec: number,
  vibeWindowSec: number = DEFAULT_VIBE_WINDOW_SEC
): JumpScore {
  const distance = Math.abs(exitSec - entrySec)
  const windowSec = effectiveVibeWindowSec(distance, vibeWindowSec)
  const exit = Math.floor(exitSec * sampleRate)
  const entry = Math.floor(entrySec * sampleRate)
  const beatN = Math.max(16, Math.floor((60 / Math.max(1, bpm)) * 2 * sampleRate))
  const bodyRms = 0.5 * (rms(samples, entry, entry + beatN) + rms(samples, exit - beatN, exit))
  const seamScore = distance < 0.25 ? 0
    : seamAcross(samples, sampleRate, entry, exit, entry + beatN, exit - beatN, entry + beatN, bodyRms)
  const vibeScore = vibeAcross(frames, hopSec, entrySec, exitSec, windowSec)
  const joinScore = scoreJoinContinuity(frames, hopSec, entrySec, exitSec, model)
  const contextScore = Math.max(0, Math.min(1, 0.55 * vibeScore + 0.35 * joinScore + 0.1 * 0.75))
  const closureScore = scorePhraseClosure(frames, hopSec, entrySec, exitSec, windowSec) ?? vibeScore
  return {
    seamScore,
    vibeScore,
    joinScore,
    closureScore,
    qualityScore: combineQuality(seamScore, contextScore, 1) * Math.pow(closureScore, 0.7),
  }
}

function overlapRatio(a0: number, a1: number, b0: number, b1: number): number {
  const inter = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
  const shorter = Math.min(a1 - a0, b1 - b0)
  return shorter <= 0 ? 0 : inter / shorter
}

function rankScore(c: DetectedLoop): number {
  // Mild preference for longer beds once quality is comparable — game loops
  // need 4–16 bar phrases more than isolated 1-bar hits.
  const lenBias = c.bars >= 8 ? 0.04 : c.bars >= 4 ? 0.025 : c.bars >= 2 ? 0.01 : 0
  return c.qualityScore + lenBias
}

export function suppressNearDuplicates(candidates: DetectedLoop[], keep = MAX_KEEP): DetectedLoop[] {
  const sorted = [...candidates].sort((a, b) => rankScore(b) - rankScore(a))
  const out: DetectedLoop[] = []
  const rivals = (c: DetectedLoop, o: DetectedLoop) => {
    const ov = overlapRatio(c.startSec, c.endSec, o.startSec, o.endSec)
    if (c.bars === o.bars && ov > 0.45) return true
    if (c.bars !== o.bars && ov > 0.85) {
      const lenC = c.endSec - c.startSec
      const lenO = o.endSec - o.startSec
      const ratio = Math.max(lenC, lenO) / Math.max(1e-6, Math.min(lenC, lenO))
      // A 1-bar phrase inside a 4-bar loop is a different loop, not a duplicate.
      if (ratio < 1.5) return true
    }
    return false
  }
  for (const c of sorted) {
    const idx = out.findIndex((o) => rivals(c, o))
    if (idx === -1) {
      out.push(c)
    } else if (
      c.bars === out[idx]!.bars &&
      Math.abs(c.qualityScore - out[idx]!.qualityScore) < 0.05 &&
      c.seamScore > out[idx]!.seamScore + 0.01
    ) {
      // Nearly the same phrase. Keep the cut with the smaller click.
      out[idx] = c
    }
    if (out.length >= keep) break
  }
  return out
}

/** Keep the strongest loops of each bar length, so 1-bar grooves cannot fill the list. */
export function selectAcrossLengths(candidates: DetectedLoop[], perLength = PER_LENGTH_KEEP): DetectedLoop[] {
  const deduped = suppressNearDuplicates(candidates, Math.max(candidates.length, 1))
  const byBars = new Map<LoopBarLength, DetectedLoop[]>()
  for (const candidate of deduped) {
    const list = byBars.get(candidate.bars) ?? []
    list.push(candidate)
    byBars.set(candidate.bars, list)
  }
  const picked: DetectedLoop[] = []
  for (const list of byBars.values()) {
    picked.push(...list.slice(0, perLength))
  }
  picked.sort((a, b) => rankScore(b) - rankScore(a))
  return picked
}

export function detectLoopCandidates(input: DetectLoopsInput): DetectLoopsResult {
  const { samples, sampleRate } = input
  const vibeWindowSec = clampVibeWindowSec(input.vibeWindowSec ?? DEFAULT_VIBE_WINDOW_SEC)
  const duration = samples.length / sampleRate
  const { flux, frames, hopSec } = extractHopFeatures(samples, sampleRate)
  const bpm = input.bpmOverride != null && Number.isFinite(input.bpmOverride) && input.bpmOverride >= 40 && input.bpmOverride <= 240
    ? input.bpmOverride : estimateTempoBpm(flux, hopSec)
  const beatOffsetSec = estimateBeatOffsetSec(flux, hopSec, bpm)
  const beatSec = 60 / bpm
  const beats = beatSyncFeatures(frames, hopSec, beatOffsetSec, bpm)
  const transitionModels = new Map<number, TransitionModel>()

  const raw: DetectedLoop[] = []
  const placeSeam = (startSec: number, endSec: number) => {
    const shift = softenSeamShiftSec(samples, sampleRate, startSec, endSec, Math.min(0.025, beatSec * 0.2))
    const s = startSec + shift
    const e = endSec + shift
    if (s < 0 || e > duration) return { s: startSec, e: endSec }
    return { s, e }
  }

  for (const bars of BAR_LENGTHS) {
    const lag = bars * 4
    const lenSec = lag * beatSec
    if (lenSec < MIN_LOOP_SEC || lag >= beats.length) continue
    const windowSec = effectiveVibeWindowSec(lenSec, vibeWindowSec)
    if (windowSec < 0.2) continue
    const windowBeats = Math.max(1, Math.round(windowSec / beatSec))

    // A useful bed need not repeat again in the source song. Search every
    // beat phase, then keep alternatives within each bar before final scoring.
    // Picking a single stripe seed used to discard all long windows when its
    // favourite offset failed a later stability gate.
    const shortlist: { startBeat: number; ranked: number }[] = []
    for (let block = 0; block <= beats.length - lag; block += 4) {
      const options: { startBeat: number; ranked: number }[] = []
      for (let startBeat = block; startBeat < block + 4 && startBeat + lag <= beats.length; startBeat++) {
        const start = beatOffsetSec + startBeat * beatSec
        const end = start + lenSec
        if (end > duration) continue
        const wrap = beatWrapVibe(beats, startBeat, startBeat + lag, windowBeats)
        if (wrap < MIN_WRAP - 0.08) continue
        const hom = scoreHomogeneity(frames, hopSec, start, end, 4 * beatSec)
        if (hom < (bars >= 16 ? 0.92 : bars >= 8 ? 0.9 : bars >= 4 ? 0.86 : 0)) continue
        const closure = scorePhraseClosure(frames, hopSec, start, end, windowSec) ?? wrap
        options.push({ startBeat, ranked: 0.75 * closure + 0.25 * wrap })
      }
      options.sort((a, b) => b.ranked - a.ranked)
      shortlist.push(...options.slice(0, 2))
    }
    let model = transitionModels.get(windowSec)
    if (!model) {
      model = buildTransitionModel(frames, hopSec, beatSec, windowSec)
      transitionModels.set(windowSec, model)
    }
    for (const option of shortlist) {
      const s = beatOffsetSec + option.startBeat * beatSec
      const e = s + lenSec
      const placed = placeSeam(s, e)
      const scored = scoreLoopWindow(
        samples,
        sampleRate,
        placed.s,
        placed.e,
        bpm,
        frames,
        hopSec,
        vibeWindowSec,
        model
      )
      if (scored.contextScore < MIN_WRAP) continue
      if (scored.seamScore < MIN_SEAM) continue
      const minQ = 0.4
      if (scored.qualityScore < minQ) continue
      // Longer loops must stay internally stable — mid-loop scene changes
      // were a common "bad" rating on 4–16 bar beds.
      if (bars >= 4 && scored.homogeneityScore < 0.86) continue
      if (bars >= 8 && scored.homogeneityScore < 0.9) continue
      if (bars >= 16 && scored.homogeneityScore < 0.92) continue
      raw.push({ startSec: placed.s, endSec: placed.e, bars, ...scored })
    }
  }

  return {
    bpm,
    beatOffsetSec,
    candidates: selectAcrossLengths(raw),
  }
}

export function extractMonoForAnalysis(channels: Float32Array[], sampleRate: number): {
  samples: Float32Array
  sampleRate: number
} {
  let samples = downmix(channels)
  let sr = sampleRate
  if (sr >= 40000) {
    samples = decimate(samples, 2)
    sr = sr / 2
  }
  return { samples, sampleRate: sr }
}
