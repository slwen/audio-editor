/**
 * Pure checks for exporting a game song. Imported by the dev server too, so it must not use the `@/` alias.
 */

/** Anything quieter than this (−60 dBFS) after the last sound counts as silence. */
const SILENCE = 0.001
/** Kept after the last sound so reverb tails and the final decay are not cut. */
export const TAIL_SEC = 1

/**
 * Frames to keep so the file ends shortly after the song's last sound, never before the loop's crossfade is done.
 * `channels` are the summed stems.
 */
export function naturalEndFrames(channels: Float32Array[], sampleRate: number, mustKeepSec: number): number {
  const frames = channels[0]?.length ?? 0
  let last = -1
  for (let i = frames - 1; i >= 0 && last < 0; i--) {
    for (const ch of channels) if (Math.abs(ch[i]!) > SILENCE) { last = i; break }
  }
  const end = last + 1 + Math.round(TAIL_SEC * sampleRate)
  return Math.min(frames, Math.max(end, Math.ceil(mustKeepSec * sampleRate)))
}

/** Lag (seconds) that best aligns `encoded` to `original` around `atSec`, within ±60 ms. */
function offsetAt(original: Float32Array, encoded: Float32Array, sampleRate: number, atSec: number): number {
  const win = Math.round(0.5 * sampleRate)
  const maxLag = Math.round(0.06 * sampleRate)
  const start = Math.round(atSec * sampleRate)
  let best = 0
  let bestScore = -Infinity
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let dot = 0
    let energy = 0
    for (let i = 0; i < win; i += 2) {
      const a = original[start + i] ?? 0
      const b = encoded[start + i + lag] ?? 0
      dot += a * b
      energy += b * b
    }
    const score = dot / Math.sqrt(energy + 1e-12)
    if (score > bestScore) { bestScore = score; best = lag }
  }
  return best / sampleRate
}

/** Encoders may add a fixed delay; a delay that changes along the file would move the loop points apart. */
export const MAX_OFFSET_SPREAD_SEC = 0.001

export function encoderOffsets(original: Float32Array, encoded: Float32Array, sampleRate: number): number[] {
  const duration = original.length / sampleRate
  return [0.2, 0.4, 0.6, 0.8].map(f => offsetAt(original, encoded, sampleRate, duration * f))
}

export function offsetSpread(offsets: number[]): number {
  return Math.max(...offsets) - Math.min(...offsets)
}
