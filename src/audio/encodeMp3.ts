import { Mp3Encoder } from '@breezystack/lamejs'

const FRAME = 1152
const DEFAULT_BITRATE_KBPS = 128

function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0))
    out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)))
  }
  return out
}

/** Stereo or mono MP3 from an AudioBuffer (typically 48 kHz / 128 kbps). */
export function encodeMp3(buffer: AudioBuffer, bitrateKbps = DEFAULT_BITRATE_KBPS): Blob {
  const channels = Math.min(2, Math.max(1, buffer.numberOfChannels))
  const encoder = new Mp3Encoder(channels, buffer.sampleRate, bitrateKbps)
  const left = floatToPcm16(buffer.getChannelData(0))
  const right = channels > 1 ? floatToPcm16(buffer.getChannelData(1)) : undefined
  const parts: BlobPart[] = []
  for (let i = 0; i < left.length; i += FRAME) {
    const end = Math.min(i + FRAME, left.length)
    const l = new Int16Array(left.subarray(i, end))
    const encoded =
      channels === 1 || !right ? encoder.encodeBuffer(l) : encoder.encodeBuffer(l, new Int16Array(right.subarray(i, end)))
    if (encoded.length > 0) parts.push(copyBytes(encoded))
  }
  const tail = encoder.flush()
  if (tail.length > 0) parts.push(copyBytes(tail))
  return new Blob(parts, { type: 'audio/mpeg' })
}

function copyBytes(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(src.length)
  out.set(src)
  return out
}
