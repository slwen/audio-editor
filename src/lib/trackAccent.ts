import type { Clip } from '@/types'

/** Chasm palette brights (neutrals excluded): waveforms + clip chrome accents */
export const TRACK_ACCENT_HEXES = [
  '#85daeb',
  '#5fc9e7',
  '#5fa1e7',
  '#5f6ee7',
  '#ab58a8',
  '#ca60ae',
  '#ff5dcc',
  '#f3a787',
  '#fdfe89',
  '#8dd894',
  '#5dc190',
  '#4ab9a3',
  '#4593a5',
  '#5efdf7',
] as const

const TRACK_ACCENT_SET: ReadonlySet<string> = new Set(TRACK_ACCENT_HEXES)

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

/** Persisted accents from an older palette are remapped onto the current one. */
export function clipAccentHex(clip: Clip): string {
  const saved = clip.accentColor?.toLowerCase()
  return saved && TRACK_ACCENT_SET.has(saved) ? saved : stableAccentForClipId(clip.id)
}
