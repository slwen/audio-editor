import { describe, it, expect } from 'vitest'
import { bakeWrapCrossfade, renderLoopChannels } from './wrapLoop'
import { writeWavStereo16 } from '@/audio/wavBytes'

function fakeBuffer(channels: Float32Array[], sampleRate = 1000): AudioBuffer {
  return { sampleRate, length: channels[0]!.length, duration: channels[0]!.length / sampleRate,
    numberOfChannels: channels.length, getChannelData: (c: number) => channels[c]! } as AudioBuffer
}

describe('rendered seam', () => {
  it('continues past the cut rather than replaying the old tail, for both stereo channels', () => {
    const left = Float32Array.from({ length: 2000 }, (_, i) => 0.4 * Math.sin(i * 0.1))
    const right = Float32Array.from(left, v => -v)
    const buffer = fakeBuffer([left, right])
    const { channels } = renderLoopChannels(buffer, 0.3, 1.3, { wrapCrossfadeSec: 0.035, normalize: false })
    channels.forEach((ch, c) => {
      const src = buffer.getChannelData(c)
      expect(ch.length).toBe(1000)
      expect(ch[0]).toBe(src[1300])
      expect(ch[34]).toBe(src[334])
      expect(Math.abs(ch[0]! - ch[999]!)).toBeCloseTo(Math.abs(src[1300]! - src[1299]!), 6)
      expect(ch.slice(35)).toEqual(src.slice(335, 1300))
    })
    expect(left[300]).not.toBe(channels[0]![0]) // non-destructive
  })

  it('does not boost a perfectly correlated continuation', () => {
    const ch = new Float32Array(400).fill(0.5)
    bakeWrapCrossfade(ch, 40, new Float32Array(40).fill(0.5))
    expect([...ch].every(value => value === 0.5)).toBe(true)
  })

  it('closes a cut at the end of the source without inventing silent post-roll', () => {
    const ch = Float32Array.from({ length: 400 }, (_, i) => i / 400)
    bakeWrapCrossfade(ch, 40)
    expect(ch[0]).toBe(ch[399])
    expect(ch[39]).toBeCloseTo(39 / 400)
  })

  it('can audition a raw seam with crossfade disabled', () => {
    const ch = Float32Array.from([1, 0.5, 0.1, -0.4])
    expect(renderLoopChannels(fakeBuffer([ch]), 0, 0.004, { wrapCrossfadeSec: 0, normalize: false }).channels[0]).toEqual(ch)
  })

  it('blends a whole beat without moving beats, clipping or altering the loop body', () => {
    const ch = Float32Array.from({ length: 12000 }, (_, i) => 0.6 * Math.sin(i * 0.19))
    const buffer = fakeBuffer([ch])
    const result = renderLoopChannels(buffer, 2, 10, { wrapCrossfadeSec: 0.5, normalize: false })
    expect(result.wrapCrossfadeSec).toBe(0.5)
    expect(result.channels[0]).toHaveLength(8000)
    expect(result.channels[0]![0]).toBe(ch[10000])
    expect(result.channels[0]!.slice(500)).toEqual(ch.slice(2500, 10000))
    expect(Math.max(...result.channels[0]!.map(Math.abs))).toBeLessThanOrEqual(0.600001)
  })

  it('uses available post-roll and limits an EOF repair to five milliseconds', () => {
    const ch = Float32Array.from({ length: 4050 }, (_, i) => 0.4 * Math.sin(i * 0.1))
    const buffer = fakeBuffer([ch])
    const partial = renderLoopChannels(buffer, 0, 4, { wrapCrossfadeSec: 0.5, normalize: false })
    expect(partial.wrapCrossfadeSec).toBe(0.05)
    expect(partial.channels[0]![0]).toBe(ch[4000])
    expect(partial.channels[0]!.slice(50)).toEqual(ch.slice(50, 4000))
    const eof = renderLoopChannels(buffer, 0, 4.05, { wrapCrossfadeSec: 0.5, normalize: false })
    expect(eof.wrapCrossfadeSec).toBe(0.005)
    expect(eof.channels[0]![0]).toBe(ch[4049])
    expect(eof.channels[0]!.slice(5)).toEqual(ch.slice(5))
  })
})

describe('game-ready WAVs', () => {
  it('writes mono clips without overflowing a stereo-sized sample loop', () => {
    const data = new DataView(writeWavStereo16(fakeBuffer([new Float32Array([0.5, -0.5, 0])], 48000)))
    expect(data.getUint16(22, true)).toBe(1)
    expect(data.getUint32(40, true)).toBe(6)
    expect(data.byteLength).toBe(50)
    expect(data.getInt16(44, true)).toBe(16384)
  })
})
