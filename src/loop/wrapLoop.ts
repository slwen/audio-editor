/** Equal-power mix of the tail onto the head. Output length is unchanged. */
export function bakeWrapEqualPower(channel: Float32Array, fadeSamples: number): void {
  const n = channel.length
  const fade = Math.max(0, Math.min(fadeSamples, Math.floor(n / 4)))
  if (fade < 2) return
  for (let i = 0; i < fade; i++) {
    const t = i / (fade - 1)
    const fadeIn = Math.sin((t * Math.PI) / 2)
    const fadeOut = Math.cos((t * Math.PI) / 2)
    const head = channel[i] ?? 0
    const tail = channel[n - fade + i] ?? 0
    channel[i] = head * fadeIn + tail * fadeOut
  }
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
  const a = Math.max(0, Math.floor(startSec * sr))
  const b = Math.min(buffer.length, Math.max(a + 1, Math.floor(endSec * sr)))
  const len = b - a
  const channels: Float32Array[] = []
  const nch = buffer.numberOfChannels
  for (let c = 0; c < nch; c++) {
    const src = buffer.getChannelData(c)
    channels.push(src.slice(a, a + len))
  }
  return { channels, sampleRate: sr }
}
