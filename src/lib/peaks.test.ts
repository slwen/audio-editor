import { expect, it } from 'vitest'
import { peaksForBuffer, peaksForBufferAsync } from './peaks'

it.each([1, 2])('preserves float32 averaged extrema for %i channels without a full downmix', async channels => {
  const left = Float32Array.from({ length: 4097 }, (_, i) => Math.sin(i))
  const right = channels === 2 ? Float32Array.from(left, value => value * -0.2) : left
  const buffer = { numberOfChannels: channels, getChannelData: (c: number) => c ? right : left } as AudioBuffer
  const mixed = Float32Array.from(left, (value, i) => (value + right[i]!) / 2)
  const buckets = Math.ceil(left.length / 256)
  const expected = new Float32Array(buckets * 2)
  for (let b = 0; b < buckets; b++) {
    const values = mixed.slice(Math.floor(b * mixed.length / buckets), Math.floor((b + 1) * mixed.length / buckets))
    expected[b * 2] = Math.min(0, ...values)
    expected[b * 2 + 1] = Math.max(0, ...values)
  }
  expect(peaksForBuffer(buffer)).toEqual(expected)
  expect(await peaksForBufferAsync(buffer)).toEqual(expected)
})
