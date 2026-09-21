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
const MIN_LOOP_SEC = 2
const MAX_KEEP = 36
const BAR_LENGTHS: LoopBarLength[] = [4, 8, 16]
const WRAP_CORR_SEC = 0.05
const ONSET_HEAD_SEC = 0.03
const CHROMA_BINS = 12
const TIMBRE_BINS = 8
const SPEC_BINS = 24
/** Joins rougher than a normal moment in the song stay out of the list. */
const MIN_CONTINUITY = 0.55

type FrameFeatures = {
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

type TransitionModel = {
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

  return foldBpm(60 / (bestLag * hopSec))
}

export function estimateBeatOffsetSec(flux: Float32Array, hopSec: number, bpm: number): number {
  const periodSec = 60 / bpm
  const periodHops = Math.max(1, Math.round(periodSec / hopSec))
  const offsetHops = periodHops
  let bestOff = 0
  let best = -Infinity
  for (let off = 0; off < offsetHops; off++) {
    let s = 0
    let n = 0
    for (let i = off; i < flux.length; i += periodHops) {
      s += flux[i]!
      n++
    }
    const v = n > 0 ? s / n : 0
    if (v > best) {
      best = v
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
  if (b0 < start) return 0
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
  const firstEnd = Math.min(end, start + beatN)
  const lastStart = Math.max(start, end - beatN)

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
  for (let i = start; i < start + headN && i < end; i++) {
    peakHead = Math.max(peakHead, Math.abs(samples[i] ?? 0))
  }
  const loopRms = rms(samples, start, end)
  const onsetPen = Math.max(0, Math.min(1, (peakHead - loopRms * 4) / (loopRms * 8 + 1e-6)))

  const score = 0.35 * rmsMatch + 0.3 * specMatch + 0.25 * corr + 0.1 * (1 - onsetPen)
  return Math.max(0, Math.min(1, score))
}

function ratioSim(a: number, b: number): number {
  const hi = Math.max(Math.abs(a), Math.abs(b), 1e-8)
  return Math.min(Math.abs(a), Math.abs(b)) / hi
}

/**
 * Harmony, instrumentation, and loudness each have to agree.
 * A shared key cannot hide a chorus hit or a drop.
 */
function frameVibeSim(a: FrameFeatures, b: FrameFeatures): number {
  const harmony = cosineSim(a.chroma, b.chroma)
  const timbre = cosineSim(a.timbre, b.timbre)
  const energy = ratioSim(a.rms, b.rms)
  const brightness = 1 - Math.min(1, Math.abs(a.centroid - b.centroid) / 0.2)
  const worst = Math.min(harmony, timbre, energy)
  const mean = (harmony + timbre + energy + brightness) / 4
  return Math.max(0, Math.min(1, worst * 0.6 + mean * 0.4))
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

function buildTransitionModel(
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
    if (endF - startF < width * 2) continue
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
  return Math.max(0, Math.min(1, 0.4 * meanAdj + 0.3 * minSim + 0.3 * halfSim))
}

/** Vibe match gates the score: a clean splice cannot rescue a character jump. */
export function combineQuality(seam: number, context: number, homogeneity: number): number {
  return Math.max(0, Math.min(1, context * (0.4 + 0.3 * homogeneity + 0.3 * seam)))
}

/** Playback offset so the wrap is the first thing you hear. */
export function joinPreviewOffset(startSec: number, endSec: number, bpm: number): number {
  const barSec = (60 / Math.max(1, bpm)) * 4
  const lead = Math.min(barSec, Math.max(0.25, (endSec - startSec) * 0.5))
  return Math.max(startSec, endSec - lead)
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const a = [...values].sort((x, y) => x - y)
  const i = Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))
  return a[i]!
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

function interiorNoveltyCut(beats: FrameFeatures[]): { nov: number[]; cut: number } {
  const nov: number[] = []
  for (let i = 1; i < beats.length; i++) {
    nov.push(1 - frameVibeSim(beats[i - 1]!, beats[i]!))
  }
  return { nov, cut: Math.max(0.38, percentile(nov, 0.85)) }
}

function interiorNoveltyTooHigh(
  nov: number[],
  cut: number,
  startBeat: number,
  endBeat: number
): boolean {
  if (endBeat - startBeat < 6) return false
  let peak = 0
  const lo = startBeat + 2
  const hi = endBeat - 2
  for (let i = lo; i < hi; i++) peak = Math.max(peak, nov[i] ?? 0)
  return peak > cut
}

export function scoreLoopWindow(
  samples: Float32Array,
  sampleRate: number,
  startSec: number,
  endSec: number,
  bpm: number,
  frames?: FrameFeatures[],
  hopSec?: number,
  vibeWindowSec: number = DEFAULT_VIBE_WINDOW_SEC
): {
  seamScore: number
  contextScore: number
  homogeneityScore: number
  qualityScore: number
} {
  const seamScore = scoreSeam(samples, sampleRate, startSec, endSec, bpm)
  const feats = frames ?? extractHopFeatures(samples, sampleRate).frames
  const hop = hopSec ?? hopSecFor(sampleRate)
  const barSec = (60 / Math.max(1, bpm)) * 4
  const beatSec = 60 / Math.max(1, bpm)
  const longSec = Math.min(clampVibeWindowSec(vibeWindowSec), Math.max(0.2, (endSec - startSec) * 0.45))
  const model = buildTransitionModel(feats, hop, beatSec, longSec)
  const contextScore = scoreJoinContinuity(feats, hop, startSec, endSec, model)
  const homogeneityScore = scoreHomogeneity(feats, hop, startSec, endSec, barSec)
  return {
    seamScore,
    contextScore,
    homogeneityScore,
    qualityScore: combineQuality(seamScore, contextScore, homogeneityScore),
  }
}

function overlapRatio(a0: number, a1: number, b0: number, b1: number): number {
  const inter = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
  const shorter = Math.min(a1 - a0, b1 - b0)
  return shorter <= 0 ? 0 : inter / shorter
}

function rankScore(c: DetectedLoop): number {
  return c.qualityScore
}

export function suppressNearDuplicates(candidates: DetectedLoop[], keep = MAX_KEEP): DetectedLoop[] {
  const sorted = [...candidates].sort((a, b) => rankScore(b) - rankScore(a))
  const out: DetectedLoop[] = []
  for (const c of sorted) {
    const dup = out.some((o) => {
      const ov = overlapRatio(c.startSec, c.endSec, o.startSec, o.endSec)
      if (c.bars === o.bars && ov > 0.45) return true
      if (c.bars !== o.bars && ov > 0.85) return true
      return false
    })
    if (!dup) out.push(c)
    if (out.length >= keep) break
  }
  return out
}

export function detectLoopCandidates(input: DetectLoopsInput): DetectLoopsResult {
  const { samples, sampleRate } = input
  const vibeWindowSec = clampVibeWindowSec(input.vibeWindowSec ?? DEFAULT_VIBE_WINDOW_SEC)
  const duration = samples.length / sampleRate
  const { flux, frames, hopSec } = extractHopFeatures(samples, sampleRate)
  const bpm = estimateTempoBpm(flux, hopSec)
  const beatOffsetSec = estimateBeatOffsetSec(flux, hopSec, bpm)
  const beatSec = 60 / bpm
  const beats = beatSyncFeatures(frames, hopSec, beatOffsetSec, bpm)
  const novelty = interiorNoveltyCut(beats)

  const raw: DetectedLoop[] = []
  for (const bars of BAR_LENGTHS) {
    const lag = bars * 4
    const lenSec = lag * beatSec
    if (lenSec < MIN_LOOP_SEC || lag >= beats.length) continue
    const longSec = Math.min(vibeWindowSec, Math.max(0.2, lenSec * 0.45))
    const model = buildTransitionModel(frames, hopSec, beatSec, longSec, beatOffsetSec)
    const scores: number[] = []
    const maxStart = beats.length - lag
    for (let i = 0; i <= maxStart; i++) scores.push(lagStripeScore(beats, i, lag))
    const minKeep = percentile(scores, 0.72)
    const peaks = pickLagPeaks(scores, minKeep, Math.max(4, Math.floor(lag / 2)))
    for (const seed of peaks) {
      let best: { startBeat: number; endBeat: number; continuity: number; ranked: number } | null =
        null
      const maxD = Math.min(lag - 1, beats.length - lag - seed)
      for (let d = 0; d <= maxD; d++) {
        const startBeat = seed + d
        const endBeat = startBeat + lag
        if (interiorNoveltyTooHigh(novelty.nov, novelty.cut, startBeat, endBeat)) continue
        const s = Math.max(0, beatOffsetSec + startBeat * beatSec)
        const e = Math.min(duration, beatOffsetSec + endBeat * beatSec)
        if (e - s < MIN_LOOP_SEC) continue
        const continuity = scoreJoinContinuity(frames, hopSec, s, e, model)
        const ranked = continuity + (startBeat % 4 === 0 ? 0.05 : 0)
        if (!best || ranked > best.ranked) best = { startBeat, endBeat, continuity, ranked }
      }
      if (!best || best.continuity < MIN_CONTINUITY) continue
      const s = Math.max(0, beatOffsetSec + best.startBeat * beatSec)
      const e = Math.min(duration, beatOffsetSec + best.endBeat * beatSec)
      const seamScore = scoreSeam(samples, sampleRate, s, e, bpm)
      const homogeneityScore = scoreHomogeneity(frames, hopSec, s, e, beatSec * 4)
      raw.push({
        startSec: s,
        endSec: e,
        bars,
        seamScore,
        contextScore: best.continuity,
        homogeneityScore,
        qualityScore: combineQuality(seamScore, best.continuity, homogeneityScore),
      })
    }
  }

  return {
    bpm,
    beatOffsetSec,
    candidates: suppressNearDuplicates(raw),
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
