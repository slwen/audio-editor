import { describe, expect, it } from 'vitest'
import type { LoopCandidate } from '@/loop/types'
import { loopRatingKey } from '@/loop/loopRatings'
import type { useLoopStore } from '@/store/useLoopStore'
import { activeMusicSlots, passagePairKey, type MusicSlot } from './model'
import { chooseFocusedPair, draftZoneLoops, longestExitWait, routesForEachHold, songZones, suggestRoutes } from './zonePlan'

const candidate = (startSec: number, bars: 4 | 16): LoopCandidate => ({
  id: String(startSec), startSec, endSec: startSec + bars * 2.4375, bars, bpm: 98.46,
  seamScore: 0.8, contextScore: 0.8, qualityScore: 0.55,
  homogeneityScore: 0.8,
})

describe('zone draft', () => {
  it('turns rough change flags into consecutive song areas', () => {
    expect(songZones(0, 240, [
      { id: 'b', timeSec: 190, state: 'exploration' },
      { id: 'a', timeSec: 142, state: 'combat' },
    ])).toEqual([
      { startSec: 0, endSec: 142, state: 'exploration' },
      { startSec: 142, endSec: 190, state: 'combat' },
      { startSec: 190, endSec: 240, state: 'exploration' },
    ])
  })

  it('keeps the reviewed exploration hold near combat and the long combat bed', () => {
    const choices = [candidate(35.5, 4), candidate(130.1, 4), candidate(142.3, 16)]
    const ratings = Object.fromEntries(choices.map(c => [loopRatingKey({ sourceName: 'Cathedral', ...c }), 'good']))
    const loop = { sourceName: 'Cathedral', trimStart: 0, trimEnd: 241, candidates: choices, ratings,
      renderOverrides: {}, wrapCrossfadeSec: 0.05, normalizeExport: false } as unknown as ReturnType<typeof useLoopStore.getState>
    const zones = songZones(0, 241, [{ id: 'combat', timeSec: 145, state: 'combat' }])
    const draft = draftZoneLoops(loop, zones)
    expect(draft.missing).toEqual([])
    expect(draft.slots.exploration?.[0]?.candidate.startSec).toBe(130.1)
    expect(draft.slots.combat?.[0]?.candidate.startSec).toBe(142.3)
  })

  it('shows the missing return from the actual combat hold, even when other holds have Good returns', () => {
    const slot = (time: number): MusicSlot => ({ key: String(time), candidate: candidate(time, 4),
      render: { wrapCrossfadeSec: 0.05, normalize: false } })
    const exploration = slot(52)
    const combatWithReturn = slot(72)
    const combatWithoutReturn = slot(198)
    const proposal = { from: combatWithoutReturn, to: exploration, exitBar: 0, score: 0.9 }
    const rules = { [passagePairKey(combatWithReturn, exploration)]: { approved: true, exitBar: 2 } }
    const groups = routesForEachHold([combatWithReturn, combatWithoutReturn], [exploration], [proposal], rules, [])
    expect(groups[0].approved).toMatchObject([{ from: combatWithReturn, exitBar: 2, entryBar: 0 }])
    expect(groups[1].approved).toEqual([])
    expect(groups[1].suggested).toEqual([proposal])
    const connected = routesForEachHold([combatWithoutReturn], [exploration], [proposal], {
      ...rules, [passagePairKey(combatWithoutReturn, exploration)]: { approved: true, exitBar: 0 },
    }, [])
    expect(connected[0].approved).toHaveLength(1)
  })

  it('offers two-bar points and shows all approved exits from one hold', () => {
    const from: MusicSlot = { key: 'combat', candidate: candidate(142, 16),
      render: { wrapCrossfadeSec: 0.05, normalize: false } }
    const to: MusicSlot = { key: 'exploration', candidate: candidate(52, 4),
      render: { wrapCrossfadeSec: 0.05, normalize: false } }
    const buffer = { sampleRate: 44100, getChannelData: () => new Float32Array(44100 * 200) } as unknown as AudioBuffer
    const proposals = suggestRoutes(buffer, [from], [to])
    expect(new Set(proposals.map(route => route.exitBar))).toEqual(new Set(Array.from({ length: 16 }, (_, i) => i)))
    expect(proposals.filter(route => route.exitBar === 3).map(route => route.entryBar).sort()).toEqual([0, 1, 2, 3])
    const routes = routesForEachHold([from], [to], proposals,
      { [passagePairKey(from, to)]: { approved: true, approvedExits: [{ exitBar: 4 }, { exitBar: 8 }] } }, [])
    expect(routes[0].approved.map(route => route.exitBar)).toEqual([4, 8])
    expect(routes[0].suggested).toHaveLength(1)
    expect(longestExitWait(from, routes[0].approved)).toBeCloseTo(29.25)
    expect(longestExitWait(from, [routes[0].approved[0]!])).toBeCloseTo(39)
  })

  it('offers a different entry at a rejected exit and prioritizes shrinking the longest gap', () => {
    const from: MusicSlot = { key: 'combat', candidate: candidate(142, 16),
      render: { wrapCrossfadeSec: 0.05, normalize: false } }
    const to: MusicSlot = { key: 'exploration', candidate: candidate(52, 4),
      render: { wrapCrossfadeSec: 0.05, normalize: false } }
    const ranked = [
      { from, to, exitBar: 3, entryBar: 0, score: 0.9 },
      { from, to, exitBar: 3, entryBar: 2, score: 0.8 },
      { from, to, exitBar: 8, entryBar: 0, score: 1 },
    ]
    const bad = { id: 'bad', at: '', from: 'combat', to: 'exploration', fromLoop: from, toLoop: to,
      settings: { exitBars: 2, fadeBeats: 1, releaseSec: 0 },
      exitOffsetSec: 3 / 16 * (from.candidate.endSec - from.candidate.startSec),
      entryOffsetSec: 0, fadeSec: 0.5, rating: 'bad', note: '' } as const
    const group = routesForEachHold([from], [to], ranked,
      { [passagePairKey(from, to)]: { approved: true,
        approvedExits: [{ exitBar: 10 }, { exitBar: 12 }] } }, [bad])[0]!
    expect(group.suggested).toEqual([ranked[1]])
  })

  it('focuses the preview on one nearby pair while retaining the other saved holds', () => {
    const slot = (time: number, bars: 4 | 16): MusicSlot => ({ key: String(time), candidate: candidate(time, bars),
      render: { wrapCrossfadeSec: 0.05, normalize: false } })
    const earlyExploration = slot(52, 4)
    const nearExploration = slot(130, 4)
    const nearCombat = slot(142, 16)
    const lateCombat = slot(198, 4)
    const slots = { exploration: [earlyExploration, nearExploration], combat: [nearCombat, lateCombat] }
    const rules = {
      [passagePairKey(earlyExploration, lateCombat)]: { approved: true },
      [passagePairKey(nearCombat, nearExploration)]: { approved: true },
    }
    const pair = chooseFocusedPair(slots.exploration, slots.combat, rules)
    expect(pair).toEqual({ exploration: nearExploration, combat: nearCombat })
    const focus = { exploration: pair!.exploration.key, combat: pair!.combat.key }
    expect(activeMusicSlots(slots, 'exploration', focus)).toEqual([nearExploration])
    expect(activeMusicSlots(slots, 'combat', focus)).toEqual([nearCombat])
    expect(slots.combat).toHaveLength(2)
  })
})
