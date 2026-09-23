import type { LoopCandidate } from '@/loop/types'
import type { LoopRenderOptions } from '@/loop/wrapLoop'

export const MUSIC_STATES = ['exploration', 'tension', 'combat', 'intensity'] as const
export const CORE_MUSIC_STATES = ['exploration', 'combat'] as const
export type MusicState = typeof MUSIC_STATES[number]
export type MusicSettings = { exitBars: number; fadeBeats: number; releaseSec: number; combatToExplorationFadeBeats?: number;
  advance?: boolean; repeats?: number; approvedOnly?: boolean }
export const DEFAULT_MUSIC_SETTINGS: MusicSettings = { exitBars: 2, fadeBeats: 1, releaseSec: 3,
  combatToExplorationFadeBeats: 4, advance: true, repeats: 1, approvedOnly: true }
export type MusicSlot = { key: string; candidate: Omit<LoopCandidate, 'bars'> & { bars: number }; render: LoopRenderOptions; kind?: 'loop' | 'passage' }
export type MusicSlots = Partial<Record<MusicState, MusicSlot[]>>
export function activeMusicSlots(slots: MusicSlots, state: MusicState,
  focus?: Partial<Record<MusicState, string>>): MusicSlot[] {
  return (slots[state] ?? []).filter(slot => !focus || slot.key === focus[state])
}
export type ApprovedExit = { exitBar: number; entryBar?: number; fadeBeats?: number }
export type TransitionRule = { exitBars?: number; exitBar?: number; fadeBeats?: number; entryBar?: number;
  blocked?: boolean; approved?: boolean; approvedExits?: ApprovedExit[] }
export type TransitionRules = Record<string, TransitionRule>
/** Old single-exit reviews remain usable without rewriting saved projects. */
export function approvedExitPoints(rule?: TransitionRule): ApprovedExit[] {
  if (!rule || rule.blocked || rule.approved === false) return []
  if (rule.approvedExits?.length) return rule.approvedExits
  return rule.approved ? [{ exitBar: rule.exitBar ?? 0, entryBar: rule.entryBar, fadeBeats: rule.fadeBeats }] : []
}
export const hasApprovedExit = (rule?: TransitionRule): boolean => approvedExitPoints(rule).length > 0
export const passagePairKey = (from: MusicSlot, to: MusicSlot): string => JSON.stringify([from.key, to.key])
export const followsSource = (from: MusicSlot, to: MusicSlot): boolean => Math.abs(from.candidate.endSec - to.candidate.startSec) < 0.0001

/** An exact source span can include partial bars; it is played once, never treated as a proven loop. */
export function sourcePassage(sourceName: string, from: MusicSlot, endSec: number): MusicSlot | null {
  const startSec = from.candidate.endSec
  if (!Number.isFinite(endSec) || endSec - startSec < 0.08) return null
  const key = `${sourceName}|passage|${startSec.toFixed(6)}|${endSec.toFixed(6)}`
  return { key, kind: 'passage', render: { wrapCrossfadeSec: 0, normalize: false },
    candidate: { ...from.candidate, id: key, startSec, endSec,
      bars: (endSec - startSec) * from.candidate.bpm / 240,
      scoreVersion: 'unscored-source-passage', seamScore: 0, contextScore: 0, qualityScore: 0,
      homogeneityScore: 0, closureScore: undefined } }
}

export function sourceGaps(pool: MusicSlot[]): { from: MusicSlot; to: MusicSlot }[] {
  const sorted = [...pool].sort((a, b) => a.candidate.startSec - b.candidate.startSec)
  const gaps: { from: MusicSlot; to: MusicSlot }[] = []
  let previous = sorted[0]
  for (const next of sorted.slice(1)) {
    if (next.candidate.startSec - previous!.candidate.endSec >= 0.08) gaps.push({ from: previous!, to: next })
    if (next.candidate.endSec > previous!.candidate.endSec) previous = next
  }
  return gaps
}
export type TransitionReview = {
  updatedAt?: string
  entryOffsetSec?: number
  natural?: boolean
  id: string; at: string; from: MusicState; to: MusicState
  fromLoop: MusicSlot; toLoop: MusicSlot; settings: MusicSettings
  exitOffsetSec: number; fadeSec: number; rating?: 'good' | 'bad'; note: string
}

/** Prefer source continuity, then material not heard recently. Overlapping cuts are not variety. */
export function choosePassage(pool: MusicSlot[], from: MusicSlot, history: string[], rules: TransitionRules,
  approvedOnly = false): MusicSlot | undefined {
  const options = pool.filter(to => {
    const rule = rules[passagePairKey(from, to)]
    if (to.key === from.key || rule?.blocked || (approvedOnly && !hasApprovedExit(rule) && !followsSource(from, to))) return false
    const a = from.candidate, b = to.candidate
    const overlap = Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec))
    return overlap / Math.min(a.endSec - a.startSec, b.endSec - b.startSec) < 0.65
  })
  return options.sort((a, b) => Number(followsSource(from, b)) - Number(followsSource(from, a))
    || history.lastIndexOf(a.key) - history.lastIndexOf(b.key)
    || a.candidate.startSec - b.candidate.startSec)[0]
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

/** A reviewed route always leaves at the same musical bar in each repeat. */
export function nextMusicExitAtBar(now: number, startedAt: number, duration: number, bars: number,
  exitBar: number, earliest: number): number {
  const threshold = Math.max(now + 0.08, earliest)
  const first = startedAt + exitBar * duration / bars
  return first + Math.max(0, Math.ceil((threshold - first - 1e-9) / duration)) * duration
}

/** Wait through the playing loop and take the first of its reviewed exits. */
export function nextApprovedMusicExit(now: number, startedAt: number, duration: number, bars: number,
  exits: ApprovedExit[], earliest: number): { when: number; exit: ApprovedExit } | undefined {
  return exits.map(exit => ({ exit, when: nextMusicExitAtBar(now, startedAt, duration, bars, exit.exitBar, earliest) }))
    .sort((a, b) => a.when - b.when || a.exit.exitBar - b.exit.exitBar)[0]
}

export function releaseDelay(from: MusicState, to: MusicState, seconds: number): number {
  return MUSIC_STATES.indexOf(to) < MUSIC_STATES.indexOf(from) ? seconds : 0
}
