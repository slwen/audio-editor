/**
 * How the game plays a song: from 0 until `endSec`, then back to `startSec`, crossfaded over `fadeSec`
 * centred on the wrap. The editor preview uses this so what you hear is what ships.
 */

export type SongLoop = { startSec: number; endSec: number; fadeSec: number }

/** Crossfades at least this long are real blends between different material. */
const EQUAL_POWER_MIN_SEC = 0.3

/**
 * Equal-power for real blends; linear for short click repairs, where both sides are nearly the same signal.
 * `x` runs 0..1 across the fade.
 */
export function fadeGain(x: number, fadeSec: number, rising: boolean): number {
  const t = Math.max(0, Math.min(1, x))
  const u = rising ? t : 1 - t
  return fadeSec >= EQUAL_POWER_MIN_SEC ? Math.sin(u * Math.PI / 2) : u
}

/** Sampled gain curve for Web Audio `setValueCurveAtTime`. */
export function fadeCurve(fadeSec: number, rising: boolean, points = 128): Float32Array {
  const out = new Float32Array(points)
  for (let i = 0; i < points; i++) out[i] = fadeGain(i / (points - 1), fadeSec, rising)
  return out
}

export type BlendChoice = 'click' | 'half-beat' | 'beat' | 'bar' | 'second'

export const BLEND_CHOICES: { id: BlendChoice; label: string }[] = [
  { id: 'click', label: 'Tiny (35 ms)' },
  { id: 'half-beat', label: '½ beat' },
  { id: 'beat', label: '1 beat' },
  { id: 'bar', label: '1 bar' },
  { id: 'second', label: '1 second' },
]

export function blendSec(choice: BlendChoice, bpm: number): number {
  const beat = 60 / bpm
  switch (choice) {
    case 'click': return 0.035
    case 'half-beat': return beat / 2
    case 'beat': return beat
    case 'bar': return beat * 4
    case 'second': return 1
    default: {
      const unexpected: never = choice
      throw new Error(`Unknown blend ${String(unexpected)}`)
    }
  }
}

/** The loop can never fade longer than itself, and the fade must fit before the song ends. */
export function clampFade(loop: SongLoop, durationSec: number): number {
  const room = Math.min(loop.endSec - loop.startSec, 2 * loop.startSec, 2 * (durationSec - loop.endSec))
  return Math.max(0, Math.min(loop.fadeSec, room))
}

/** Source position heard at output time `t` (ignoring the crossfade overlap), for the playhead. */
export function sourceTimeAt(loop: SongLoop, t: number): number {
  const period = loop.endSec - loop.startSec
  if (t < loop.endSec || period <= 0) return t
  return loop.startSec + ((t - loop.endSec) % period)
}
