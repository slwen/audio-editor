import { nextMusicExit, releaseDelay, type MusicSettings, type MusicSlot, type MusicState, type TransitionReview } from './model'

type Voice = { source: AudioBufferSourceNode; gain: GainNode; state: MusicState;
  slot: MusicSlot; startedAt: number; duration: number }
type Pending = { voice: Voice; when: number; fadeEnd: number; review: TransitionReview }
export type MusicPlayback = { current: MusicState | null; requested: MusicState | null;
  remaining: number; bar: number; progress: number; transition: TransitionReview | null }
export const STOPPED_MUSIC: MusicPlayback = {
  current: null, requested: null, remaining: 0, bar: 0, progress: 0, transition: null,
}

/** Audio nodes are scheduled on the audio clock. The timer only updates UI and releases silent nodes. */
export class AdaptivePlayer {
  private ctx: AudioContext
  private output: AudioNode
  private current: Voice | null = null
  private pending: Pending | null = null
  private retired: { voice: Voice; until: number }[] = []
  private latest: TransitionReview | null = null

  constructor(ctx: AudioContext, output: AudioNode) { this.ctx = ctx; this.output = output }

  private voice(state: MusicState, slot: MusicSlot, buffer: AudioBuffer, when: number, fade: number): Voice {
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.loop = true
    const gain = this.ctx.createGain()
    gain.gain.setValueAtTime(0, when)
    gain.gain.linearRampToValueAtTime(1, when + fade)
    source.connect(gain)
    gain.connect(this.output)
    source.start(when)
    return { source, gain, state, slot, startedAt: when, duration: buffer.duration }
  }

  start(state: MusicState, slot: MusicSlot, buffer: AudioBuffer): void {
    this.stop()
    this.current = this.voice(state, slot, buffer, this.ctx.currentTime + 0.08, 0.01)
  }

  request(state: MusicState, slot: MusicSlot, buffer: AudioBuffer, settings: MusicSettings): void {
    this.snapshot()
    const from = this.current
    if (!from) { this.start(state, slot, buffer); return }
    if (this.pending?.voice.state === state) return // Repeated gameplay updates must not postpone an exit.
    this.cancelPending()
    if (state === from.state) return
    const now = this.ctx.currentTime
    const when = nextMusicExit(now, from.startedAt, from.duration, from.slot.candidate.bars,
      settings.exitBars, now + releaseDelay(from.state, state, settings.releaseSec))
    const beatSec = from.duration / (from.slot.candidate.bars * 4)
    // Even a direct musical switch gets a 5ms anti-click ramp.
    const fade = Math.min(Math.max(0.005, settings.fadeBeats * beatSec), beatSec, buffer.duration / 4)
    const voice = this.voice(state, slot, buffer, when, fade)
    from.gain.gain.setValueAtTime(1, when)
    from.gain.gain.linearRampToValueAtTime(0, when + fade)
    this.pending = { voice, when, fadeEnd: when + fade, review: {
      id: crypto.randomUUID(), at: new Date().toISOString(), from: from.state, to: state,
      fromLoop: from.slot, toLoop: slot, settings: { ...settings },
      exitOffsetSec: ((when - from.startedAt) % from.duration + from.duration) % from.duration,
      fadeSec: fade, note: '',
    } }
  }

  private dispose(voice: Voice): void {
    try { voice.source.stop() } catch { /* already ended */ }
    voice.source.disconnect()
    voice.gain.disconnect()
  }

  private cancelPending(): void {
    if (!this.pending) return
    this.dispose(this.pending.voice)
    // Cancel only the future fade. Preserve any already-running arrival fade.
    this.current?.gain.gain.cancelScheduledValues(this.pending.when)
    this.pending = null
  }

  snapshot(): MusicPlayback {
    const now = this.ctx.currentTime
    if (this.pending && now >= this.pending.when) {
      if (this.current) this.retired.push({ voice: this.current, until: this.pending.fadeEnd })
      this.current = this.pending.voice
      this.latest = this.pending.review
      this.pending = null
    }
    this.retired = this.retired.filter(item => {
      if (now < item.until) return true
      this.dispose(item.voice)
      return false
    })
    const current = this.current
    const progress = current ? Math.max(0, now - current.startedAt) % current.duration / current.duration : 0
    return { current: current?.state ?? null, requested: this.pending?.voice.state ?? null,
      remaining: this.pending ? Math.max(0, this.pending.when - now) : 0,
      bar: current ? Math.floor(progress * current.slot.candidate.bars) + 1 : 0,
      progress, transition: this.latest }
  }

  stop(): void {
    this.cancelPending()
    if (this.current) this.dispose(this.current)
    this.retired.forEach(item => this.dispose(item.voice))
    this.current = null
    this.retired = []
    this.latest = null
  }
}
