import type { LoopCandidate } from '@/loop/types'
import { loopRatingKey } from '@/loop/loopRatings'
import { loopRenderOptions } from '@/loop/renderSettings'
import { fftRadix2 } from '@/loop/fft'
import type { useLoopStore } from '@/store/useLoopStore'
import { approvedExitPoints, hasApprovedExit, passagePairKey, type MusicSlot, type MusicSlots,
  type TransitionReview, type TransitionRules } from './model'

export type ZoneFeel = 'exploration' | 'combat'
export type ZoneFlag = { id: string; timeSec: number; state: ZoneFeel }
export type SongZone = { startSec: number; endSec: number; state: ZoneFeel }
type LoopSession = ReturnType<typeof useLoopStore.getState>

export function songZones(start: number, end: number, flags: ZoneFlag[]): SongZone[] {
  const ordered = flags.filter(f => Number.isFinite(f.timeSec) && f.timeSec >= start && f.timeSec < end)
    .sort((a, b) => a.timeSec - b.timeSec)
  const zones: SongZone[] = []
  let cursor = start
  let state: ZoneFeel = 'exploration'
  for (const flag of ordered) {
    if (flag.timeSec - cursor >= 0.08) zones.push({ startSec: cursor, endSec: flag.timeSec, state })
    cursor = flag.timeSec
    state = flag.state
  }
  if (end - cursor >= 0.08) zones.push({ startSec: cursor, endSec: end, state })
  return zones
}

/** Find one reliable hold per marked span. Broad flags may be a few seconds off the edit. */
export function draftZoneLoops(loop: LoopSession, zones: SongZone[]): { slots: MusicSlots; missing: SongZone[] } {
  const slots: MusicSlots = { exploration: [], combat: [] }
  const missing: SongZone[] = []
  const unique = [...new Map(loop.candidates.map(c => [loopRatingKey({ sourceName: loop.sourceName, ...c }), c])).values()]
  for (const [index, zone] of zones.entries()) {
    const tolerance = Math.min(3, (zone.endSec - zone.startSec) * 0.1)
    const choices = unique.filter(c => {
      const key = loopRatingKey({ sourceName: loop.sourceName, ...c })
      return c.bars >= 4 && loop.ratings[key] !== 'bad'
        && c.startSec >= zone.startSec - tolerance && c.endSec <= zone.endSec + tolerance
    })
    const preferred = choices.filter(c => loop.ratings[loopRatingKey({ sourceName: loop.sourceName, ...c })] === 'good')
    const candidates = preferred.length ? preferred : choices
    const ranked = candidates.sort((a, b) => {
      const score = (c: LoopCandidate) => {
        const position = (c.startSec - zone.startSec) / Math.max(1, zone.endSec - zone.startSec)
        const towardChange = zone.state === 'exploration'
          ? zones[index + 1]?.state === 'combat' ? position * 1.6
            : zones[index - 1]?.state === 'combat' ? (1 - position) * 1.6 : 0
          : 0
        return c.qualityScore * 2 + Math.min(c.bars, 16) / 16
          + (zone.state === 'combat' ? c.bars / 16 : 0) + towardChange
      }
      return score(b) - score(a) || a.startSec - b.startSec
    })
    const best = ranked[0]
    if (!best) { missing.push(zone); continue }
    const key = loopRatingKey({ sourceName: loop.sourceName, ...best })
    const slot: MusicSlot = { key, candidate: { ...best }, render: { ...loopRenderOptions(loop, best) } }
    if (!slots[zone.state]!.some(s => s.key === key)) slots[zone.state]!.push(slot)
  }
  return { slots, missing }
}

export type RouteSuggestion = { from: MusicSlot; to: MusicSlot; exitBar: number; entryBar?: number; score: number }
export type HoldRoutes = { source: MusicSlot; approved: RouteSuggestion[]; suggested: RouteSuggestion[] }

export function orderedBeds(slots: MusicSlot[]): MusicSlot[] {
  return slots.filter(slot => slot.kind !== 'passage')
    .sort((a, b) => a.candidate.startSec - b.candidate.startSec || b.candidate.bars - a.candidate.bars)
}

export function nextBed(beds: MusicSlot[], currentKey: string): MusicSlot | undefined {
  if (beds.length < 2) return undefined
  const index = beds.findIndex(slot => slot.key === currentKey)
  return index < 0 ? beds[0] : beds[(index + 1) % beds.length]
}

