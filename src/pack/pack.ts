import { songZones, type SongZone, type ZoneFeel, type ZoneFlag } from '@/adaptive/zonePlan'
import type { SongMap } from './songMap'
import { feelAt, PACK_VERSION, type Pack, type PackJump, type PackPolicy, type PackZone } from './packFormat'

export { feelAt, PACK_VERSION } from './packFormat'
export type { Pack, PackFeel, PackJump, PackJumpKind, PackPolicy, PackZone } from './packFormat'

export const DEFAULT_PACK_POLICY: PackPolicy = {
  // Simulator ratings: model joins above 0.7 were no more often Good than those at 0.6-0.7.
  minP: 0.6,
  switchWaitBeats: 8,
  switchGiveUpBeats: 16,
  blendSec: 1,
  cutFadeSec: 0.035,
  minHoldBeats: 16,
  minRunwayBeats: 16,
  avoidZoneEndBeats: 8,
  recencyBeats: 256,
  releaseSec: 3,
  leadInBeats: 4,
  leadInFadeSec: 0.5,
  /** Long enough that combat material eases in; short enough the entrance hit still lands. */
  hitCutFadeSec: 0.28,
  directWaitBeats: 2,
  hitCutAfterBeats: 4,
}

/** P(Good) given to joins a listener heard and rated Good. */
export const LISTENER_P = 0.95
/** Hit cuts are not something the join model can score; this only orders them until they are rated. */
export const HIT_CUT_P = 0.5

/** Joins a listener has already judged in any tool, as exact source times. */
export type ListenerJoins = {
  good: { exitSec: number; entrySec: number; fadeSec: number }[]
  bad: { exitSec: number; entrySec: number }[]
}

const JUMPS_PER_EXIT_AND_FEEL = 6
/** Keep weaker jumps too, so give-up fallbacks still have a least-bad option. */
const KEEP_FLOOR_P = 0.3
const SAME_TIME_SEC = 0.002

/** Louder, busier stretches read as combat. Only a stand-in until a listener marks the song. */
export function inferZones(map: SongMap): SongZone[] {
  const bars = map.bars
  if (!bars.length) return []
  const z = (xs: number[]) => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length
    const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length) || 1
    return xs.map(x => (x - mean) / std)
  }
  const loud = z(bars.map(b => b.loudnessDb))
  const busy = z(bars.map(b => b.density))
  const energy = bars.map((_, i) => {
    const window = bars.slice(Math.max(0, i - 2), i + 3).map((_, k) => loud[Math.max(0, i - 2) + k]! + busy[Math.max(0, i - 2) + k]!)
    return window.reduce((a, b) => a + b, 0) / window.length
  })
  const sorted = [...energy].sort((a, b) => a - b)
  const threshold = sorted[Math.floor(sorted.length / 2)]!
  const feels: ZoneFeel[] = energy.map(e => e > threshold ? 'combat' : 'exploration')
  // Merge runs shorter than eight bars into their neighbour.
  for (let pass = 0; pass < 3; pass++) {
    let start = 0
    for (let i = 1; i <= feels.length; i++) {
      if (i < feels.length && feels[i] === feels[start]) continue
      if (i - start < 8) {
        const neighbour = start > 0 ? feels[start - 1]! : feels[i] ?? feels[start]!
        for (let k = start; k < i; k++) feels[k] = neighbour
      }
      start = i
    }
  }
  const zones: SongZone[] = []
  for (let i = 0; i < bars.length; i++) {
    const last = zones.at(-1)
    if (last && last.state === feels[i]) last.endSec = bars[i]!.endSec
    else zones.push({ startSec: i === 0 ? 0 : bars[i]!.startSec, endSec: bars[i]!.endSec, state: feels[i]! })
  }
  zones.at(-1)!.endSec = map.durationSec
  return zones
}

/**
 * Every combat entrance, reachable from every non-combat beat by a hit cut, and by a lead-in from
 * beats a whole number of bars before its build (so the build lands on the song's own downbeat).
 */
function combatStingers(map: SongMap, zones: PackZone[], policy: PackPolicy,
  isBad: (exitSec: number, entrySec: number) => boolean): { jumps: PackJump[]; blocked: number } {
  const beatOf = new Map(map.beatsSec.map((t, i) => [t, i]))
  const pBlended = new Map(map.jumps.map(j => [`${j.exitBeat}|${j.entryBeat}`, j.pGoodBlended]))
  const jumps: PackJump[] = []
  let blocked = 0
  for (const zone of zones) {
    if (zone.feel !== 'combat') continue
    const entranceBeat = beatOf.get(zone.startSec)
    if (entranceBeat === undefined) continue
    const leadInBeat = entranceBeat - policy.leadInBeats
    for (let exitBeat = 1; exitBeat <= map.beatsSec.length; exitBeat++) {
      const exitSec = map.beatsSec[exitBeat] ?? map.durationSec
      if (feelAt(zones, exitSec - 1e-3) === 'combat') continue
      const add = (jump: PackJump) => { if (isBad(jump.exitSec, jump.entrySec)) blocked++; else jumps.push(jump) }
      add({ kind: 'hit-cut', exitSec, entrySec: zone.startSec, entranceSec: zone.startSec, pCut: HIT_CUT_P, pBlended: HIT_CUT_P,
        source: 'model', fadeSec: policy.hitCutFadeSec })
      const inBuild = exitBeat >= leadInBeat && exitBeat <= entranceBeat
      if (leadInBeat > 0 && !inBuild && (exitBeat - leadInBeat) % 4 === 0) {
        const p = pBlended.get(`${exitBeat}|${leadInBeat}`) ?? HIT_CUT_P
        add({ kind: 'lead-in', exitSec, entrySec: map.beatsSec[leadInBeat]!, entranceSec: zone.startSec, pCut: p, pBlended: p,
          source: 'model', fadeSec: policy.leadInFadeSec })
      }
    }
  }
  return { jumps, blocked }
}

