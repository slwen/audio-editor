import type { LoopCandidate } from '@/loop/types'
import type { LoopRenderOptions } from '@/loop/wrapLoop'

export const MUSIC_STATES = ['exploration', 'tension', 'combat', 'intensity'] as const
export type MusicState = typeof MUSIC_STATES[number]
export type MusicSettings = { exitBars: number; fadeBeats: number; releaseSec: number }
export const DEFAULT_MUSIC_SETTINGS: MusicSettings = { exitBars: 1, fadeBeats: 0.25, releaseSec: 3 }
export type MusicSlot = { key: string; candidate: LoopCandidate; render: LoopRenderOptions }
export type MusicSlots = Partial<Record<MusicState, MusicSlot>>
export type TransitionReview = {
  updatedAt?: string
  id: string; at: string; from: MusicState; to: MusicState
  fromLoop: MusicSlot; toLoop: MusicSlot; settings: MusicSettings
  exitOffsetSec: number; fadeSec: number; rating?: 'good' | 'bad'; note: string
}

/** Exit positions are relative to this loop's actual sample duration, including its wrap. */
export function nextMusicExit(now: number, startedAt: number, duration: number, bars: number,
  exitBars: number, earliest: number): number {
  const threshold = Math.max(now + 0.08, earliest)
  const cycle = Math.max(0, Math.floor((threshold - startedAt) / duration))
  const step = exitBars > 0 ? exitBars : bars
  for (let c = cycle; c <= cycle + 1; c++) {
    for (let bar = 0; bar < bars; bar += step) {
      const time = startedAt + c * duration + bar * duration / bars
      if (time >= threshold - 1e-9) return time
    }
  }
  return startedAt + (cycle + 2) * duration
}

export function releaseDelay(from: MusicState, to: MusicState, seconds: number): number {
  return MUSIC_STATES.indexOf(to) < MUSIC_STATES.indexOf(from) ? seconds : 0
}