/** Longest time from a request to the next approved exit, ignoring any configured release. */
export function longestExitWait(source: MusicSlot, routes: RouteSuggestion[]): number {
  const bars = source.candidate.bars
  const duration = source.candidate.endSec - source.candidate.startSec
  const points = [...new Set(routes.map(route => route.exitBar))].sort((a, b) => a - b)
  if (!points.length || bars <= 0) return Infinity
  return Math.max(...points.map((bar, index) =>
    ((points[(index + 1) % points.length] ?? bar) - bar + bars) % bars || bars)) * duration / bars
}

export type SectionCoverage = { feel: ZoneFeel; slot: MusicSlot; switchPoints: number;
  longestSwitchWaitSec: number | null; incomingRoutes: number; sameFeelRoutes: number }

/** Summarize approved, directed joins for every section in the focused two-feel workflow. */
export function assessSectionCoverage(beds: Record<ZoneFeel, MusicSlot[]>, rules: TransitionRules): SectionCoverage[] {
  const sections = (['exploration', 'combat'] as const).flatMap(feel => beds[feel].map(slot => ({ feel, slot })))
  return sections.map(({ feel, slot }) => {
    const otherFeel = feel === 'combat' ? 'exploration' : 'combat'
    const switchRoutes = beds[otherFeel].flatMap(to => approvedExitPoints(rules[passagePairKey(slot, to)])
      .map(exit => ({ from: slot, to, exitBar: exit.exitBar, entryBar: exit.entryBar, score: 0 })))
    return { feel, slot, switchPoints: switchRoutes.length,
      longestSwitchWaitSec: switchRoutes.length ? longestExitWait(slot, switchRoutes) : null,
      incomingRoutes: sections.filter(from => from.slot.key !== slot.key
        && hasApprovedExit(rules[passagePairKey(from.slot, slot)])).length,
      sameFeelRoutes: beds[feel].filter(to => to.key !== slot.key
        && hasApprovedExit(rules[passagePairKey(slot, to)])).length }
  })
}

/** Sections the approved routing graph can reach from one starting section. */
export function reachableSections(beds: Record<ZoneFeel, MusicSlot[]>, rules: TransitionRules,
  start: { feel: ZoneFeel; slot: MusicSlot }): Set<string> {
  const sections = (['exploration', 'combat'] as const).flatMap(feel => beds[feel].map(slot => ({ feel, slot })))
  const id = (feel: ZoneFeel, slot: MusicSlot) => JSON.stringify([feel, slot.key])
  const reached = new Set([id(start.feel, start.slot)])
  let changed = true
  while (changed) {
    changed = false
    for (const from of sections.filter(section => reached.has(id(section.feel, section.slot)))) {
      for (const to of sections) {
        const destination = id(to.feel, to.slot)
        if (reached.has(destination)) continue
        if (from.slot.key !== to.slot.key && !hasApprovedExit(rules[passagePairKey(from.slot, to.slot)])) continue
        reached.add(destination)
        changed = true
      }
    }
  }
  return reached
}

/** Keep the everyday preview on one musically nearby pair, preferring pairs already reviewed. */
export function chooseFocusedPair(explorations: MusicSlot[], combats: MusicSlot[], rules: TransitionRules):
  { exploration: MusicSlot; combat: MusicSlot } | null {
  const pairs = explorations.filter(slot => slot.kind !== 'passage').flatMap(exploration =>
    combats.filter(slot => slot.kind !== 'passage').map(combat => {
      const into = rules[passagePairKey(exploration, combat)]
      const back = rules[passagePairKey(combat, exploration)]
      const gap = Math.abs(combat.candidate.startSec - exploration.candidate.endSec)
      const score = (hasApprovedExit(into) ? 3 : 0) + (hasApprovedExit(back) ? 3 : 0)
        + Math.min(combat.candidate.bars, 16) / 16 + Math.max(0, 2 - gap / 10)
        + (combat.candidate.startSec >= exploration.candidate.endSec ? 0.5 : 0)
      return { exploration, combat, score }
    }))
  const best = pairs.sort((a, b) => b.score - a.score || a.exploration.candidate.startSec - b.exploration.candidate.startSec)[0]
  return best ? { exploration: best.exploration, combat: best.combat } : null
}

