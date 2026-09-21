/** Stereo (or dual-mono) 16-bit PCM WAV. */
export function writeWavStereo16(floatBuffer: AudioBuffer): ArrayBuffer {
  const numCh = Math.min(2, floatBuffer.numberOfChannels)
  const n = floatBuffer.length
  const blockAlign = numCh * 2
  const byteRate = floatBuffer.sampleRate * blockAlign
  const dataSize = n * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const v = new DataView(buffer)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)!)
  }
  writeStr(0, 'RIFF')
  v.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, numCh, true)
  v.setUint32(24, floatBuffer.sampleRate, true)
  v.setUint32(28, byteRate, true)
  v.setUint16(32, blockAlign, true)
  v.setUint16(34, 16, true)
  writeStr(36, 'data')
  v.setUint32(40, dataSize, true)
  const ch0 = floatBuffer.getChannelData(0)
  const ch1 = numCh > 1 ? floatBuffer.getChannelData(1) : ch0
  let o = 44
  for (let i = 0; i < n; i++) {
    for (const ch of [ch0, ch1]) {
      const s = Math.max(-1, Math.min(1, ch[i] ?? 0))
      v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(s * 32767))), true)
      o += 2
    }
  }
  return buffer
}

export function audioBufferFromChannels(
  sampleRate: number,
  channels: Float32Array[]
): AudioBuffer {
  const ch0 = channels[0] ?? new Float32Array(1)
  const length = ch0.length
  const nch = Math.max(1, Math.min(2, channels.length))
  const ctx = new OfflineAudioContext(nch, Math.max(1, length), sampleRate)
  const buf = ctx.createBuffer(nch, Math.max(1, length), sampleRate)
  buf.getChannelData(0).set(ch0.subarray(0, buf.length))
  if (nch > 1) buf.getChannelData(1).set((channels[1] ?? ch0).subarray(0, buf.length))
  return buf
}
