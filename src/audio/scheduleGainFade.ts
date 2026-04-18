import { fadeMultiplier } from '@/lib/clipMath'
import type { Clip } from '@/types'

export type GainFadeScheduleOpts = {
  maxSteps: number
  minSteps: number
  stepsPerSecond: number
}

/** Piecewise-linear gain automation along a wall-clock segment of the timeline. */
export function scheduleTimelineGainFade(
  param: AudioParam,
  clip: Clip,
  clipEnd: number,
  baseGain: number,
  audioTimeBase: number,
  wallT0: number,
  wallDuration: number,
  opts: GainFadeScheduleOpts
): void {
  param.cancelScheduledValues(audioTimeBase)
  const DECLICK_SEC = 0.001
  const edgeSec = Math.min(DECLICK_SEC, Math.max(0, wallDuration * 0.5))
  const gainAtTimeline = (tline: number): number => {
    let edgeMul = 1
    if (edgeSec > 0) {
      if (tline < clip.startTime + edgeSec) {
        edgeMul = Math.min(edgeMul, Math.max(0, (tline - clip.startTime) / edgeSec))
      }
      if (tline > clipEnd - edgeSec) {
        edgeMul = Math.min(edgeMul, Math.max(0, (clipEnd - tline) / edgeSec))
      }
    }
    const fadeMul = fadeMultiplier(clip, tline, clipEnd)
    return Math.max(0, baseGain * fadeMul * edgeMul)
  }
  const steps = Math.min(
    opts.maxSteps,
    Math.max(opts.minSteps, Math.ceil(wallDuration * opts.stepsPerSecond))
  )
  const firstVal = gainAtTimeline(wallT0)
  param.setValueAtTime(firstVal, audioTimeBase)
  if (wallDuration <= 0) return

  const attackW = edgeSec > 0 ? Math.min(edgeSec, wallDuration) : 0
  const releaseStartW = edgeSec > 0 ? Math.max(0, wallDuration - edgeSec) : wallDuration

  if (attackW > 0) {
    param.linearRampToValueAtTime(gainAtTimeline(wallT0 + attackW), audioTimeBase + attackW)
  }

  for (let i = 1; i <= steps; i++) {
    const w = (i / steps) * wallDuration
    if (w <= attackW + 1e-6) continue
    if (w >= releaseStartW - 1e-6) continue
    const tline = wallT0 + w
    param.linearRampToValueAtTime(gainAtTimeline(tline), audioTimeBase + w)
  }

  if (releaseStartW > attackW + 1e-6) {
    param.linearRampToValueAtTime(
      gainAtTimeline(wallT0 + releaseStartW),
      audioTimeBase + releaseStartW
    )
  }
  param.linearRampToValueAtTime(gainAtTimeline(wallT0 + wallDuration), audioTimeBase + wallDuration)
}
