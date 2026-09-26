import { feelAt, type Pack, type PackFeel, type PackJump } from './packFormat'

export type PackJoinKind =
  /** The song itself moves into the requested feel. */
  | 'natural-switch'
  /** A planned jump into the requested feel. */
  | 'switch'
  /** A planned jump back within the playing feel, so it lasts. */
  | 'hold'
  /** No planned jump was good enough in time; the least-bad option was taken. */
  | 'fallback'
  /** Into combat through the song's own build before a combat entrance. */
  | 'lead-in'
  /** Straight to a combat entrance's first hit. */
  | 'hit-cut'

export type PackJoin = {
  kind: PackJoinKind
  exitSec: number
  entrySec: number
  fadeSec: number
  /** Calibrated P(Good) for this join; 1 for the song's own continuation. */
  p: number
  source: PackJump['source'] | 'song'
  from: PackFeel | null
  to: PackFeel
  /** Seconds between the request reaching the runtime and this join, for switches. */
  waitedSec?: number
  /** For a lead-in: where combat itself starts, after the song's build. */
  entranceSec?: number
}

/** Play source audio from `startSec` to `endSec`; `join` describes how playback arrived at `startSec`. */
export type PackStep = { startSec: number; endSec: number; join?: PackJoin }

export type Candidate = { jump: PackJump; p: number; fadeSec: number; score: number }

const EPS = 1e-4
/** How far past an arrival to check for recently heard music. */
const RECENCY_LOOKAHEAD_BEATS = 16

/**
 * Plays the source in its own order. Decisions happen on the beat grid and at the exact exits of
 * listener-approved joins. A hold jumps back before the playing feel's material ends; a feel change
 * takes the earliest good jump into the other feel.
 */
export class PackRuntime {
  readonly pack: Pack
  readonly beatSec: number
  desired: PackFeel = 'exploration'
  /** Source position where the current step started, and where it ends (the next decision point). */
  pos = 0
  end = 0
  /** Output seconds elapsed at the end of the current step. */
  clock = 0
  /** Output clock when each grid beat was last heard. */
  private lastPlayed = new Map<number, number>()
  private requestedAt: number | null = null
  private urgent = false
  /** While a lead-in plays, no other decision interrupts it before this combat entrance. */
  private committedUntil: number | null = null
  private readonly points: number[]
  private readonly byExit = new Map<string, PackJump[]>()
  /** Per zone index: the decision point where that zone jumps back to keep its feel. */
  private readonly holdExit = new Map<number, number>()

  constructor(pack: Pack) {
    this.pack = pack
    this.beatSec = 60 / pack.bpm
    const key = (sec: number) => sec.toFixed(4)
    for (const jump of pack.jumps) this.byExit.set(key(jump.exitSec), [...this.byExit.get(key(jump.exitSec)) ?? [], jump])
    // Exact times, not the rounded keys: a zone edge must compare equal to the beat line it sits on.
    this.points = [...pack.beatsSec, ...pack.jumps.map(j => j.exitSec)].sort((a, b) => a - b)
      .filter((t, i, all) => i === 0 || t - all[i - 1]! > 1e-6)
    // Arrivals need somewhere to go next, which depends on where each zone's hold exit is. Two passes settle it.
    for (let pass = 0; pass < 2; pass++) pack.zones.forEach((_, index) => this.chooseHoldExit(index))
  }

  private jumpsAt(sec: number): PackJump[] { return this.byExit.get(sec.toFixed(4)) ?? [] }

  /**
   * Music a hold keeps in play: this zone up to the exit, plus what the arrival plays before its
   * own next hold. Late exits and early arrivals both lengthen the stretch between repeats.
   */
  private cycleSec(exitSec: number, entrySec: number): number {
    const zone = this.pack.zones[this.zoneIndexAt(exitSec - EPS)]!
    const sameZone = this.zoneIndexAt(entrySec) === this.zoneIndexAt(exitSec - EPS)
    return sameZone ? exitSec - Math.max(zone.startSec, Math.min(entrySec, exitSec))
      : exitSec - zone.startSec + Math.max(0, this.runway(entrySec))
  }

  /**
   * The hold that keeps the most music in play between repeats. Short approved loops are proven
   * joins but make short cycles, so model holds count at 75% of an approved one.
   * Model holds keep clear of the zone's last beats, which build into the next section.
   */
  private chooseHoldExit(index: number): void {
    const zone = this.pack.zones[index]!
    const avoidFrom = zone.endSec - this.pack.policy.avoidZoneEndBeats * this.beatSec - EPS
    let best: { exit: number; value: number } | undefined
    for (const exit of this.points.filter(p => p > zone.startSec + EPS && p <= zone.endSec + EPS)) {
      for (const c of this.candidates(exit, zone.feel, 'hold', true)) {
        const listener = c.jump.source === 'listener'
        if (!listener && exit > avoidFrom) continue
        const value = this.cycleSec(exit, c.jump.entrySec) * (listener ? 1 : 0.75)
        if (!best || value > best.value + EPS || (Math.abs(value - best.value) <= EPS && exit > best.exit)) best = { exit, value }
      }
    }
    // With nothing clear of the zone end, a hold there still beats drifting into the other feel.
    if (!best) {
      const exits = this.points.filter(p => p > zone.startSec + EPS && p <= zone.endSec + EPS).reverse()
      const exit = exits.find(e => this.candidates(e, zone.feel, 'hold', true).length)
      if (exit !== undefined) best = { exit, value: 0 }
    }
    if (best) this.holdExit.set(index, best.exit)
    else this.holdExit.delete(index)
  }

