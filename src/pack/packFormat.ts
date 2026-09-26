/**
 * The adaptive pack file format, shared by the editor and by games. This file, runtime.ts and
 * livePlayer.ts have no other dependencies so `npm run export-pack` can copy them into a game.
 */

export const PACK_VERSION = 'adaptive-pack-v2'

export type PackFeel = 'exploration' | 'combat'

export type PackPolicy = {
  /** Planned jumps must be at least this likely to be rated Good. */
  minP: number
  /** A feel change should be audible within this many beats of the request. */
  switchWaitBeats: number
  /** After this many beats the best available jump is taken even below minP. */
  switchGiveUpBeats: number
  /** Crossfade for feel changes and for holds that only pass as a blend. */
  blendSec: number
  /** Click repair for holds that pass as a cut. */
  cutFadeSec: number
  /** A hold must go back at least this far, so repeats are phrases, not stutters. */
  minHoldBeats: number
  /** An arrival must leave this much of its zone to play before the next decision. */
  minRunwayBeats: number
  /** Model holds avoid leaving from a zone's last beats, which usually build into the next section. */
  avoidZoneEndBeats: number
  /** Material heard within about this many beats is avoided when another good entry exists. */
  recencyBeats: number
  /** Game-side delay before Combat -> Exploration is requested. */
  releaseSec: number
  /** Length of the song's own build borrowed from just before a combat entrance. */
  leadInBeats: number
  /** Crossfade into a lead-in; short so its first beat stays crisp. */
  leadInFadeSec: number
  /** Crossfade of a hit cut: brief blend into the entrance so the cut is not a hard splice. */
  hitCutFadeSec: number
  /** A lead-in is skipped when a good direct switch is at most this many beats away. */
  directWaitBeats: number
  /** Unused by the runtime: only an urgent combat request hit-cuts. Kept so existing packs load. */
  hitCutAfterBeats: number
}

/**
 * `jump` moves between any two points. Stingers only enter combat: a `lead-in` jumps to the song's
 * own build before a combat entrance and plays into it; a `hit-cut` cuts straight to the entrance hit.
 */
export type PackJumpKind = 'jump' | 'lead-in' | 'hit-cut'

export type PackJump = {
  exitSec: number
  entrySec: number
  pCut: number
  pBlended: number
  /** Listener joins were heard and rated Good; they play exactly as rated, with their own crossfade. */
  source: 'model' | 'listener'
  fadeSec?: number
  /** Absent means 'jump'. */
  kind?: PackJumpKind
  /** For stingers: where combat itself starts. */
  entranceSec?: number
}

export type PackZone = { startSec: number; endSec: number; feel: PackFeel }

export type Pack = {
  version: typeof PACK_VERSION
  sourceName: string
  bpm: number
  durationSec: number
  /** Global-tempo grid: model jumps leave and arrive on these beats. */
  beatsSec: number[]
  zones: PackZone[]
  zoneSource: 'listener' | 'inferred'
  jumpModel: string
  policy: PackPolicy
  jumps: PackJump[]
  /** Model jumps removed because a listener rated them Bad. */
  blockedJumps: number
}

export function feelAt(zones: PackZone[], sec: number): PackFeel | null {
  return zones.find(z => sec >= z.startSec - 1e-6 && sec < z.endSec - 1e-6)?.feel ?? null
}
