import type { Clip } from '@/types'

/** Bright palette: waveforms + clip chrome accents */
export const TRACK_ACCENT_HEXES = [
  '#5d275d',
  '#b13e53',
  '#ef7d57',
  '#ffcd75',
  '#a7f070',
  '#38b764',
  '#257179',
  '#29366f',
  '#3b5dc9',
  '#41a6f6',
  '#73eff7',
] as const

export function pickRandomTrackAccent(): string {
  return TRACK_ACCENT_HEXES[Math.floor(Math.random() * TRACK_ACCENT_HEXES.length)]!
}

/** Two different palette entries (for split clips, etc.). */
export function pickTwoDistinctTrackAccents(): [string, string] {
  const a = pickRandomTrackAccent()
  let b = pickRandomTrackAccent()
  let guard = 0
  while (b === a && guard++ < 32) b = pickRandomTrackAccent()
  return [a, b]
}

/** Random accent, avoiding a specific hex when the palette allows. */
export function pickRandomAccentAvoiding(avoid?: string): string {
  if (TRACK_ACCENT_HEXES.length < 2 || !avoid) return pickRandomTrackAccent()
  let v = pickRandomTrackAccent()
  let guard = 0
  while (v === avoid && guard++ < 32) v = pickRandomTrackAccent()
  return v
}

/** Deterministic fallback for clips without persisted accent (older projects). */
export function stableAccentForClipId(id: string): string {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  }
  const idx = Math.abs(h) % TRACK_ACCENT_HEXES.length
  return TRACK_ACCENT_HEXES[idx]!
}

export function clipAccentHex(clip: Clip): string {
  return clip.accentColor ?? stableAccentForClipId(clip.id)
}
