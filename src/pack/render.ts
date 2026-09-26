import type { PackStep } from './runtime'

/** A contiguous run of source audio, placed on the output timeline. */
export type PlaySegment = {
  sourceStartSec: number
  sourceEndSec: number
  outputStartSec: number
  /** Crossfade centred on this segment's start; 0 for the first. */
  fadeInSec: number
}

/** Steps that continue the source merge into one segment; every jump starts a new one. */
export function stepsToSegments(steps: PackStep[]): PlaySegment[] {
  const segments: PlaySegment[] = []
  let output = 0
  for (const step of steps) {
    const last = segments.at(-1)
    const jumped = step.join && step.join.kind !== 'natural-switch'
    if (last && !jumped && Math.abs(last.sourceEndSec - step.startSec) < 1e-6) last.sourceEndSec = step.endSec
    else segments.push({ sourceStartSec: step.startSec, sourceEndSec: step.endSec, outputStartSec: output,
      fadeInSec: last ? step.join?.fadeSec ?? 0 : 0 })
    output += step.endSec - step.startSec
  }
  return segments
}

/**
 * Equal-power for real blends between different material; linear for short click repairs,
 * where both sides are nearly the same signal.
 */
function fadeGain(x: number, fadeSec: number, rising: boolean): number {
  const t = Math.max(0, Math.min(1, x))
  const u = rising ? t : 1 - t
  return fadeSec >= 0.3 ? Math.sin(u * Math.PI / 2) : u
}

export function renderSegments(channels: Float32Array[], sampleRate: number, segments: PlaySegment[]): Float32Array[] {
  const end = segments.at(-1)
  const totalSec = end ? end.outputStartSec + (end.sourceEndSec - end.sourceStartSec) : 0
  const out = channels.map(() => new Float32Array(Math.ceil(totalSec * sampleRate)))
  segments.forEach((segment, k) => {
    const fadeIn = segment.fadeInSec
    const fadeOut = segments[k + 1]?.fadeInSec ?? 0
    const fromSec = segment.sourceStartSec - fadeIn / 2
    const toSec = segment.sourceEndSec + fadeOut / 2
    const outFrom = Math.round((segment.outputStartSec - fadeIn / 2) * sampleRate)
    const length = Math.round((toSec - fromSec) * sampleRate)
    const srcFrom = Math.round(fromSec * sampleRate)
    for (let i = 0; i < length; i++) {
      const o = outFrom + i
      const s = srcFrom + i
      if (o < 0 || o >= out[0]!.length || s < 0 || s >= channels[0]!.length) continue
      const sec = i / sampleRate
      let gain = 1
      if (fadeIn > 0 && sec < fadeIn) gain *= fadeGain(sec / fadeIn, fadeIn, true)
      const untilEnd = (length - i) / sampleRate
      if (fadeOut > 0 && untilEnd < fadeOut) gain *= fadeGain(1 - untilEnd / fadeOut, fadeOut, false)
      for (let c = 0; c < channels.length; c++) out[c]![o]! += channels[c]![s]! * gain
    }
  })
  return out
}
