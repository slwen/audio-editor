import { describe, expect, it } from 'vitest'
import { planLayeredTimeline, type LayerSource } from './layerPlan'
import type { Clip } from '@/types'

const clip = (id: string, bufferId: string, row: number, startTime: number): Clip => ({
  id, bufferId, row, startTime, layerIndex: 2, trimStart: 8.25, trimEnd: 17.5,
  speed: 1.25, gain: 0.6, fadeInSec: 0.4, fadeOutSec: 0.8, accentColor: '#ff0000',
})

describe('selected clip layering', () => {
  it('keeps timing, trims, speed, gain and fades while sharing split audio', () => {
    const clips = [clip('a', 'song', 0, 12), clip('b', 'song', 0, 30), clip('untouched', 'other', 1, 50)]
    const sources: LayerSource[] = [{ sourceBufferId: 'song', stems: [
      { kind: 'base', bufferId: 'base', durationSec: 60 },
      { kind: 'top', bufferId: 'top', durationSec: 60 },
    ] }]
    let n = 0
    const result = planLayeredTimeline(clips, [
      { id: 'song', name: 'song.mp3', durationSec: 60 },
      { id: 'other', name: 'other.mp3', durationSec: 60 },
    ], ['a', 'b'], sources, () => `layer-${++n}`)
    expect(result.clips).toHaveLength(5)
    expect(result.clips[4]).toBe(clips[2])
    expect(result.clips.filter(c => c.bufferId === 'base').map(c => c.row)).toEqual([0, 0])
    expect(result.clips.filter(c => c.bufferId === 'top').map(c => c.row)).toEqual([2, 2])
    for (const original of clips.slice(0, 2)) {
      const layers = result.clips.filter(c => c.startTime === original.startTime)
      expect(layers).toHaveLength(2)
      for (const layer of layers) {
        expect(layer).toMatchObject({ startTime: original.startTime, trimStart: original.trimStart,
          trimEnd: original.trimEnd, speed: original.speed, gain: original.gain,
          fadeInSec: original.fadeInSec, fadeOutSec: original.fadeOutSec, layerIndex: original.layerIndex })
      }
    }
    expect(result.bufferMeta.map(meta => meta.id)).toEqual(['other', 'base', 'top'])
    expect(result.selection).toHaveLength(4)
  })

  it('allocates separate new rows for each stem and source row', () => {
    const clips = [clip('a', 'one', 0, 0), clip('b', 'two', 3, 4)]
    const stems = (sourceBufferId: string): LayerSource => ({ sourceBufferId,
      stems: (['drums', 'bass', 'other', 'vocals'] as const).map(kind => ({ kind,
        bufferId: `${sourceBufferId}-${kind}`, durationSec: 30 })) })
    const result = planLayeredTimeline(clips, [
      { id: 'one', name: 'one.wav', durationSec: 30 },
      { id: 'two', name: 'two.wav', durationSec: 30 },
    ], ['a', 'b'], [stems('one'), stems('two')])
    expect(result.clips.filter(c => c.startTime === 0).map(c => c.row)).toEqual([0, 4, 5, 6])
    expect(result.clips.filter(c => c.startTime === 4).map(c => c.row)).toEqual([3, 7, 8, 9])
  })
})
