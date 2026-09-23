import { describe, expect, it, vi } from 'vitest'
import { AdaptivePlayer } from './AdaptivePlayer'
import { choosePassage, nextApprovedMusicExit, nextMusicExit, nextMusicExitAtBar, passagePairKey, releaseDelay, type MusicSlot } from './model'

const DEFAULT_MUSIC_SETTINGS = { exitBars: 1, fadeBeats: 0.25, releaseSec: 3 }
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
  it('reuses the same approved exit bar on later repetitions', () => {
    expect(nextMusicExitAtBar(0.5, 0.08, 32, 16, 4, 0)).toBeCloseTo(8.08)
    expect(nextMusicExitAtBar(9, 0.08, 32, 16, 4, 0)).toBeCloseTo(40.08)
  })
  it('takes the next reviewed point as the loop continues and after it wraps', () => {
    const exits = [{ exitBar: 4 }, { exitBar: 8 }]
    expect(nextApprovedMusicExit(0.5, 0.08, 32, 16, exits, 0)).toMatchObject({ when: 8.08, exit: exits[0] })
    expect(nextApprovedMusicExit(9, 0.08, 32, 16, exits, 0)).toMatchObject({ when: 16.08, exit: exits[1] })
    expect(nextApprovedMusicExit(17, 0.08, 32, 16, exits, 0)).toMatchObject({ when: 40.08, exit: exits[0] })
  })
})

