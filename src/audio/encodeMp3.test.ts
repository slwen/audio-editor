import { expect, it } from 'vitest'
import { createMp3Encoder, encodeMp3 } from './encodeMp3'
import { writeWavStereo16 } from './wavBytes'

function sineBuffer(seconds: number, sampleRate = 48000): AudioBuffer {
  const length = Math.round(seconds * sampleRate)
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const s = 0.4 * Math.sin((i / sampleRate) * 440 * Math.PI * 2)
    left[i] = s
    right[i] = s * 0.7
  }
  return {
    sampleRate,
    numberOfChannels: 2,
    length,
    getChannelData: (c: number) => (c === 0 ? left : right),
  } as AudioBuffer
}

it('encodes a stereo buffer as MPEG that is much smaller than WAV', async () => {
  const buffer = sineBuffer(1)
  const mp3 = encodeMp3(buffer)
  const wavBytes = writeWavStereo16(buffer)
  const mp3Bytes = new Uint8Array(await mp3.arrayBuffer())
  expect(mp3.type).toBe('audio/mpeg')
  expect(mp3Bytes[0]).toBe(0xff)
  expect((mp3Bytes[1] ?? 0) & 0xe0).toBe(0xe0)
  expect(mp3Bytes.byteLength).toBeLessThan(wavBytes.byteLength / 4)
})

it('produces identical MPEG bytes from bounded, frame-aligned stereo chunks', async () => {
  const buffer = sineBuffer(2)
  const stream = createMp3Encoder(2, buffer.sampleRate)
  const left = buffer.getChannelData(0)
  const right = buffer.getChannelData(1)
  for (let offset = 0; offset < buffer.length; offset += 1152 * 32) {
    stream.append(left.subarray(offset, offset + 1152 * 32), right.subarray(offset, offset + 1152 * 32))
  }
  expect(new Uint8Array(await stream.finish().arrayBuffer())).toEqual(new Uint8Array(await encodeMp3(buffer).arrayBuffer()))
})
