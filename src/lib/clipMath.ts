import type { Clip } from '@/types'

const CLIP_SPEED_MIN = 0.2
const CLIP_SPEED_MAX = 3
const CLIP_LINEAR_GAIN_MAX = 4

export function clampPlaybackSpeed(s: number): number {
  return Math.max(CLIP_SPEED_MIN, Math.min(CLIP_SPEED_MAX, s))
}

export function clampLinearGain(g: number): number {
  return Math.max(0, Math.min(CLIP_LINEAR_GAIN_MAX, g))
}

export function clampFadeSeconds(sec: number): number {
  return Math.max(0, Math.min(60, sec))
}

export function clipTimelineDuration(clip: Clip): number {
  const src = Math.max(0, clip.trimEnd - clip.trimStart)
  const sp = clampPlaybackSpeed(clip.speed)
  return src / sp
}

export function clipTimelineEnd(clip: Clip): number {
  return clip.startTime + clipTimelineDuration(clip)
}

export function sourceTimeAtTimelineTime(clip: Clip, timelineT: number): number {
  const sp = clampPlaybackSpeed(clip.speed)
  return clip.trimStart + (timelineT - clip.startTime) * sp
}

export function fadeMultiplier(clip: Clip, timelineT: number, clipEnd: number): number {
  let m = 1
  if (clip.fadeInSec > 0) {
    const fe = clip.startTime + clip.fadeInSec
    if (timelineT < fe) {
      const u = (timelineT - clip.startTime) / clip.fadeInSec
      m *= Math.max(0, Math.min(1, u))
    }
  }
  if (clip.fadeOutSec > 0) {
    const fs = clipEnd - clip.fadeOutSec
    if (timelineT > fs) {
      const u = (clipEnd - timelineT) / clip.fadeOutSec
      m *= Math.max(0, Math.min(1, u))
    }
  }
  return m
}

export function clipsSortedForDraw(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => {
    if (a.row !== b.row) return a.row - b.row
    if (a.startTime !== b.startTime) return a.startTime - b.startTime
    return a.layerIndex - b.layerIndex
  })
}

export function clipsSortedForHitTest(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => {
    if (a.row !== b.row) return a.row - b.row
    if (a.layerIndex !== b.layerIndex) return b.layerIndex - a.layerIndex
    return a.startTime - b.startTime
  })
}

export function getProjectEndTime(clips: Clip[]): number {
  let m = 8
  for (const c of clips) m = Math.max(m, clipTimelineEnd(c))
  return m
}
