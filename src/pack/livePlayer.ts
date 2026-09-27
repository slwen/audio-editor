import { feelAt, type Pack, type PackFeel } from './packFormat'
import { PackRuntime, type PackJoin } from './runtime'

/** A join the listener has heard; `atCtx` is the audio-clock time of the join. */
export type HeardJoin = PackJoin & { id: number; atCtx: number }

export type LiveSnapshot = {
  playing: boolean
  desired: PackFeel
  /** Feel of the audio now leaving the speakers. */
  audibleFeel: PackFeel | null
  sourceSec: number
  /** Seconds until a queued exploration request reaches the runtime (the release delay). */
  releaseLeftSec: number
  joins: HeardJoin[]
}

/** One source and its fade per layer. Layer level lives on the persistent bus, so joins never reset it. */
type Voice = { layers: { source: AudioBufferSourceNode; gain: GainNode }[] }

/** Feel-dependent mix: exploration sits slightly back with a light high roll-off; combat opens up; same-feel holds dip slightly. */
export type PackMix = {
  explorationDb: number
  explorationLowpassHz: number
  combatDb: number
  combatLowpassHz: number
  /** Into combat: fast, so a hit cut opens on the hit. */
  openSec: number
  /** Back to exploration: slow, so the drop is not noticed. */
  settleSec: number
  /** Level dip centred on a hold's join, which helps hide it. */
  holdDipDb: number
  holdDipSec: number
}

export const DEFAULT_PACK_MIX: PackMix = {
  // Sit behind ambience without the heavy "other room" muffling of the first pass.
  explorationDb: -7,
  explorationLowpassHz: 4000,
  combatDb: 2,
  combatLowpassHz: 18000,
  // Open the stage with the audio join, not as a sudden un-mute on a hard cut.
  openSec: 1.1,
  settleSec: 3.5,
  holdDipDb: -4,
  holdDipSec: 1.6,
}

export type PackLivePlayerOptions = {
  mix?: PackMix
  /** Audible feel changes, scheduled on the audio clock: other layers (ambience) can follow the music. */
  onFeel?: (feel: PackFeel, atCtx: number, rampSec: number) => void
  /** Initial bus gain for each buffer, in order. Missing entries stay at 1. */
  layerGains?: number[]
}

type MixNodes = { dip: GainNode; filter: BiquadFilterNode; stage: GainNode; mix: PackMix }

const dbToGain = (db: number) => Math.pow(10, db / 20)

/** Equal-power for blends of different material, linear for click repairs. */
function curve(fadeSec: number, rising: boolean): Float32Array {
  const n = 64
  return Float32Array.from({ length: n }, (_, i) => {
    const u = rising ? i / (n - 1) : 1 - i / (n - 1)
    return fadeSec >= 0.3 ? Math.sin(u * Math.PI / 2) : u
  })
}

/** First index whose beat is after `sec`. `inclusive` keeps a beat that lands exactly on `sec`. */
function beatIndex(beats: number[], sec: number, inclusive: boolean): number {
  let lo = 0
  let hi = beats.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (inclusive ? beats[mid]! < sec : beats[mid]! <= sec) lo = mid + 1
    else hi = mid
  }
  return lo
}

export class PackLivePlayer {
  private readonly ctx: AudioContext
  private readonly output: AudioNode
  private readonly buffers: AudioBuffer[]
  /** Level for each layer, created once so a join's crossfade cannot change it. */
  private readonly layerBuses: GainNode[]
  private readonly pack: Pack
  private readonly runtime: PackRuntime
  private voice: Voice | null = null
  private retired: { voice: Voice; until: number }[] = []
  /** Audio-clock time at which the current step ends and the next decision takes effect. */
  private boundary = 0
  /** Decided steps in audio-clock order, for mapping the clock back to the source. */
  private timeline: { atCtx: number; sourceSec: number }[] = []
  private heard: HeardJoin[] = []
  private scheduled: HeardJoin[] = []
  private release: { feel: PackFeel; at: number } | null = null
  private nextId = 1
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly mix: MixNodes | null
  private readonly onFeel: PackLivePlayerOptions['onFeel']

  constructor(ctx: AudioContext, output: AudioNode, buffer: AudioBuffer | AudioBuffer[], pack: Pack, options: PackLivePlayerOptions = {}) {
    const buffers = Array.isArray(buffer) ? buffer : [buffer]
    if (buffers.length === 0) throw new Error('PackLivePlayer requires at least one buffer')
    const frames = buffers[0]!.length
    for (let i = 1; i < buffers.length; i++) {
      if (buffers[i]!.length !== frames) {
        throw new Error(`PackLivePlayer layer buffers must all have the same length (layer 0 has ${frames} frames, layer ${i} has ${buffers[i]!.length})`)
      }
    }
    this.ctx = ctx
    this.buffers = buffers
    this.pack = pack
    this.runtime = new PackRuntime(pack)
    this.onFeel = options.onFeel
    if (options.mix) {
      const dip = ctx.createGain()
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.Q.value = 0.5
      const stage = ctx.createGain()
      dip.connect(filter)
      filter.connect(stage)
      stage.connect(output)
      this.mix = { dip, filter, stage, mix: options.mix }
      this.output = dip
    } else {
      this.mix = null
      this.output = output
    }
    this.layerBuses = buffers.map((_, i) => {
      const bus = ctx.createGain()
      bus.gain.value = options.layerGains?.[i] ?? 1
      bus.connect(this.output)
      return bus
    })
  }