describe('passage progression', () => {
  const a = { ...slot, key: 'a' }
  const b = { ...slot, key: 'b', candidate: { ...slot.candidate, startSec: 32, endSec: 64 } }
  const c = { ...slot, key: 'c', candidate: { ...slot.candidate, startSec: 80, endSec: 112 } }
  it('prefers original continuation, avoids overlapping cuts and respects blocked connections', () => {
    const overlap = { ...slot, key: 'overlap', candidate: { ...slot.candidate, startSec: 2, endSec: 34 } }
    expect(choosePassage([a, overlap, c, b], a, ['a', 'b'], {})).toBe(b)
    expect(choosePassage([a, overlap, c, b], a, [], { [passagePairKey(a, b)]: { blocked: true } })).toBe(c)
    expect(choosePassage([a, overlap], a, [], {})).toBeUndefined()
    expect(choosePassage([a, b], c, ['a'], {})).toBe(b)
    expect(choosePassage([c, b], a, [], {}, true)).toBe(b)
    expect(choosePassage([c], a, [], {}, true)).toBeUndefined()
    expect(choosePassage([c], a, [], { [passagePairKey(a, c)]: { approved: true } }, true)).toBe(c)
  })
  it('holds combat until a reviewed route is available and uses its pinned exit bar', () => {
    const { player, buffer, ctx, sources } = fixture()
    player.configure({ combat: [{ slot: a, buffer }], exploration: [{ slot: c, buffer }] },
      { ...DEFAULT_MUSIC_SETTINGS, approvedOnly: true, advance: true }, {})
    player.start('combat', a, buffer)
    expect(player.snapshot().nextSlot).toBeUndefined()
    expect(player.requestState('exploration')).toBe(false)
    expect(sources).toHaveLength(2) // fixture start, then combat start; no transition source
    player.configure({ combat: [{ slot: a, buffer }], exploration: [{ slot: c, buffer }] },
      { ...DEFAULT_MUSIC_SETTINGS, approvedOnly: true, advance: true },
      { [passagePairKey(a, c)]: { approved: true, exitBar: 4 } })
    ctx.currentTime = 0.5
    expect(player.requestState('exploration')).toBe(true)
    expect(sources.at(-1)!.start).toHaveBeenCalledWith(8.08)
    ctx.currentTime = 8.1
    expect(player.snapshot()).toMatchObject({ current: 'exploration', transition: { exitOffsetSec: 8 } })
    expect(player.requestState('combat')).toBe(false)
  })
  it('chooses the soonest approved exit even when it leads to a different destination', () => {
    const { player, buffer, ctx, sources } = fixture()
    const routes = { [passagePairKey(a, b)]: { approved: true, approvedExits: [{ exitBar: 4 }] },
      [passagePairKey(a, c)]: { approved: true, approvedExits: [{ exitBar: 8 }] } }
    player.configure({ combat: [{ slot: a, buffer }], exploration: [{ slot: b, buffer }, { slot: c, buffer }] },
      { ...DEFAULT_MUSIC_SETTINGS, approvedOnly: true }, routes)
    player.start('combat', a, buffer)
    ctx.currentTime = 9
    expect(player.requestState('exploration')).toBe(true)
    expect(player.snapshot().nextSlot).toBe(c)
    expect(sources.at(-1)!.start).toHaveBeenCalledWith(16.08)
  })
  it('uses a longer combat return even for older Good exits and late entry bars', () => {
    for (const [minimumBeats, expectedSeconds] of [[4, 2], [8, 4]]) {
      const { player, buffer, ctx, sources } = fixture()
      const calm = { ...b, candidate: { ...b.candidate, endSec: 40, bars: 4 } }
      const calmBuffer = { duration: 8 } as AudioBuffer
      player.configure({ combat: [{ slot: a, buffer }], exploration: [{ slot: calm, buffer: calmBuffer }] },
        { ...DEFAULT_MUSIC_SETTINGS, releaseSec: 0, approvedOnly: true,
          combatToExplorationFadeBeats: minimumBeats },
        { [passagePairKey(a, calm)]: { approved: true,
          approvedExits: [{ exitBar: 4, entryBar: 3, fadeBeats: 1 }] } })
      player.start('combat', a, buffer)
      ctx.currentTime = 0.5
      expect(player.requestState('exploration')).toBe(true)
      expect(sources.at(-1)!.start).toHaveBeenCalledWith(8.08, 6)
      ctx.currentTime = 8.1
      expect(player.snapshot().transition).toMatchObject({ fadeSec: expectedSeconds, entryOffsetSec: 6,
        settings: { fadeBeats: minimumBeats } })
    }
  })
  it('can audition a specific second combat passage without approving it for normal playback', () => {
    const { player, buffer, ctx, sources } = fixture()
    player.configure({ combat: [{ slot: a, buffer }, { slot: c, buffer }] },
      { ...DEFAULT_MUSIC_SETTINGS, approvedOnly: true, advance: true }, {})
    player.start('combat', a, buffer)
    expect(player.snapshot().nextSlot).toBeUndefined()
    ctx.currentTime = 0.5
    player.request('combat', c, buffer, DEFAULT_MUSIC_SETTINGS)
    expect(sources.at(-1)!.start).toHaveBeenCalledWith(2.08)
    ctx.currentTime = 2.1
    expect(player.snapshot()).toMatchObject({ current: 'combat', currentSlot: c,
      transition: { from: 'combat', to: 'combat' } })
  })
  it('schedules a continuous source passage then a return to a bed, without waiting for a game event', () => {
    const { player, buffer, ctx } = fixture()
    const passage = { ...b, kind: 'passage' as const }
    player.configure({ exploration: [{ slot: a, buffer }, { slot: passage, buffer, rawBuffer: buffer }] },
      { ...DEFAULT_MUSIC_SETTINGS, advance: true, repeats: 1 }, {})
    player.start('exploration', a, buffer)
    expect(player.snapshot()).toMatchObject({ automatic: true, nextSlot: passage, remaining: 32.08 })
    ctx.currentTime = 32.09
    expect(player.snapshot()).toMatchObject({ currentSlot: passage, nextSlot: a,
      transition: { natural: true, fadeSec: 0 } })
    ctx.currentTime = 64.1
    expect(player.snapshot().currentSlot).toBe(a)
  })
  it('lets a gameplay request replace automatic progression and uses per-pair exit, entry and blend', () => {
    const { player, buffer, ctx, sources } = fixture()
    player.configure({ exploration: [{ slot: a, buffer }, { slot: b, buffer }], combat: [{ slot: c, buffer }] },
      { ...DEFAULT_MUSIC_SETTINGS, advance: true }, { [passagePairKey(a, c)]: { exitBars: 2, entryBar: 3, fadeBeats: 4 } })
    player.start('exploration', a, buffer)
    const auto = sources.at(-1)!
    ctx.currentTime = 0.5
    expect(player.requestState('combat')).toBe(true)
    expect(auto.stop).toHaveBeenCalledOnce()
    expect(sources.at(-1)!.start).toHaveBeenCalledWith(4.08, 6)
    ctx.currentTime = 4.1
    expect(player.snapshot().transition).toMatchObject({ entryOffsetSec: 6, fadeSec: 2 })
  })
  it('preserves music when two states share the same bed and holds if all alternatives are blocked', () => {
    const { player, buffer, sources } = fixture()
    player.configure({ exploration: [{ slot: a, buffer }], combat: [{ slot: a, buffer }, { slot: b, buffer }] },
      { ...DEFAULT_MUSIC_SETTINGS, advance: true }, { [passagePairKey(a, b)]: { blocked: true } })
    player.start('exploration', a, buffer)
    const count = sources.length
    player.requestState('combat')
    expect(sources.length).toBe(count)
    expect(player.snapshot()).toMatchObject({ current: 'combat', requested: null })
  })
  it('does not postpone automatic movement when gameplay reports the current state near the boundary', () => {
    const { player, buffer, ctx, sources } = fixture()
    player.configure({ exploration: [{ slot: a, buffer }, { slot: b, buffer }] },
      { ...DEFAULT_MUSIC_SETTINGS, advance: true }, {})
    player.start('exploration', a, buffer)
    const scheduled = sources.at(-1)!
    ctx.currentTime = 32.04
    player.requestState('exploration')
    player.requestState('exploration')
    expect(scheduled.stop).not.toHaveBeenCalled()
    expect(player.snapshot().remaining).toBeCloseTo(0.04)
    ctx.currentTime = 32.09
    expect(player.snapshot().currentSlot).toBe(b)
  })
  it('waits for an arrival blend to finish before beginning another blend', () => {
    const { player, buffer, ctx, sources } = fixture()
    const settings = { ...DEFAULT_MUSIC_SETTINGS, fadeBeats: 8, advance: false }
    player.configure({ exploration: [{ slot: a, buffer }], combat: [{ slot: b, buffer }], intensity: [{ slot: c, buffer }] }, settings, {})
    player.start('exploration', a, buffer)
    ctx.currentTime = 0.5
    player.requestState('combat')
    ctx.currentTime = 2.2
    player.requestState('intensity')
    expect(sources.at(-1)!.start).toHaveBeenCalledWith(6.08)
  })
  it('plays short fractional-bar source gaps once and reaches the following section on time', () => {
    const { player, buffer, ctx, sources } = fixture()
    const gap: MusicSlot = { ...b, kind: 'passage', candidate: { ...b.candidate, endSec: 32.1, bars: 0.05 } }
    const following = { ...c, candidate: { ...c.candidate, startSec: 32.1, endSec: 64.1 } }
    const short = { duration: 0.1 } as AudioBuffer
    player.configure({ exploration: [{ slot: a, buffer }, { slot: gap, buffer: short, rawBuffer: short },
      { slot: following, buffer, rawBuffer: buffer }] }, { ...DEFAULT_MUSIC_SETTINGS, advance: true }, {})
    player.start('exploration', a, buffer)
    ctx.currentTime = 32.14
    expect(player.snapshot()).toMatchObject({ currentSlot: gap, nextSlot: following })
    expect(sources.some(source => source.start.mock.calls.some(call => Math.abs(call[0] - 32.18) < 1e-8))).toBe(true)
    ctx.currentTime = 32.19
    expect(player.snapshot().currentSlot).toBe(following)
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
