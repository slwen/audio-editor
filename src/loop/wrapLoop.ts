/**
 * Blend the source continuation AFTER the end into the loop head. Replaying
 * the previous tail here repeats time and creates a new jump at the wrap.
 * Complementary raised-cosine gains preserve correlated audio without +3dB.
 */
export function bakeWrapCrossfade(
  channel: Float32Array, fadeSamples: number, continuation?: Float32Array
): void {
  const n = channel.length
  const fade = Math.max(0, Math.min(Math.floor(fadeSamples), Math.floor(n / 4)))
  if (fade < 2) return
  const last = channel[n - 1] ?? 0
  for (let i = 0; i < fade; i++) {
    const mix = 0.5 - 0.5 * Math.cos(Math.PI * i / (fade - 1))
    // At EOF use a short decaying endpoint correction rather than silence or
    // a duplicate tail. It leaves the body and the exact bar duration intact.
    const from = continuation && continuation.length >= fade
      ? continuation[i]!
      : last
    channel[i] = from * (1 - mix) + channel[i]! * mix
  }
}

export type LoopRenderOptions = { wrapCrossfadeSec: number; normalize: boolean }

/** Long musical blends need real continuation; EOF only permits click repair. */
export function effectiveLoopCrossfadeSec(
  buffer: AudioBuffer, startSec: number, endSec: number, requestedSec: number
): number {
  const start = Math.max(0, Math.round(startSec * buffer.sampleRate))
  const end = Math.min(buffer.length, Math.round(endSec * buffer.sampleRate))
  const remaining = buffer.length - end
  const repair = Math.max(2, Math.round(0.005 * buffer.sampleRate))
  const available = remaining >= repair ? remaining : repair
  const requested = Number.isFinite(requestedSec) ? Math.max(0, Math.round(requestedSec * buffer.sampleRate)) : 0
  const count = Math.max(0, Math.min(requested, available, Math.floor((end - start) / 4)))
  return (count >= 2 ? count : 0) / buffer.sampleRate
}

/** Shared by preview, exported WAVs and clips copied into the editor. */
export function renderLoopChannels(
  buffer: AudioBuffer, startSec: number, endSec: number, opts: LoopRenderOptions
): { channels: Float32Array[]; sampleRate: number; wrapCrossfadeSec: number } {
  const result = sliceBufferChannels(buffer, startSec, endSec)
  const end = Math.min(buffer.length, Math.round(endSec * buffer.sampleRate))
  const wrapCrossfadeSec = effectiveLoopCrossfadeSec(buffer, startSec, endSec, opts.wrapCrossfadeSec)
  const fade = Math.round(wrapCrossfadeSec * buffer.sampleRate)
  const hasContinuation = buffer.length - end >= Math.max(2, Math.round(0.005 * buffer.sampleRate))
  result.channels.forEach((channel, index) => {
    bakeWrapCrossfade(channel, fade, hasContinuation ? buffer.getChannelData(index).subarray(end, end + fade) : undefined)
  })
  if (opts.normalize) peakNormalize(result.channels)
  return { ...result, wrapCrossfadeSec }
}

export function peakNormalize(channels: Float32Array[], peak = 0.89): void {
  let max = 0
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) max = Math.max(max, Math.abs(ch[i] ?? 0))
  }
  if (max < 1e-8) return
  const g = peak / max
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) ch[i] = (ch[i] ?? 0) * g
  }
}

export function sliceBufferChannels(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number
): { channels: Float32Array[]; sampleRate: number } {
  const sr = buffer.sampleRate
  const a = Math.max(0, Math.round(startSec * sr))
  const b = Math.min(buffer.length, Math.max(a + 1, Math.round(endSec * sr)))
  const len = b - a
  const channels: Float32Array[] = []
  const nch = buffer.numberOfChannels
  for (let c = 0; c < nch; c++) {
    const src = buffer.getChannelData(c)
    channels.push(src.slice(a, a + len))
  }
  return { channels, sampleRate: sr }
}
