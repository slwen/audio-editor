import { describe, expect, it } from 'vitest'
import { DEFAULT_PACK_POLICY, PACK_VERSION, type Pack, type PackJump } from './pack'
import { renderSegments, stepsToSegments } from './render'
import { PackRuntime, type PackStep } from './runtime'
import { simulatePack } from './simulate'

/** 120 BPM: 0-16 s exploration, 16-32 s combat. */
function pack(jumps: PackJump[]): Pack {
  const beatsSec = Array.from({ length: 64 }, (_, i) => i * 0.5)
  return { version: PACK_VERSION, sourceName: 'test', bpm: 120, durationSec: 32, beatsSec,
    zones: [{ startSec: 0, endSec: 16, feel: 'exploration' }, { startSec: 16, endSec: 32, feel: 'combat' }],
    zoneSource: 'listener', jumpModel: 'test', policy: { ...DEFAULT_PACK_POLICY, releaseSec: 0 }, jumps, blockedJumps: 0 }
}
const model = (exitSec: number, entrySec: number, pCut: number, pBlended: number): PackJump =>
  ({ exitSec, entrySec, pCut, pBlended, source: 'model' })
const holds = [model(16, 0, 0.9, 0.95), model(32, 16, 0.9, 0.95)]
const switches = [...[4, 8, 12].map(t => model(t, 20, 0.4, 0.8)), ...[20, 24, 28].map(t => model(t, 2, 0.4, 0.8))]

function playUntil(runtime: PackRuntime, steps: number, onStep?: (i: number) => void): PackStep[] {
  const out: PackStep[] = []
  for (let i = 0; i < steps; i++) { onStep?.(i); out.push(runtime.advance()) }
  return out
}
const joinsOf = (steps: PackStep[]) => steps.flatMap(s => s.join ? [s.join] : [])

