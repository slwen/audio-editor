import { expect, it } from 'vitest'
import { extractMonoForAnalysis } from './detectLoops'
import { prepareAnalysis } from './prepareAnalysis'

it.each([22050, 44100, 48000])('preserves trimmed downmix/decimation samples at %i Hz', async sampleRate => {
  const channels = [Float32Array.from({ length: 262147 }, (_, i) => Math.sin(i)), Float32Array.from({ length: 262147 }, (_, i) => Math.cos(i))]
  const a = 3
  const b = 262144
  const buffer = { sampleRate, length: channels[0]!.length, numberOfChannels: 2, getChannelData: (c: number) => channels[c] } as AudioBuffer
  const expected = extractMonoForAnalysis(channels.map(c => c.slice(a, b)), sampleRate)
  const actual = await prepareAnalysis(buffer, a / sampleRate, b / sampleRate)
  expect(actual.sampleRate).toBe(expected.sampleRate)
  expect(actual.samples).toEqual(expected.samples)
})

it('honors cancellation before preprocessing audio', async () => {
  const controller = new AbortController()
  controller.abort()
  const buffer = { sampleRate: 48000, length: 100, numberOfChannels: 1, getChannelData: () => new Float32Array(100) } as unknown as AudioBuffer
  await expect(prepareAnalysis(buffer, 0, 0.001, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})