  zoneIndexAt(sec: number): number {
    return this.pack.zones.findIndex(z => sec >= z.startSec - 1e-6 && sec < z.endSec - 1e-6)
  }

  feelAt(sec: number): PackFeel | null { return feelAt(this.pack.zones, sec) }

  get playingFeel(): PackFeel | null { return this.feelAt(this.pos) }

  /** Where each zone decides to hold; undefined when no good hold exists. */
  holdExitOf(zoneIndex: number): number | undefined { return this.holdExit.get(zoneIndex) }

  /** Decision points (exits) inside a zone, in order. */
  exitsIn(zoneIndex: number): number[] {
    const zone = this.pack.zones[zoneIndex]!
    return this.points.filter(p => p > zone.startSec + EPS && p <= zone.endSec + EPS)
  }

  /** Planned (at or above minP) jumps from one exit that the runtime would consider, best first. */
  goodJumps(exitSec: number, feel: PackFeel, mode: 'hold' | 'switch'): Candidate[] {
    return this.candidates(exitSec, feel, mode, true)
  }

  private nextPoint(after: number): number {
    let lo = 0
    let hi = this.points.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.points[mid]! <= after + EPS) lo = mid + 1
      else hi = mid
    }
    return this.points[lo] ?? this.pack.durationSec
  }

  start(feel: PackFeel, sec?: number): PackStep {
    this.desired = feel
    this.pos = sec ?? this.pack.zones.find(z => z.feel === feel)?.startSec ?? 0
    this.end = this.nextPoint(this.pos)
    this.clock = this.end - this.pos
    this.lastPlayed = new Map()
    this.markHeard(this.pos, this.end)
    this.requestedAt = null
    this.urgent = false
    this.committedUntil = null
    return { startSec: this.pos, endSec: this.end }
  }

  /** `urgent` combat skips musical waiting and cuts to an entrance hit at the next beat. */
  request(feel: PackFeel, urgent = false): void {
    if (feel !== this.desired) this.committedUntil = null
    this.desired = feel
    this.urgent = urgent && feel === 'combat'
    this.requestedAt = this.playingFeel === feel ? null : this.requestedAt ?? this.clock
  }

  private beatOf(sec: number): number {
    return Math.floor((sec - (this.pack.beatsSec[0] ?? 0)) / this.beatSec + 1e-6)
  }

  private markHeard(startSec: number, endSec: number): void {
    for (let b = this.beatOf(startSec); b <= this.beatOf(endSec - EPS); b++) this.lastPlayed.set(b, this.clock)
  }

  /** 0 when the music after an arrival is fresh, near 1 when it was just heard. */
  private recencyAfter(entrySec: number): number {
    const first = this.beatOf(entrySec)
    let worst = 0
    for (let b = first; b < first + RECENCY_LOOKAHEAD_BEATS; b++) {
      const heard = this.lastPlayed.get(b)
      if (heard !== undefined) worst = Math.max(worst, Math.exp(-(this.clock - heard) / (this.pack.policy.recencyBeats * this.beatSec)))
    }
    return worst
  }

  /** Seconds of the arrival's zone left before it must decide again. */
  private runway(entrySec: number): number {
    const zone = this.zoneIndexAt(entrySec)
    if (zone < 0) return 0
    return (this.holdExit.get(zone) ?? this.pack.zones[zone]!.endSec) - entrySec
  }

  private candidates(exitSec: number, feel: PackFeel, mode: 'hold' | 'switch' | 'any', requireP: boolean): Candidate[] {
    const { policy, zones } = this.pack
    return this.jumpsAt(exitSec).flatMap(jump => {
      if ((jump.kind ?? 'jump') !== 'jump' || this.feelAt(jump.entrySec) !== feel) return []
      const zone = zones[this.zoneIndexAt(jump.entrySec)]!
      // Half a beat of slack: approved loops cut on a slightly different tempo are a hair short of whole bars.
      const runwayNeeded = Math.min(policy.minRunwayBeats * this.beatSec, zone.endSec - zone.startSec) - this.beatSec / 2
      if (this.runway(jump.entrySec) < runwayNeeded) return []
      const listener = jump.source === 'listener'
      const cut = listener ? (jump.fadeSec ?? 0) < 0.3 : mode === 'hold' && jump.pCut >= policy.minP
      const p = cut && !listener ? jump.pCut : jump.pBlended
      if (requireP && p < policy.minP) return []
      const recency = this.recencyAfter(jump.entrySec)
      const arrivesAtSection = mode !== 'hold' && jump.entrySec - zone.startSec < 4 * this.beatSec ? 0.05 : 0
      return [{ jump, p, fadeSec: jump.fadeSec ?? (cut ? policy.cutFadeSec : policy.blendSec),
        score: p - 0.35 * recency + arrivesAtSection }]
    }).sort((a, b) => b.score - a.score)
  }

  /** Stingers from this exit, preferring entrances whose combat was not heard recently. */
  private stingers(exitSec: number, kind: 'lead-in' | 'hit-cut'): Candidate[] {
    return this.jumpsAt(exitSec).filter(j => j.kind === kind).map(jump => ({ jump, p: jump.pBlended,
      fadeSec: jump.fadeSec ?? this.pack.policy.hitCutFadeSec,
      score: jump.pBlended - 0.35 * this.recencyAfter(jump.entranceSec ?? jump.entrySec) }))
      .sort((a, b) => b.score - a.score)
  }

  /** Whether a planned direct switch into `feel` is available within the next `beats`. */
  private directSwitchSoon(afterSec: number, feel: PackFeel, beats: number): boolean {
    for (let t = this.nextPoint(afterSec); t <= afterSec + beats * this.beatSec + EPS && t < this.pack.durationSec; t = this.nextPoint(t)) {
      if (this.feelAt(t) === feel || this.candidates(t, feel, 'switch', true).length) return true
    }
    return false
  }

  private join(kind: PackJoinKind, c: Candidate, from: PackFeel | null, to: PackFeel): PackJoin {
    return { kind, exitSec: c.jump.exitSec, entrySec: c.jump.entrySec, fadeSec: c.fadeSec, p: c.p, source: c.jump.source, from, to,
      ...(c.jump.entranceSec !== undefined ? { entranceSec: c.jump.entranceSec } : {}) }
  }

  /** Finish the playing step and choose the next one. */
  advance(): PackStep {
    const { policy, durationSec } = this.pack
    const exit = this.end
    const want = this.desired
    const playing = this.playingFeel
    const natural = exit < durationSec - EPS ? this.feelAt(exit) : null
    let join: PackJoin | undefined
    if (this.committedUntil !== null && exit < this.committedUntil - EPS) {
      // A lead-in is playing the song's own build; let it reach the entrance.
    } else if (playing !== want) {
      const waitedSec = this.clock - (this.requestedAt ?? this.clock)
      const waitedBeats = waitedSec / this.beatSec + EPS
      if (natural === want) {
        join = { kind: 'natural-switch', exitSec: exit, entrySec: exit, fadeSec: 0, p: 1, source: 'song', from: playing, to: want }
      } else {
        const planned = this.candidates(exit, want, 'switch', true)[0]
        const toCombat = want === 'combat'
        const hit = toCombat && !planned && this.urgent
          ? this.stingers(exit, 'hit-cut')[0] : undefined
        const leadIn = toCombat && !planned && !hit && !this.directSwitchSoon(exit, want, policy.directWaitBeats)
          ? this.stingers(exit, 'lead-in')[0] : undefined
        const forced = !planned && !hit && !leadIn && (waitedBeats >= policy.switchGiveUpBeats || natural === null)
          ? this.candidates(exit, want, 'any', false)[0] : undefined
        if (planned) join = this.join('switch', planned, playing, want)
        else if (hit) join = this.join('hit-cut', hit, playing, want)
        else if (leadIn) {
          join = this.join('lead-in', leadIn, playing, want)
          this.committedUntil = leadIn.jump.entranceSec ?? null
        } else if (forced) join = this.join('fallback', forced, playing, want)
      }
      if (join) join.waitedSec = waitedSec
    } else if (natural !== want) {
      // Recency only chooses among good holds; it must not push a good hold below a weaker one.
      const good = this.candidates(exit, want, 'hold', true)[0]
      const hold = good ?? this.candidates(exit, want, 'hold', false)[0]
      if (hold) join = this.join(good ? 'hold' : 'fallback', hold, playing, want)
    } else if (Math.abs((this.holdExit.get(this.zoneIndexAt(this.pos)) ?? -1) - exit) < EPS) {
      const hold = this.candidates(exit, want, 'hold', true)[0]
      if (hold) join = this.join('hold', hold, playing, want)
    }
    if (!join && natural === null) {
      const restart = this.pack.zones.find(z => z.feel === want) ?? this.pack.zones[0]!
      join = { kind: 'fallback', exitSec: exit, entrySec: restart.startSec, fadeSec: policy.blendSec, p: 0, source: 'song',
        from: playing, to: restart.feel }
    }
    this.pos = join && join.kind !== 'natural-switch' ? join.entrySec : exit
    this.end = this.nextPoint(this.pos)
    this.clock += this.end - this.pos
    this.markHeard(this.pos, this.end)
    if (this.playingFeel === this.desired) {
      this.requestedAt = null
      this.urgent = false
    }
    if (this.committedUntil !== null && this.pos >= this.committedUntil - EPS) this.committedUntil = null
    return { startSec: this.pos, endSec: this.end, ...(join ? { join } : {}) }
  }
}