/** Every hold needs its own exits; a Good route from a different hold cannot serve it. */
export function routesForEachHold(sources: MusicSlot[], targets: MusicSlot[], ranked: RouteSuggestion[],
  rules: TransitionRules, reviews: TransitionReview[]): HoldRoutes[] {
  return sources.map(source => {
    const approved = targets.flatMap(to => approvedExitPoints(rules[passagePairKey(source, to)])
      .map(exit => ({ from: source, to, exitBar: exit.exitBar, entryBar: exit.entryBar ?? 0, score: Infinity })))
    const suggested = ranked.filter(route => route.from.key === source.key
      && !rules[passagePairKey(route.from, route.to)]?.blocked
      && !approved.some(ready => ready.to.key === route.to.key && ready.exitBar === route.exitBar)
      && !reviews.some(review => {
        if (review.rating !== 'bad' || passagePairKey(review.fromLoop, review.toLoop) !== passagePairKey(route.from, route.to)) return false
        const bars = route.from.candidate.bars
        const duration = route.from.candidate.endSec - route.from.candidate.startSec
        const destination = review.toLoop.candidate
        const entryBar = Math.round((review.entryOffsetSec ?? 0) /
          (destination.endSec - destination.startSec) * destination.bars)
        return Math.round(review.exitOffsetSec / duration * bars) % bars === route.exitBar
          && entryBar === (route.entryBar ?? 0)
      })).sort((a, b) => longestExitWait(source, [...approved, a]) - longestExitWait(source, [...approved, b])
        || b.score - a.score).slice(0, approved.length ? 1 : 2)
    return { source, approved, suggested }
  })
}

/** A lightweight ranking of phrase boundaries. Listening remains the final check. */
export function suggestRoutes(buffer: AudioBuffer, from: MusicSlot[], to: MusicSlot[]): RouteSuggestion[] {
  const data = buffer.getChannelData(0)
  const rate = buffer.sampleRate
  const signature = (second: number, side: -1 | 1) => {
    const chroma = Array(12).fill(0) as number[]
    let energy = 0
    let brightness = 0
    for (const offset of [0.12, 0.32, 0.54]) {
      const center = Math.round((second + side * offset) * rate)
      const re = new Float32Array(4096)
      const im = new Float32Array(4096)
      for (let i = 0; i < re.length; i++) {
        const sample = data[center - 2048 + i] ?? 0
        re[i] = sample * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (re.length - 1)))
        energy += sample * sample / (re.length * 3)
      }
      fftRadix2(re, im)
      for (let bin = 5; bin < 190; bin++) {
        const hz = bin * rate / re.length
        if (hz < 55 || hz > 2000) continue
        const magnitude = Math.hypot(re[bin], im[bin])
        const note = Math.round(69 + 12 * Math.log2(hz / 440))
        chroma[(note % 12 + 12) % 12] += magnitude
        brightness += magnitude * Math.min(1, hz / 2000)
      }
    }
    const sum = chroma.reduce((a, b) => a + b, 0) || 1
    return { chroma: chroma.map(v => v / sum), loudness: Math.log1p(Math.sqrt(energy) * 20), brightness: brightness / sum }
  }
  const result: RouteSuggestion[] = []
  for (const source of from) for (const destination of to) {
    if (source.key === destination.key) continue
    const bars = Math.floor(source.candidate.bars)
    const destinationBars = Math.floor(destination.candidate.bars)
    const exits = Array.from({ length: bars }, (_, index) => index)
    const entries = Array.from({ length: Math.min(4, destinationBars) }, (_, index) => index)
    const arrivals = entries.map(entryBar => signature(destination.candidate.startSec
      + entryBar / destination.candidate.bars * (destination.candidate.endSec - destination.candidate.startSec), 1))
    for (const exitBar of exits) {
      const position = exitBar === 0 ? source.candidate.endSec : source.candidate.startSec
        + exitBar / source.candidate.bars * (source.candidate.endSec - source.candidate.startSec)
      const outgoing = signature(position, -1)
      for (const [entryBar, arrival] of arrivals.entries()) {
        const harmonicDistance = outgoing.chroma.reduce((sum, value, i) => sum + Math.abs(value - arrival.chroma[i]), 0)
        const score = -harmonicDistance - Math.abs(outgoing.loudness - arrival.loudness) * 0.3
          - Math.abs(outgoing.brightness - arrival.brightness) * 0.2
          + (exitBar % 4 === 0 ? 0.12 : 0) + (entryBar === 0 ? 0.12 : entryBar % 2 === 0 ? 0.06 : 0)
          + (Math.abs(source.candidate.endSec - destination.candidate.startSec) < 2 ? 0.25 : 0)
        result.push({ from: source, to: destination, exitBar, entryBar, score })
      }
    }
  }
  return result.sort((a, b) => b.score - a.score)
}
