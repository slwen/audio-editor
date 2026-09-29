import { yieldToMain } from '@/lib/yieldToMain'

/** Fuse trimming, downmix and decimation; never copy full stereo trim arrays. */
export async function prepareAnalysis(
  buffer: AudioBuffer, trimStart = 0, trimEnd = buffer.duration, signal?: AbortSignal
): Promise<{ samples: Float32Array<ArrayBuffer>; sampleRate: number }> {
  const a = Math.max(0, Math.floor(trimStart * buffer.sampleRate))
  const b = Math.min(buffer.length, Math.max(a + 1, Math.floor(trimEnd * buffer.sampleRate)))
  const factor = buffer.sampleRate >= 40000 ? 2 : 1
  const samples = new Float32Array(Math.floor(Math.max(0, b - a) / factor))
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  const inv = 1 / channels.length
  for (let start = 0; start < samples.length; start += 65536) {
    signal?.throwIfAborted()
    const end = Math.min(samples.length, start + 65536)
    for (let i = start; i < end; i++) {
      let sum = 0
      const index = a + i * factor
      for (const channel of channels) sum += channel[index] ?? 0
      samples[i] = sum * inv
    }
    await yieldToMain()
  }
  signal?.throwIfAborted()
  return { samples, sampleRate: buffer.sampleRate / factor }
}