  get layerCount(): number {
    return this.buffers.length
  }

  /** Ramp one layer bus. A later call replaces a ramp already in progress. An unknown layer does nothing. */
  setLayerGain(layer: number, gain: number, rampSec: number, atCtx?: number): void {
    const bus = this.layerBuses[layer]
    if (!bus) return
    const start = Math.max(this.ctx.currentTime, atCtx ?? this.ctx.currentTime)
    bus.gain.cancelAndHoldAtTime(start)
    if (rampSec <= 0) {
      bus.gain.setValueAtTime(gain, start)
      return
    }
    bus.gain.linearRampToValueAtTime(gain, start + rampSec)
  }

  /** Next beat line after the playing source position, on the audio clock. */
  nextBeatCtx(): number {
    const now = this.ctx.currentTime
    const beats = this.pack.beatsSec
    if (beats.length === 0) return now
    for (let i = 0; i < this.timeline.length; i++) {
      const seg = this.timeline[i]!
      const endCtx = this.timeline[i + 1]?.atCtx ?? this.boundary
      if (endCtx <= now) continue
      const fromCtx = Math.max(now, seg.atCtx)
      const sourceFrom = seg.sourceSec + (fromCtx - seg.atCtx)
      const sourceEnd = seg.sourceSec + (endCtx - seg.atCtx)
      // A future segment's opening beat is still ahead; the beat at the playing position is not.
      const beat = beats[beatIndex(beats, sourceFrom, fromCtx > now)]
      if (beat === undefined || beat > sourceEnd + 1e-4) continue
      return seg.atCtx + (beat - seg.sourceSec)
    }
    return now
  }

  private stageTo(feel: PackFeel | 'build', startAt: number, rampSec: number): void {
    if (!this.mix) return
    const { filter, stage, mix } = this.mix
    const db = feel === 'combat' ? mix.combatDb : feel === 'exploration' ? mix.explorationDb : (mix.combatDb + mix.explorationDb) / 2
    const hz = feel === 'combat' ? mix.combatLowpassHz : feel === 'exploration' ? mix.explorationLowpassHz
      : Math.sqrt(mix.combatLowpassHz * mix.explorationLowpassHz)
    const start = Math.max(this.ctx.currentTime, startAt)
    stage.gain.cancelAndHoldAtTime(start)
    filter.frequency.cancelAndHoldAtTime(start)
    if (rampSec <= 0) {
      stage.gain.setValueAtTime(dbToGain(db), start)
      filter.frequency.setValueAtTime(hz, start)
      return
    }
    stage.gain.linearRampToValueAtTime(dbToGain(db), start + rampSec)
    filter.frequency.exponentialRampToValueAtTime(hz, start + rampSec)
  }

  /** Mix automation for one join, at the audio-clock time its new audio arrives. */
  private scheduleMix(join: PackJoin, at: number): void {
    const arrive = at - join.fadeSec / 2
    if (join.kind === 'lead-in' && join.entranceSec !== undefined) {
      // The song's own build swells the mix halfway; the entrance itself opens it fully.
      this.stageTo('build', arrive, Math.max(0.1, join.entranceSec - join.entrySec))
      return
    }
    if (join.from === join.to) {
      if (this.mix && (join.kind === 'hold' || join.kind === 'fallback') && this.mix.mix.holdDipDb < 0) {
        const { dip, mix } = this.mix
        const half = mix.holdDipSec / 2
        const from = Math.max(this.ctx.currentTime, at - half)
        dip.gain.cancelAndHoldAtTime(from)
        dip.gain.linearRampToValueAtTime(dbToGain(mix.holdDipDb), at)
        dip.gain.linearRampToValueAtTime(1, at + half)
      }
      return
    }
    const mix = this.mix?.mix
    const rampSec = join.to === 'combat' ? Math.max(mix?.openSec ?? 1.1, join.fadeSec) : Math.max(mix?.settleSec ?? 3.5, join.fadeSec)
    this.stageTo(join.to, arrive, rampSec)
    this.onFeel?.(join.to, Math.max(this.ctx.currentTime, arrive), rampSec)
  }

  private startVoice(when: number, offsetSec: number, fadeSec: number): Voice {
    const up = fadeSec > 0 ? curve(fadeSec, true) : null
    const offset = Math.max(0, offsetSec)
    return {
      layers: this.buffers.map((buffer, i) => {
        const source = this.ctx.createBufferSource()
        source.buffer = buffer
        const gain = this.ctx.createGain()
        if (up) gain.gain.setValueCurveAtTime(up, when, fadeSec)
        source.connect(gain)
        gain.connect(this.layerBuses[i]!)
        source.start(when, offset)
        return { source, gain }
      }),
    }
  }

