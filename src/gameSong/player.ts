import { clampFade, fadeCurve, sourceTimeAt, type SongLoop } from './wrap'

/** Passes are scheduled this far ahead of when they start. */
const LOOKAHEAD_SEC = 3
const START_DELAY_SEC = 0.05

type Pass = { sources: AudioBufferSourceNode[]; gains: GainNode[]; endsAt: number }

/**
 * Plays the base and top stems the way the game does: from `fromSec`, wrapping from `loop.endSec` back to
 * `loop.startSec` with the crossfade centred on the wrap, for as long as it runs.
 */
export class GameSongPlayer {
  private passes: Pass[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private startCtx = 0
  private fromSec = 0
  private loop: SongLoop = { startSec: 0, endSec: 0, fadeSec: 0 }
  private readonly baseBus: GainNode
  private readonly topBus: GainNode
  private playing = false
  private duration = 0
  private readonly ctx: AudioContext

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx
    this.baseBus = ctx.createGain()
    this.topBus = ctx.createGain()
    this.baseBus.connect(destination)
    this.topBus.connect(destination)
  }

  get isPlaying(): boolean { return this.playing }

  /** Near-instant by default; pass `rampSec` for the game's linear guitar fade. */
  setTopGain(gain: number, rampSec = 0): void {
    const g = this.topBus.gain
    const now = this.ctx.currentTime
    g.cancelAndHoldAtTime(now)
    if (rampSec > 0) {
      g.setValueAtTime(g.value, now)
      g.linearRampToValueAtTime(gain, now + rampSec)
    } else {
      g.setTargetAtTime(gain, now, 0.05)
    }
  }

  /** Source position under the playhead. */
  position(): number {
    if (!this.playing) return this.fromSec
    const t = this.fromSec + Math.max(0, this.ctx.currentTime - this.startCtx)
    return Math.min(this.duration, this.fromSec >= this.loop.endSec ? t : sourceTimeAt(this.loop, t))
  }

  start(base: AudioBuffer, top: AudioBuffer, loop: SongLoop, fromSec: number, onEnded?: () => void): void {
    this.stop()
    this.duration = Math.min(base.duration, top.duration)
    this.loop = { ...loop, fadeSec: clampFade(loop, this.duration) }
    this.fromSec = Math.max(0, Math.min(fromSec, this.duration))
    this.startCtx = this.ctx.currentTime + START_DELAY_SEC
    this.playing = true
    const { startSec, endSec, fadeSec } = this.loop
    const half = fadeSec / 2
    const period = endSec - startSec
    if (this.fromSec >= endSec - half || period <= 0) {
      // Past the wrap: play out to the end, as the game does after the level ends.
      const pass = this.schedulePass(base, top, this.startCtx, this.fromSec, this.duration - this.fromSec, false, false)
      pass.sources[0]!.onended = () => { if (this.passes.includes(pass)) { this.stop(); onEnded?.() } }
      return
    }
    // Wrap k happens at this context time; pass 0 plays the song up to the first wrap.
    const wrapAt = (k: number) => this.startCtx + (endSec - this.fromSec) + k * period
    this.schedulePass(base, top, this.startCtx, this.fromSec, endSec + half - this.fromSec, false, true, wrapAt(0) - half)
    let next = 1
    const scheduleAhead = () => {
      while (wrapAt(next - 1) - half < this.ctx.currentTime + LOOKAHEAD_SEC) {
        const begin = wrapAt(next - 1) - half
        this.schedulePass(base, top, begin, startSec - half, period + fadeSec, true, true, wrapAt(next) - half)
        next++
      }
      this.passes = this.passes.filter(p => p.endsAt > this.ctx.currentTime - 1)
    }
    scheduleAhead()
    this.timer = setInterval(scheduleAhead, 500)
  }

  private schedulePass(base: AudioBuffer, top: AudioBuffer, when: number, offsetSec: number, lengthSec: number,
    fadeIn: boolean, fadeOut: boolean, fadeOutAt = 0): Pass {
    const fade = this.loop.fadeSec
    const pass: Pass = { sources: [], gains: [], endsAt: when + lengthSec }
    for (const [buffer, bus] of [[base, this.baseBus], [top, this.topBus]] as const) {
      const source = this.ctx.createBufferSource()
      source.buffer = buffer
      const gain = this.ctx.createGain()
      source.connect(gain).connect(bus)
      if (fade > 0 && fadeIn) {
        gain.gain.setValueAtTime(0, when)
        gain.gain.setValueCurveAtTime(fadeCurve(fade, true), when, fade)
      }
      if (fade > 0 && fadeOut) gain.gain.setValueCurveAtTime(fadeCurve(fade, false), Math.max(when + (fadeIn ? fade : 0), fadeOutAt), fade)
      source.start(when, Math.max(0, offsetSec), Math.max(0, lengthSec))
      pass.sources.push(source)
      pass.gains.push(gain)
    }
    this.passes.push(pass)
    return pass
  }

  stop(): void {
    if (this.playing) this.fromSec = this.position()
    this.playing = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const pass of this.passes) {
      for (const source of pass.sources) {
        source.onended = null
        try { source.stop() } catch { /* Already stopped. */ }
        source.disconnect()
      }
      for (const gain of pass.gains) gain.disconnect()
    }
    this.passes = []
  }
}
