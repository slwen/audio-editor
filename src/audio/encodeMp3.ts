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

/** Used in the export worker. Chunks end on MPEG frame boundaries. */
export function createMp3Encoder(channels: number, sampleRate: number, bitrateKbps = DEFAULT_BITRATE_KBPS) {
  const encoder = new Mp3Encoder(channels, sampleRate, bitrateKbps)
  const parts: BlobPart[] = []
  return {
    append(leftSamples: Float32Array, rightSamples?: Float32Array): void {
      const left = floatToPcm16(leftSamples)
      const right = rightSamples ? floatToPcm16(rightSamples) : undefined
      for (let i = 0; i < left.length; i += FRAME) {
        const end = Math.min(i + FRAME, left.length)
        const l = left.subarray(i, end)
        const encoded = channels === 1 || !right
          ? encoder.encodeBuffer(l) : encoder.encodeBuffer(l, right.subarray(i, end))
        if (encoded.length > 0) parts.push(copyBytes(encoded))
      }
    },
    finish(): Blob {
      const tail = encoder.flush()
      if (tail.length > 0) parts.push(copyBytes(tail))
      return new Blob(parts, { type: 'audio/mpeg' })
    },
  }
}

/** Synchronous codec entry for tests; the app invokes it in a worker. */
export function encodeMp3(buffer: AudioBuffer, bitrateKbps = DEFAULT_BITRATE_KBPS): Blob {
  const channels = Math.min(2, Math.max(1, buffer.numberOfChannels))
  const encoder = createMp3Encoder(channels, buffer.sampleRate, bitrateKbps)
  encoder.append(buffer.getChannelData(0), channels > 1 ? buffer.getChannelData(1) : undefined)
  return encoder.finish()
}

function copyBytes(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(src.length)
  out.set(src)
  return out
}