  /** `startSec` defaults to the first zone of `feel`; pass a zone start to begin elsewhere in the song. */
  start(feel: PackFeel, startSec?: number, opts?: { playThrough?: boolean }): void {
    this.stop()
    const first = this.runtime.start(feel, startSec)
    if (opts?.playThrough) this.runtime.playThrough()
    const when = this.ctx.currentTime + 0.1
    this.stageTo(feel, when, 0)
    this.onFeel?.(feel, when, 0)
    this.voice = this.startVoice(when, first.startSec, 0)
    this.timeline = [{ atCtx: when, sourceSec: first.startSec }]
    this.boundary = when + first.endSec - first.startSec
    this.timer = setInterval(() => this.tick(), 25)
    this.tick()
  }

  /** Game-side request. Returning to exploration waits for the policy's release delay; urgent combat hit-cuts at the next beat. */
  request(feel: PackFeel, urgent = false): void {
    if (feel === 'exploration' && this.runtime.desired === 'combat' && this.pack.policy.releaseSec > 0) {
      this.release = { feel, at: this.ctx.currentTime + this.pack.policy.releaseSec }
      return
    }
    this.release = null
    this.runtime.request(feel, urgent)
  }

  /** Keep playing the song forward: no holds, no feel jumps. Cancels a pending exploration release. */
  playThrough(): void {
    this.release = null
    this.runtime.playThrough()
  }

  /** Stop now, or fade every voice out over `fadeSec` first. */
  stop(fadeSec = 0): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const now = this.ctx.currentTime
    for (const v of [this.voice, ...this.retired.map(r => r.voice)]) {
      if (!v) continue
      for (const layer of v.layers) {
        if (fadeSec > 0) {
          const g = layer.gain.gain
          g.cancelAndHoldAtTime(now)
          g.linearRampToValueAtTime(0, now + fadeSec)
          try { layer.source.stop(now + fadeSec + 0.02) } catch { /* Already stopped. */ }
          layer.source.onended = () => layer.gain.disconnect()
          continue
        }
        try { layer.source.stop() } catch { /* Already stopped. */ }
        layer.gain.disconnect()
      }
    }
    this.voice = null
    this.retired = []
    this.scheduled = []
    this.release = null
  }

  private tick(): void {
    const now = this.ctx.currentTime
    if (this.release && now >= this.release.at) {
      this.runtime.request(this.release.feel)
      this.release = null
    }
    // Decide each boundary early enough to start a blend centred on it; listener blends can be longer.
    const lead = Math.max(this.pack.policy.blendSec, ...this.pack.jumps.map(j => j.fadeSec ?? 0)) / 2 + 0.15
    while (this.voice && this.boundary - lead <= now) {
      const step = this.runtime.advance()
      const at = this.boundary
      if (step.join && step.join.kind !== 'natural-switch') {
        const fade = step.join.fadeSec
        const old = this.voice
        const fadeFrom = Math.max(now, at - fade / 2)
        const fadeTo = at + fade / 2
        const down = curve(fade, false)
        // A quick second change can land inside this voice's own arrival fade; curves may not overlap.
        for (const layer of old.layers) {
          const g = layer.gain.gain
          g.cancelAndHoldAtTime(fadeFrom)
          try { g.setValueCurveAtTime(down, fadeFrom, fadeTo - fadeFrom) }
          catch { g.linearRampToValueAtTime(0, fadeTo) }
          layer.source.stop(fadeTo + 0.05)
        }
        this.retired.push({ voice: old, until: fadeTo + 0.1 })
        this.voice = this.startVoice(at - fade / 2, step.startSec - fade / 2, fade)
      }
      if (step.join) {
        this.scheduled.push({ ...step.join, id: this.nextId++, atCtx: at })
        this.scheduleMix(step.join, at)
      }
      this.timeline.push({ atCtx: at, sourceSec: step.startSec })
      this.boundary += step.endSec - step.startSec
    }
    for (const join of this.scheduled.filter(j => j.atCtx + j.fadeSec / 2 <= now)) this.heard.unshift(join)
    this.scheduled = this.scheduled.filter(j => j.atCtx + j.fadeSec / 2 > now)
    this.heard = this.heard.slice(0, 30)
    for (const r of this.retired.filter(r => r.until <= now)) {
      for (const layer of r.voice.layers) layer.gain.disconnect()
    }
    this.retired = this.retired.filter(r => r.until > now)
    while (this.timeline.length > 2 && this.timeline[1]!.atCtx <= now) this.timeline.shift()
  }

  snapshot(): LiveSnapshot {
    const now = this.ctx.currentTime
    const current = [...this.timeline].reverse().find(t => t.atCtx <= now) ?? this.timeline[0]
    const sourceSec = (current?.sourceSec ?? 0) + Math.max(0, now - (current?.atCtx ?? now))
    return {
      playing: !!this.voice,
      desired: this.release?.feel ?? this.runtime.desired,
      audibleFeel: feelAt(this.pack.zones, sourceSec),
      sourceSec,
      releaseLeftSec: this.release ? Math.max(0, this.release.at - now) : 0,
      joins: this.heard,
    }
  }
}
