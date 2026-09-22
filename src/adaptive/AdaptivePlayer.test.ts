import { describe, expect, it, vi } from 'vitest'
import { AdaptivePlayer } from './AdaptivePlayer'
import { DEFAULT_MUSIC_SETTINGS, nextMusicExit, releaseDelay, type MusicSlot } from './model'

const slot: MusicSlot = { key: 'test', render: { wrapCrossfadeSec: 0, normalize: false },
  candidate: { id: 'test', startSec: 0, endSec: 32, bars: 16, bpm: 120,
    seamScore: 1, contextScore: 1, homogeneityScore: 1, qualityScore: 1 } }

function fixture() {
  const sources: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
  const gains: { gain: { setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn>; cancelScheduledValues: ReturnType<typeof vi.fn> } }[] = []
  const ctx = { currentTime: 0,
    createBufferSource: () => {
      const source = { start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), connect: vi.fn() }
      sources.push(source); return source
    },
    createGain: () => {
      const gain = { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() },
        connect: vi.fn(), disconnect: vi.fn() }
      gains.push(gain); return gain
    },
  }
  const player = new AdaptivePlayer(ctx as unknown as AudioContext, {} as AudioNode)
  const buffer = { duration: 32 } as AudioBuffer
  player.start('exploration', slot, buffer)
  return { ctx, player, buffer, sources, gains }
}

describe('adaptive timing', () => {
  it('leaves a long bed at the next bar rather than waiting 16 bars', () => {
    expect(nextMusicExit(0.4, 0, 32, 16, 1, 0)).toBe(2)
    expect(nextMusicExit(0.4, 0, 32, 16, 0, 0)).toBe(32)
  })
  it('includes loop wraps for lengths not divisible by the exit grouping', () => {
    expect(nextMusicExit(10, 0, 12, 6, 4, 0)).toBe(12)
    expect(nextMusicExit(12.1, 0, 12, 6, 4, 0)).toBe(20)
  })
  it('uses actual sample duration and allows scheduling lead time near a boundary', () => {
    expect(nextMusicExit(1.99, 0, 8.0004, 4, 1, 0)).toBeCloseTo(4.0002)
    expect(nextMusicExit(0.5, 0, 8, 4, 1, 5)).toBe(6)
    expect(releaseDelay('combat', 'exploration', 3)).toBe(3)
    expect(releaseDelay('exploration', 'intensity', 3)).toBe(0)
  })
})

describe('unpredictable gameplay', () => {
  it('replaces a queued state and cancels its audio before it can start', () => {
    const { ctx, player, sources, gains, buffer } = fixture()
    ctx.currentTime = 0.5
    player.request('combat', slot, buffer, DEFAULT_MUSIC_SETTINGS)
    expect(sources[1]!.start).toHaveBeenCalledWith(2.08)
    ctx.currentTime = 0.8
    player.request('intensity', slot, buffer, DEFAULT_MUSIC_SETTINGS)
    expect(sources[1]!.stop).toHaveBeenCalledOnce()
    expect(gains[0]!.gain.cancelScheduledValues).toHaveBeenCalledWith(2.08)
    expect(player.snapshot().requested).toBe('intensity')
    ctx.currentTime = 2.09
    expect(player.snapshot()).toMatchObject({ current: 'intensity', requested: null })
    expect(player.snapshot().transition).toMatchObject({ from: 'exploration', to: 'intensity' })
  })
  it('returning to the current state cancels the queued change without restarting the bed', () => {
    const { ctx, player, sources, buffer } = fixture()
    ctx.currentTime = 0.5
    player.request('combat', slot, buffer, DEFAULT_MUSIC_SETTINGS)
    player.request('exploration', slot, buffer, DEFAULT_MUSIC_SETTINGS)
    expect(sources).toHaveLength(2)
    expect(sources[0]!.stop).not.toHaveBeenCalled()
    expect(sources[1]!.stop).toHaveBeenCalledOnce()
    ctx.currentTime = 5
    expect(player.snapshot()).toMatchObject({ current: 'exploration', requested: null, transition: null })
  })
  it('does not postpone a calm request when the game sends that state every frame', () => {
    const { ctx, player, sources, buffer } = fixture()
    player.start('combat', slot, buffer)
    ctx.currentTime = 0.5
    player.request('exploration', slot, buffer, DEFAULT_MUSIC_SETTINGS)
    const before = sources.at(-1)
    expect(before!.start).toHaveBeenCalledWith(4.08)
    ctx.currentTime = 1.5
    player.request('exploration', slot, buffer, DEFAULT_MUSIC_SETTINGS)
    expect(sources.at(-1)).toBe(before)
    expect(player.snapshot().remaining).toBeCloseTo(2.58)
  })
  it('advances already-started transitions before handling a late request, and releases faded voices', () => {
    const { ctx, player, sources, buffer } = fixture()
    ctx.currentTime = 0.5
    player.request('combat', slot, buffer, DEFAULT_MUSIC_SETTINGS)
    ctx.currentTime = 2.5 // no UI tick at the scheduled boundary
    player.request('intensity', slot, buffer, DEFAULT_MUSIC_SETTINGS)
    expect(player.snapshot()).toMatchObject({ current: 'combat', requested: 'intensity' })
    expect(sources[0]!.stop).toHaveBeenCalledOnce()
    expect(sources[2]!.start).toHaveBeenCalledWith(4.08)
    player.stop()
    expect(sources.every(source => source.stop.mock.calls.length === 1)).toBe(true)
    expect(player.snapshot().current).toBeNull()
  })
})
