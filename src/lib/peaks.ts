/** Max/min peaks per bucket for waveform drawing */
export function computePeaks(
  channelData: Float32Array,
  bucketCount: number
): Float32Array {
  const out = new Float32Array(bucketCount * 2)
  const samplesPerBucket = channelData.length / bucketCount
  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor(b * samplesPerBucket)
    const end = Math.min(channelData.length, Math.floor((b + 1) * samplesPerBucket))
    let min = 0
    let max = 0
    for (let i = start; i < end; i++) {
      const v = channelData[i] ?? 0
      if (v < min) min = v
      if (v > max) max = v
    }
    out[b * 2] = min
    out[b * 2 + 1] = max
  }
  return out
}

export function peaksForBuffer(buffer: AudioBuffer, maxBuckets = 4000): Float32Array {
  const ch0 = buffer.getChannelData(0)
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0
  const n = Math.min(ch0.length, ch1.length)
  const merged = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    merged[i] = 0.5 * ((ch0[i] ?? 0) + (ch1[i] ?? 0))
  }
  const buckets = Math.max(1, Math.min(maxBuckets, Math.ceil(n / 256)))
  return computePeaks(merged, buckets)
}
