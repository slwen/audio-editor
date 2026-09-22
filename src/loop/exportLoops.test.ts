import { expect, it, vi } from 'vitest'
import { exportLoopCandidates } from './exportLoops'
import { renderLoopChannels } from './wrapLoop'
import { writeWavStereo16 } from '@/audio/wavBytes'
import type { LoopCandidate } from './types'

const download = vi.hoisted(() => vi.fn())
vi.mock('@/lib/downloadBlob', () => ({ downloadBlob: download }))
vi.mock('@/audio/wavBytes', async importOriginal => ({
  ...await importOriginal<typeof import('@/audio/wavBytes')>(),
  audioBufferFromChannels: (sr: number, channels: Float32Array[]) => fakeBuffer(channels, sr),
}))

function fakeBuffer(channels: Float32Array[], sampleRate = 1000): AudioBuffer {
  return { sampleRate, numberOfChannels: channels.length, length: channels[0]!.length,
    getChannelData: (c: number) => channels[c]! } as AudioBuffer
}

it('exports each saved/edited cut with its own audible settings and sample-exact manifest', async () => {
  const source = fakeBuffer([Float32Array.from({ length: 14000 }, (_, i) => 0.3 * Math.sin(i * 0.17))])
  const a: LoopCandidate = { id: 'a', startSec: 1, endSec: 9, bars: 4, bpm: 120,
    seamScore: 0.9, contextScore: 0.9, homogeneityScore: 0.95, qualityScore: 0.8,
    savedRender: { wrapCrossfadeSec: 0, normalize: false } }
  const b: LoopCandidate = { ...a, id: 'b', startSec: 5.95, endSec: 13.95 }
  const edited = { wrapCrossfadeSec: 0.5, normalize: true }
  await exportLoopCandidates(source, 'song.wav', 120, [a, b], {
    wrapCrossfadeSec: 0.035, normalize: false, renderOptionsById: { b: edited },
  })
  const bytes = new DataView(await (download.mock.calls[0]![0] as Blob).arrayBuffer())
  const entries = new Map<string, Uint8Array>()
  let at = 0
  while (bytes.getUint32(at, true) === 0x04034b50) {
    const size = bytes.getUint32(at + 18, true)
    const nameLength = bytes.getUint16(at + 26, true)
    const name = new TextDecoder().decode(new Uint8Array(bytes.buffer, at + 30, nameLength))
    const start = at + 30 + nameLength + bytes.getUint16(at + 28, true)
    entries.set(name, new Uint8Array(bytes.buffer.slice(start, start + size)))
    at = start + size
  }
  const manifest = JSON.parse(new TextDecoder().decode(entries.get('song_loops.json')))
  expect(manifest.wrapCrossfadeSec).toBeNull()
  expect(manifest.normalize).toBeNull()
  expect(manifest.loops[0]).toMatchObject({ wrapCrossfadeSec: 0, normalize: false, sampleCount: 8000 })
  expect(manifest.loops[1]).toMatchObject({ requestedWrapCrossfadeSec: 0.5, wrapCrossfadeSec: 0.05,
    normalize: true, sampleCount: 8000 })
  for (const [i, candidate] of [a, b].entries()) {
    const rendered = renderLoopChannels(source, candidate.startSec, candidate.endSec, i ? edited : a.savedRender!)
    const expected = writeWavStereo16(fakeBuffer(rendered.channels, rendered.sampleRate))
    expect(entries.get(manifest.loops[i].file)).toEqual(new Uint8Array(expected))
  }
})
