import { yieldToMain } from '@/lib/yieldToMain'

/** Max/min peaks per bucket for waveform drawing */
function fillPeaks(
  left: Float32Array,
  right: Float32Array,
  out: Float32Array,
  first = 0,
  last = out.length / 2,
): void {
  const bucketCount = out.length / 2
  const length = Math.min(left.length, right.length)
  const samplesPerBucket = length / bucketCount
  for (let b = first; b < last; b++) {
    const start = Math.floor(b * samplesPerBucket)
    const end = Math.min(length, Math.floor((b + 1) * samplesPerBucket))
    let min = 0
    let max = 0
    for (let i = start; i < end; i++) {
      // Match the old Float32 downmix without allocating a full-song temporary.
      const v = Math.fround(0.5 * ((left[i] ?? 0) + (right[i] ?? 0)))
      if (v < min) min = v
      if (v > max) max = v
    }
    out[b * 2] = min
    out[b * 2 + 1] = max
  }
}

export function peaksForBuffer(buffer: AudioBuffer, maxBuckets = 4000): Float32Array {
  const ch0 = buffer.getChannelData(0)
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0
  const n = Math.min(ch0.length, ch1.length)
  const buckets = Math.max(1, Math.min(maxBuckets, Math.ceil(n / 256)))
  const out = new Float32Array(buckets * 2)
  fillPeaks(ch0, ch1, out)
  return out
}

export async function peaksForBufferAsync(buffer: AudioBuffer, maxBuckets = 4000, signal?: AbortSignal): Promise<Float32Array> {
  const left = buffer.getChannelData(0)
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left
  const buckets = Math.max(1, Math.min(maxBuckets, Math.ceil(Math.min(left.length, right.length) / 256)))
  const out = new Float32Array(buckets * 2)
  // Bound samples per batch too, including very long songs.
  const batch = Math.max(1, Math.min(64, Math.floor(262144 / Math.max(1, left.length / buckets))))
  for (let b = 0; b < buckets; b += batch) {
    signal?.throwIfAborted()
    fillPeaks(left, right, out, b, Math.min(buckets, b + batch))
    await yieldToMain()
  }
  signal?.throwIfAborted()
  return out
}