describe('pack runtime', () => {
  it('holds a feel indefinitely by jumping back before its material ends', () => {
    const runtime = new PackRuntime(pack([...holds, ...switches]))
    runtime.start('exploration')
    const steps = playUntil(runtime, 200)
    expect(steps.every(s => runtime.feelAt(s.startSec) === 'exploration')).toBe(true)
    expect(joinsOf(steps).every(j => j.kind === 'hold' && j.fadeSec === 0.035)).toBe(true)
    expect(joinsOf(steps).length).toBeGreaterThan(4)
  })

  it('prefers a recently heard good hold over a fresh weak one', () => {
    const runtime = new PackRuntime(pack([...holds, model(16, 6, 0.4, 0.5)]))
    runtime.start('exploration')
    const joins = joinsOf(playUntil(runtime, 200))
    expect(joins.length).toBeGreaterThan(4)
    expect(joins.every(j => j.kind === 'hold' && j.entrySec === 0)).toBe(true)
  })

  it('plays a listener-approved hold at its exact off-grid times, before the zone end', () => {
    const approved: PackJump = { exitSec: 10.25, entrySec: 2.25, pCut: 0.95, pBlended: 0.95, source: 'listener', fadeSec: 0.035 }
    const runtime = new PackRuntime(pack([...holds, approved]))
    runtime.start('exploration')
    const steps = playUntil(runtime, 60)
    const joins = joinsOf(steps)
    expect(joins.length).toBeGreaterThan(2)
    expect(joins.every(j => j.source === 'listener' && j.exitSec === 10.25 && j.entrySec === 2.25)).toBe(true)
    const after = steps.findIndex(s => s.join)
    expect(steps[after]).toMatchObject({ startSec: 2.25, endSec: 2.5 })
    expect(steps.every(s => s.startSec < 10.25 + 1e-9)).toBe(true)
  })

  it('switches at the first good jump and blends it', () => {
    const runtime = new PackRuntime(pack([...holds, ...switches]))
    runtime.start('exploration')
    const join = joinsOf(playUntil(runtime, 30, i => { if (i === 10) runtime.request('combat') }))[0]!
    expect(join).toMatchObject({ kind: 'switch', exitSec: 8, entrySec: 20, fadeSec: 1, from: 'exploration', to: 'combat' })
    expect(join.waitedSec).toBeCloseTo(2.5)
  })

  it('notices a zone edge on a beat line whose time has many decimals', () => {
    const shift = 0.123456789
    const p = pack([...holds, ...switches].map(j => ({ ...j, exitSec: j.exitSec + shift, entrySec: j.entrySec + shift })))
    const runtime = new PackRuntime({ ...p, beatsSec: p.beatsSec.map(t => t + shift),
      zones: p.zones.map(z => ({ ...z, startSec: z.startSec + shift, endSec: z.endSec + shift })) })
    runtime.start('exploration', 13 + shift)
    runtime.request('combat')
    expect(joinsOf(playUntil(runtime, 10))[0]).toMatchObject({ kind: 'natural-switch', exitSec: 16 + shift })
  })

  it('lets the song make the change itself when it is about to', () => {
    const runtime = new PackRuntime(pack([...holds, ...switches]))
    runtime.start('exploration', 13)
    runtime.request('combat')
    expect(joinsOf(playUntil(runtime, 10))[0]).toMatchObject({ kind: 'natural-switch', exitSec: 16, fadeSec: 0 })
  })

  it('takes the least-bad jump after waiting too long', () => {
    const weak = switches.map(j => ({ ...j, pBlended: 0.5 }))
    const runtime = new PackRuntime(pack([...holds, ...weak]))
    runtime.start('exploration')
    runtime.request('combat')
    const join = joinsOf(playUntil(runtime, 30))[0]!
    expect(join.kind).toBe('fallback')
    expect(join.waitedSec).toBeGreaterThanOrEqual(DEFAULT_PACK_POLICY.switchGiveUpBeats * 0.5)
  })

  describe('combat stingers', () => {
    // Combat enters at 16 s; its one-bar build starts at 14 s (beat 28).
    const leadIns: PackJump[] = [2, 4, 6, 8, 10].map(exitSec => ({ kind: 'lead-in', exitSec, entrySec: 14, entranceSec: 16,
      pCut: 0.5, pBlended: 0.5, source: 'model', fadeSec: 0.5 }))
    const hitCuts: PackJump[] = Array.from({ length: 28 }, (_, i) => ({ kind: 'hit-cut', exitSec: (i + 1) * 0.5, entrySec: 16,
      entranceSec: 16, pCut: 0.5, pBlended: 0.5, source: 'model', fadeSec: 0.08 }))

    it('plays a lead-in through to the entrance without interrupting it', () => {
      const runtime = new PackRuntime(pack([...holds, ...leadIns, ...hitCuts]))
      runtime.start('exploration')
      runtime.request('combat')
      const joins = joinsOf(playUntil(runtime, 12))
      expect(joins[0]).toMatchObject({ kind: 'lead-in', exitSec: 2, entrySec: 14, fadeSec: 0.5 })
      expect(joins[1]).toMatchObject({ kind: 'natural-switch', exitSec: 16 })
      expect(joins).toHaveLength(2)
    })

    it('cuts straight to the entrance hit on an urgent request', () => {
      const runtime = new PackRuntime(pack([...holds, ...leadIns, ...hitCuts]))
      runtime.start('exploration')
      runtime.request('combat', true)
      expect(joinsOf(playUntil(runtime, 3))[0]).toMatchObject({ kind: 'hit-cut', exitSec: 0.5, entrySec: 16, fadeSec: 0.08 })
    })

    it('does not hit-cut a non-urgent request after waiting past hitCutAfterBeats', () => {
      const runtime = new PackRuntime(pack([...holds, ...hitCuts]))
      runtime.start('exploration')
      runtime.request('combat')
      const joins = joinsOf(playUntil(runtime, 10))
      expect(joins.filter(j => j.kind === 'hit-cut')).toHaveLength(0)
    })

    it('waits briefly for a good direct switch instead of taking a lead-in', () => {
      const runtime = new PackRuntime(pack([...holds, ...leadIns, ...hitCuts, model(2.5, 20, 0.4, 0.8)]))
      runtime.start('exploration')
      runtime.request('combat')
      expect(joinsOf(playUntil(runtime, 6))[0]).toMatchObject({ kind: 'switch', exitSec: 2.5, entrySec: 20 })
    })
  })

  it('applies the release delay before returning to exploration', () => {
    const p = { ...pack([...holds, ...switches]), policy: { ...DEFAULT_PACK_POLICY, releaseSec: 3 } }
    const sim = simulatePack(p, 60, [{ atSec: 5, feel: 'combat' }, { atSec: 20, feel: 'exploration' }])
    const back = sim.joins.find(j => j.to === 'exploration')!
    expect(back.atSec).toBeGreaterThanOrEqual(23)
    expect(sim.latencies.map(l => l.feel)).toEqual(['combat', 'exploration'])
  })
})

describe('offline render', () => {
  it('reproduces the source exactly when nothing jumps', () => {
    const source = Float32Array.from({ length: 800 }, (_, i) => Math.sin(i / 7))
    const segments = stepsToSegments([0, 0.5, 1, 1.5].map(t => ({ startSec: t, endSec: t + 0.5 })))
    expect(segments).toHaveLength(1)
    const [out] = renderSegments([source], 400, segments)
    expect(Array.from(out!)).toEqual(Array.from(source))
  })

  it('crossfades a jump with complementary equal-power gains', () => {
    const ones = new Float32Array(4000).fill(1)
    const segments = stepsToSegments([{ startSec: 2, endSec: 3 }, { startSec: 0, endSec: 1, join: { kind: 'hold', exitSec: 3,
      entrySec: 0, fadeSec: 1, p: 1, source: 'model', from: 'exploration', to: 'exploration' } }])
    const [out] = renderSegments([ones], 1000, segments)
    expect(out![1000]).toBeCloseTo(Math.SQRT2, 2)
    expect(out![1400]).toBeGreaterThan(1)
    expect(out![400]).toBe(1)
    expect(out![1600]).toBe(1)
  })
})
