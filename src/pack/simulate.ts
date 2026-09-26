import type { ZoneFeel } from '@/adaptive/zonePlan'
import { feelAt, type Pack } from './pack'
import { PackRuntime, type PackJoin, type PackStep } from './runtime'

/** `urgent` asks for combat now, as when a fight opens instantly. */
export type FeelRequest = { atSec: number; feel: ZoneFeel; urgent?: boolean }
export type SimulatedJoin = PackJoin & { atSec: number }
export type Simulation = {
  steps: PackStep[]
  /** As the game asked for them, before the Combat -> Exploration release delay. */
  requests: FeelRequest[]
  joins: SimulatedJoin[]
  /** Seconds from each request until the requested feel was playing. */
  latencies: { feel: ZoneFeel; sec: number }[]
}

export function seededRandom(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Alternating level-like requests: exploration 20-80 s, combat 15-90 s. */
export function randomRequests(durationSec: number, seed: number, first: ZoneFeel = 'exploration',
  urgentCombat = false): FeelRequest[] {
  const random = seededRandom(seed)
  const requests: FeelRequest[] = []
  let feel = first
  for (let t = 0; t < durationSec;) {
    t += feel === 'exploration' ? 20 + random() * 60 : 15 + random() * 75
    feel = feel === 'exploration' ? 'combat' : 'exploration'
    if (t < durationSec) requests.push({ atSec: t, feel, ...(urgentCombat && feel === 'combat' ? { urgent: true } : {}) })
  }
  return requests
}

export function simulatePack(pack: Pack, durationSec: number, requests: FeelRequest[], first: ZoneFeel = 'exploration'): Simulation {
  const runtime = new PackRuntime(pack)
  const effective = requests.map(r => ({ ...r,
    applyAt: r.atSec + (r.feel === 'exploration' ? pack.policy.releaseSec : 0) }))
  const steps: PackStep[] = [runtime.start(first)]
  const joins: SimulatedJoin[] = []
  const latencies: Simulation['latencies'] = []
  let pending: FeelRequest | null = null
  let next = 0
  while (runtime.clock < durationSec) {
    const now = runtime.clock
    // A newer request replaces an older one that has not yet been applied, as a game would.
    const due = effective.filter((r, k) => k >= next && r.applyAt <= now)
    if (due.length) {
      const latest = due.at(-1)!
      next = effective.indexOf(latest) + 1
      runtime.request(latest.feel, latest.urgent)
      pending = runtime.playingFeel === latest.feel ? null : { atSec: latest.atSec, feel: latest.feel }
    }
    const step = runtime.advance()
    steps.push(step)
    if (step.join) joins.push({ ...step.join, atSec: now })
    if (pending && runtime.playingFeel === pending.feel) {
      latencies.push({ feel: pending.feel, sec: now - pending.atSec })
      pending = null
    }
  }
  return { steps, requests, joins, latencies }
}

export type ZoneReadiness = {
  zone: number
  feel: ZoneFeel
  startSec: number
  endSec: number
  /** Seconds of this zone heard before it jumps back, or null when it has no good hold. */
  holdAfterSec: number | null
  /** Whether that hold is one a listener approved. */
  holdHeard: boolean
  /** Exits with a good jump into the other feel, and how many of those a listener approved. */
  switchExits: number
  heardSwitchExits: number
  /** Worst-case wait for a good switch while in this zone, ignoring the release delay. */
  longestSwitchWaitSec: number | null
}

/** Static checks an agent can act on before listening: can every zone hold, and how fast can it switch? */
export function packReadiness(pack: Pack): ZoneReadiness[] {
  const runtime = new PackRuntime(pack)
  return pack.zones.map((zone, index) => {
    const other = zone.feel === 'combat' ? 'exploration' : 'combat'
    const hold = runtime.holdExitOf(index)
    const lastHeard = hold ?? zone.endSec
    const exits: number[] = []
    let heardSwitchExits = 0
    for (const exit of runtime.exitsIn(index).filter(e => e <= lastHeard + 1e-4)) {
      const good = runtime.goodJumps(exit, other, 'switch')
      if (feelAt(pack.zones, exit) === other || good.length) exits.push(exit)
      if (good.some(c => c.jump.source === 'listener')) heardSwitchExits++
    }
    // Playing wraps from the hold exit back into the zone, so waits can span the wrap.
    let longest: number | null = null
    if (exits.length) {
      longest = 0
      for (let i = 0; i < exits.length; i++) {
        const gap = i + 1 < exits.length ? exits[i + 1]! - exits[i]! : lastHeard - exits[i]! + exits[0]! - zone.startSec
        longest = Math.max(longest, gap)
      }
    }
    const holdHeard = hold !== undefined && runtime.goodJumps(hold, zone.feel, 'hold').some(c => c.jump.source === 'listener')
    return { zone: index, feel: zone.feel, startSec: zone.startSec, endSec: zone.endSec,
      holdAfterSec: hold === undefined ? null : hold - zone.startSec, holdHeard,
      switchExits: exits.length, heardSwitchExits, longestSwitchWaitSec: longest }
  })
}

export type SimulationSummary = {
  minutes: number
  requests: number
  /** Request to audible change, per destination feel. Exploration includes the release delay. */
  latencySec: Record<ZoneFeel, { median: number; max: number }>
  joins: Record<PackJoin['kind'], number>
  /** Planned joins that a listener had already approved. */
  heardJoins: number
  lowestPlannedP: number
  /** Share of each feel's source beats heard at least once. */
  coverage: Record<ZoneFeel, number>
  /** Longest stretch with no beat heard twice within it, in seconds. */
  longestFreshSec: number
  /** Each unbroken stretch of one feel: how long it lasted and how long before it repeated its own material. */
  periods: { feel: ZoneFeel; lengthSec: number; freshSec: number }[]
}

export function summarizeSimulation(pack: Pack, sim: Simulation): SimulationSummary {
  const latencySec = Object.fromEntries((['exploration', 'combat'] as const).map(feel => {
    const sorted = sim.latencies.filter(l => l.feel === feel).map(l => l.sec).sort((a, b) => a - b)
    return [feel, { median: sorted[Math.floor(sorted.length / 2)] ?? 0, max: sorted.at(-1) ?? 0 }]
  })) as SimulationSummary['latencySec']
  const joins = { 'natural-switch': 0, switch: 0, hold: 0, fallback: 0, 'lead-in': 0, 'hit-cut': 0 }
  for (const join of sim.joins) joins[join.kind]++
  const beatSec = 60 / pack.bpm
  // Beats heard in order, by grid index of the beat each played second falls in.
  const heardBeats: number[] = []
  const heardFeels: (ZoneFeel | null)[] = []
  const beatOf = (t: number) => Math.floor((t - pack.beatsSec[0]!) / beatSec + 1e-6)
  for (const step of sim.steps) {
    // Off-grid joins split beats into partial steps; a beat continued across steps counts once.
    for (let b = beatOf(step.startSec); b <= beatOf(step.endSec - 1e-4); b++) {
      if (heardBeats.at(-1) === b) continue
      heardBeats.push(b)
      heardFeels.push(feelAt(pack.zones, Math.max(step.startSec, pack.beatsSec[0]! + b * beatSec)))
    }
  }
  const periods: SimulationSummary['periods'] = []
  for (let i = 0; i < heardBeats.length;) {
    const feel = heardFeels[i]
    let j = i
    while (j < heardBeats.length && heardFeels[j] === feel) j++
    const seenInPeriod = new Set<number>()
    let fresh = i
    while (fresh < j && !seenInPeriod.has(heardBeats[fresh]!)) seenInPeriod.add(heardBeats[fresh++]!)
    if (feel) periods.push({ feel, lengthSec: (j - i) * beatSec, freshSec: (fresh - i) * beatSec })
    i = j
  }
  const heard = new Set(heardBeats)
  const coverage = Object.fromEntries((['exploration', 'combat'] as const).map(feel => {
    const beats = pack.beatsSec.flatMap((t, beat) => feelAt(pack.zones, t) === feel ? [beat] : [])
    return [feel, beats.length ? beats.filter(b => heard.has(b)).length / beats.length : 0]
  })) as Record<ZoneFeel, number>
  let longest = 0
  let start = 0
  const seen = new Map<number, number>()
  heardBeats.forEach((beat, i) => {
    const previous = seen.get(beat)
    if (previous !== undefined && previous >= start) start = previous + 1
    seen.set(beat, i)
    longest = Math.max(longest, i - start + 1)
  })
  const planned = sim.joins.filter(j => j.kind === 'switch' || j.kind === 'hold')
  return {
    minutes: sim.steps.reduce((sum, s) => sum + s.endSec - s.startSec, 0) / 60,
    requests: sim.requests.length,
    latencySec,
    joins,
    heardJoins: planned.filter(j => j.source === 'listener').length,
    lowestPlannedP: planned.length ? Math.min(...planned.map(j => j.p)) : 1,
    coverage,
    longestFreshSec: longest * beatSec,
    periods,
  }
}