export type PackZonesInput = { flags: ZoneFlag[]; trimStartSec: number; trimEndSec: number } | null

export function buildPack(sourceName: string, map: SongMap, zonesInput: PackZonesInput,
  listener: ListenerJoins = { good: [], bad: [] }, policy: PackPolicy = DEFAULT_PACK_POLICY): Pack {
  const songZoneList = zonesInput ? songZones(zonesInput.trimStartSec, zonesInput.trimEndSec, zonesInput.flags) : inferZones(map)
  // Zones start and end on the beat grid, so every model exit at a zone edge is a real decision point.
  const snap = (sec: number) => map.beatsSec.reduce((best, t) => Math.abs(t - sec) < Math.abs(best - sec) ? t : best, map.beatsSec[0]!)
  const zones: PackZone[] = []
  songZoneList.forEach((z, i) => {
    const zone = { feel: z.state, startSec: i === 0 ? z.startSec : snap(z.startSec),
      endSec: i === songZoneList.length - 1 ? Math.min(z.endSec, map.durationSec) : snap(z.endSec) }
    if (zone.endSec - zone.startSec <= 0.1) return
    // A repeated marker of the same feel does not end the zone; the song simply plays on.
    const last = zones.at(-1)
    if (last && last.feel === zone.feel && Math.abs(last.endSec - zone.startSec) < 1e-6) last.endSec = zone.endSec
    else zones.push(zone)
  })
  const beatSec = 60 / map.bpm
  const same = (a: number, b: number) => Math.abs(a - b) < SAME_TIME_SEC
  const isBad = (exitSec: number, entrySec: number) => listener.bad.some(b => same(b.exitSec, exitSec) && same(b.entrySec, entrySec))
  const isGood = (exitSec: number, entrySec: number) => listener.good.some(g => same(g.exitSec, exitSec) && same(g.entrySec, entrySec))

  const jumps: PackJump[] = []
  let blockedJumps = 0
  const byExit = new Map<number, SongMap['jumps']>()
  for (const jump of map.jumps) byExit.set(jump.exitBeat, [...byExit.get(jump.exitBeat) ?? [], jump])
  for (const options of byExit.values()) {
    for (const feel of ['exploration', 'combat'] as const) {
      const kept = options.flatMap(j => {
        const exitSec = map.beatsSec[j.exitBeat] ?? map.durationSec
        const entrySec = map.beatsSec[j.entryBeat]!
        if (feelAt(zones, entrySec) !== feel || Math.max(j.pGoodCut, j.pGoodBlended) < KEEP_FLOOR_P) return []
        if (feelAt(zones, exitSec - beatSec / 2) === feel && Math.abs(exitSec - entrySec) < policy.minHoldBeats * beatSec) return []
        if (isBad(exitSec, entrySec)) { blockedJumps++; return [] }
        if (isGood(exitSec, entrySec)) return []
        return [{ exitSec, entrySec, pCut: j.pGoodCut, pBlended: j.pGoodBlended, source: 'model' as const }]
      })
      jumps.push(...kept.sort((a, b) => b.pBlended - a.pBlended || b.pCut - a.pCut).slice(0, JUMPS_PER_EXIT_AND_FEEL))
    }
  }
  for (const g of listener.good) {
    const to = feelAt(zones, g.entrySec)
    const from = feelAt(zones, g.exitSec - 0.05)
    if (!to || !from) continue
    // A heard hold must still be phrase-length; short Good motifs would stutter when repeated.
    if (from === to && Math.abs(g.exitSec - g.entrySec) < (policy.minHoldBeats - 0.5) * beatSec) continue
    jumps.push({ exitSec: g.exitSec, entrySec: g.entrySec, pCut: LISTENER_P, pBlended: LISTENER_P, source: 'listener',
      fadeSec: g.fadeSec })
  }
  const stingers = combatStingers(map, zones, policy, isBad)
  blockedJumps += stingers.blocked
  jumps.push(...stingers.jumps)
  return { version: PACK_VERSION, sourceName, bpm: map.bpm, durationSec: map.durationSec, beatsSec: map.beatsSec,
    zones, zoneSource: zonesInput ? 'listener' : 'inferred', jumpModel: map.jumpModel, policy, blockedJumps,
    jumps: jumps.sort((a, b) => a.exitSec - b.exitSec || a.entrySec - b.entrySec) }
}
